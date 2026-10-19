/**
 * "Capture part of the screen" in the composer's + menu. The app window steps aside, every
 * display is captured once, and a still copy of it covers each display. The person drags a
 * rectangle on one of them; that crop is returned as PNG bytes for the existing attachment
 * staging, so it reaches the draft like a pasted image. Esc, a right click or closing an overlay
 * cancels, and nothing is ever sent from here.
 *
 * The overlays have no preload and no Node. The page gets its picture and returns the selection
 * only through `executeJavaScript`, like the "Installing" window.
 */
import path from 'node:path';
import { BrowserWindow, desktopCapturer, screen, systemPreferences, type Display, type NativeImage, type Rectangle } from 'electron';
import { mainText } from './main-texts.js';

/** Bytes the attachment staging takes in one IPC copy (sessions:dropFiles has the same bound). */
const MAX_SHOT_BYTES = 12 * 1024 * 1024;
/** Time for the window to leave the screen before the capture, so it is not in the picture. */
const STEP_ASIDE_MS = 250;

let active = false;

/**
 * A selection made in a display's own coordinates, as pixels of that display's captured image.
 * The ratio comes from the two sizes, so a scaled display (150%) or a picture captured at another
 * size still crops what was selected. Null when nothing usable is left inside the image.
 */
export function selectionToImageRect(selection: Rectangle, display: { width: number; height: number }, image: { width: number; height: number }): Rectangle | null {
  if (display.width <= 0 || display.height <= 0 || image.width <= 0 || image.height <= 0) return null;
  const sx = image.width / display.width, sy = image.height / display.height;
  const left = Math.max(0, Math.floor(selection.x * sx)), top = Math.max(0, Math.floor(selection.y * sy));
  const right = Math.min(image.width, Math.ceil((selection.x + selection.width) * sx));
  const bottom = Math.min(image.height, Math.ceil((selection.y + selection.height) * sy));
  if (right - left < 2 || bottom - top < 2) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type Size = { width: number; height: number };

/**
 * Each display's screen source. Windows and macOS name the display in `display_id`; Linux may
 * leave it empty, and then the sources are taken in display order when the counts match. The
 * PipeWire portal returns the one screen the person picked there: it goes to the display whose
 * shape matches its picture, so the overlay covers the screen it shows.
 */
export function pairScreenSources<S extends { display_id: string; thumbnail: { getSize(): Size } }>(
  displays: ReadonlyArray<{ id: number; bounds: Size }>, sources: readonly S[]): Array<S | undefined> {
  const byId = displays.map(display => sources.find(source => source.display_id === String(display.id)));
  if (byId.every(Boolean)) return byId;
  if (!sources.length || sources.some(source => source.display_id)) return byId;
  if (sources.length === displays.length) return [...sources];
  if (sources.length !== 1) return byId;
  const ratio = (size: Size) => size.width / Math.max(1, size.height);
  const shown = ratio(sources[0]!.thumbnail.getSize());
  const distance = displays.map(display => Math.abs(ratio(display.bounds) - shown));
  const best = Math.min(...distance);
  // Displays of the same shape cannot be told apart; each shows the picture, and any of them works.
  return displays.map((_display, index) => distance[index]! - best < 0.01 ? sources[0] : undefined);
}

/** The overlay's answer, checked: a rectangle in its own page coordinates, or nothing. */
function readSelection(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every(entry => typeof entry === 'number' && Number.isFinite(entry))) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

const shotName = (at = new Date()): string => {
  const two = (value: number) => String(value).padStart(2, '0');
  return `screenshot-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
};

function openOverlay(display: Display, picture: NativeImage, focus: boolean): { win: BrowserWindow; pick: Promise<Rectangle | null> } {
  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, show: false, enableLargerThanScreen: true, backgroundColor: '#000000',
    title: 'Chat On Steroids',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, zoomFactor: 1 }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* unsupported */ }
  // A window made on one display can be scaled by another's factor; place it again once it exists.
  win.setBounds(bounds);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const pick = (async (): Promise<Rectangle | null> => {
    const query = { hint: mainText('Drag over the part of the screen to add. Esc cancels.') };
    if (process.env.ELECTRON_RENDERER_URL) {
      const base = process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`;
      const url = new URL('screen-capture.html', base);
      url.searchParams.set('hint', query.hint);
      await win.loadURL(url.toString());
    } else await win.loadFile(path.join(__dirname, '../renderer/screen-capture.html'), { query });
    // JPEG keeps the page's copy small; the crop is taken from the full capture.
    const shown = `data:image/jpeg;base64,${picture.toJPEG(90).toString('base64')}`;
    await win.webContents.executeJavaScript(`window.cosShot(${JSON.stringify(shown)})`);
    if (win.isDestroyed()) return null;
    win.show(); win.moveTop();
    if (focus) win.focus();
    return readSelection(await win.webContents.executeJavaScript('window.cosShotPick'));
  })().catch(() => null);
  return { win, pick };
}

/**
 * Lets the person select part of any display and returns it as PNG (or JPEG when a PNG would be
 * over the staging bound), or null when they cancel. One capture at a time.
 */
export async function captureScreenRegion(owner: BrowserWindow | null): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (active) return null;
  if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
    throw new Error('Allow Screen Recording for Chat On Steroids in System Settings, then try again');
  }
  active = true;
  const stepAside = !!owner && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized();
  const overlays: BrowserWindow[] = [];
  try {
    if (stepAside) { owner.hide(); await new Promise(resolve => setTimeout(resolve, STEP_ASIDE_MS)); }
    const displays = screen.getAllDisplays();
    const size = displays.reduce((most, display) => ({
      width: Math.max(most.width, Math.round(display.bounds.width * display.scaleFactor)),
      height: Math.max(most.height, Math.round(display.bounds.height * display.scaleFactor))
    }), { width: 1, height: 1 });
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const paired = pairScreenSources(displays, sources);
    const shots = displays.flatMap((display, index) => {
      const picture = paired[index]?.thumbnail;
      return picture && !picture.isEmpty() ? [{ display, picture }] : [];
    });
    // macOS hands out empty pictures, not an error, while Screen Recording is not allowed.
    if (!shots.length && process.platform === 'darwin') throw new Error('Allow Screen Recording for Chat On Steroids in System Settings, then try again');
    if (!shots.length) throw new Error('The screen could not be captured');
    // The display under the pointer takes the keyboard, so Esc works without a click first.
    const pointer = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    const keyboard = shots.some(shot => shot.display.id === pointer) ? pointer : shots[0]!.display.id;
    const opened = shots.map(({ display, picture }) => ({ display, picture, ...openOverlay(display, picture, display.id === keyboard) }));
    for (const entry of opened) overlays.push(entry.win);
    const closed = opened.map(entry => new Promise<null>(resolve => entry.win.once('closed', () => resolve(null))));
    const answer = await Promise.race([
      ...opened.map(entry => entry.pick.then(selection => ({ entry, selection }))),
      ...closed.map(done => done.then(() => null))
    ]);
    if (!answer?.selection) return null;
    const { display, picture } = answer.entry;
    const rect = selectionToImageRect(answer.selection, display.bounds, picture.getSize());
    if (!rect) return null;
    const crop = picture.crop(rect);
    const png = crop.toPNG();
    const name = shotName();
    if (png.byteLength <= MAX_SHOT_BYTES) return { name: `${name}.png`, bytes: new Uint8Array(png) };
    // A huge, busy crop: lower the JPEG quality, then halve the size, until it fits the bound.
    let image = crop;
    for (let halvings = 0; halvings < 8; halvings++) {
      for (const quality of [92, 80, 65]) {
        const jpeg = image.toJPEG(quality);
        if (jpeg.byteLength <= MAX_SHOT_BYTES) return { name: `${name}.jpg`, bytes: new Uint8Array(jpeg) };
      }
      image = image.resize({ width: Math.max(1, Math.round(image.getSize().width / 2)) });
    }
    throw new Error('The screen could not be captured');
  } finally {
    for (const win of overlays) if (!win.isDestroyed()) win.destroy();
    if (stepAside && owner && !owner.isDestroyed()) { owner.show(); owner.focus(); }
    active = false;
  }
}
