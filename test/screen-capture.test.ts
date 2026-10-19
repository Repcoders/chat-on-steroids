import { beforeEach, expect, it, vi } from 'vitest';

/**
 * "Capture part of the screen" (composer + menu): the window steps aside, each display shows a
 * still copy of itself, and the rectangle dragged on one of them comes back as image bytes for
 * the attachment staging. These run the main-process half against a stand-in Electron.
 */
type Rect = { x: number; y: number; width: number; height: number };
const state = vi.hoisted(() => ({
  displays: [] as Array<{ id: number; bounds: Rect; scaleFactor: number }>,
  sources: [] as Array<{ display_id: string; thumbnail: unknown }>,
  cursor: { x: 0, y: 0 },
  windows: [] as Array<{ options: Record<string, any>; bounds: Rect | null; loaded: string | null; scripts: string[];
    shown: boolean; focused: boolean; destroyed: boolean; pick: (selection: Rect | null) => void; closed: Array<() => void>; close: () => void }>,
  owner: { hidden: 0, shown: 0, focused: 0, visible: true }
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    record: (typeof state.windows)[number];
    webContents: Record<string, unknown>;
    constructor(options: Record<string, any>) {
      let pick: (selection: Rect | null) => void = () => undefined;
      const picked = new Promise<Rect | null>(resolve => { pick = resolve; });
      const record = { options, bounds: null, loaded: null, scripts: [], shown: false, focused: false, destroyed: false, pick, closed: [], close: () => this.destroy() } as (typeof state.windows)[number];
      this.record = record;
      state.windows.push(record);
      this.webContents = {
        executeJavaScript: async (code: string) => { record.scripts.push(code); return code === 'window.cosShotPick' ? picked : undefined; },
        setWindowOpenHandler: () => undefined,
        on: () => undefined
      };
    }
    loadFile(file: string) { this.record.loaded = file; return Promise.resolve(); }
    loadURL(url: string) { this.record.loaded = url; return Promise.resolve(); }
    setAlwaysOnTop() { /* stand-in */ }
    setVisibleOnAllWorkspaces() { /* stand-in */ }
    setBounds(bounds: Rect) { this.record.bounds = bounds; }
    once(event: string, handler: () => void) { if (event === 'closed') this.record.closed.push(handler); }
    show() { this.record.shown = true; }
    moveTop() { /* stand-in */ }
    focus() { this.record.focused = true; }
    isDestroyed() { return this.record.destroyed; }
    destroy() { this.record.destroyed = true; for (const handler of this.record.closed) handler(); }
  },
  desktopCapturer: { getSources: vi.fn(async () => state.sources) },
  screen: {
    getAllDisplays: () => state.displays,
    getCursorScreenPoint: () => state.cursor,
    getDisplayNearestPoint: (point: { x: number }) => state.displays.find(display => point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width) ?? state.displays[0]
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' }
}));
vi.mock('../src/main/main-texts.js', () => ({ mainText: (text: string) => `[${text}]` }));

const electron = await import('electron');
const { captureScreenRegion, pairScreenSources, selectionToImageRect } = await import('../src/main/screen-capture.js');

/** A captured display picture that records the crop it was asked for. */
const picture = (width: number, height: number, label: string) => {
  const crops: Rect[] = [];
  return {
    crops,
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    toJPEG: () => Buffer.from(`jpeg ${label}`),
    crop: (rect: Rect) => { crops.push(rect); return { toPNG: () => Buffer.from(`png ${label} ${rect.x},${rect.y},${rect.width},${rect.height}`), toJPEG: () => Buffer.from('jpeg crop') }; }
  };
};
const owner = () => ({
  isDestroyed: () => false, isVisible: () => state.owner.visible, isMinimized: () => false,
  hide: () => { state.owner.hidden++; state.owner.visible = false; },
  show: () => { state.owner.shown++; state.owner.visible = true; },
  focus: () => { state.owner.focused++; }
}) as unknown as import('electron').BrowserWindow;
/** Waits until every overlay asked for its selection, i.e. it is on screen and listening. */
const overlaysOpen = async (count: number) => {
  await vi.waitFor(() => expect(state.windows.filter(win => win.scripts.includes('window.cosShotPick'))).toHaveLength(count));
};

beforeEach(() => {
  state.windows.length = 0;
  state.owner = { hidden: 0, shown: 0, focused: 0, visible: true };
  state.cursor = { x: 10, y: 10 };
  vi.useRealTimers();
});

it('crops exactly what was dragged on a 150% display and stages it as a PNG', async () => {
  const shot = picture(1920, 1080, 'main');
  state.displays = [{ id: 7, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }];
  state.sources = [{ display_id: '7', thumbnail: shot }];
  const result = captureScreenRegion(owner());
  await overlaysOpen(1);
  // The app window left the screen before the capture, so it is not in the picture.
  expect(state.owner.hidden).toBe(1);
  expect(vi.mocked(electron.desktopCapturer.getSources)).toHaveBeenLastCalledWith({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  const [overlay] = state.windows;
  expect(overlay!.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  expect(overlay!.options.webPreferences.preload).toBeUndefined();
  expect(overlay!.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  expect(overlay!.loaded).toMatch(/renderer[\\/]screen-capture\.html$/);
  expect(overlay!.scripts[0]).toBe(`window.cosShot(${JSON.stringify(`data:image/jpeg;base64,${Buffer.from('jpeg main').toString('base64')}`)})`);
  expect(overlay!.shown && overlay!.focused).toBe(true);
  overlay!.pick({ x: 100, y: 50, width: 200, height: 100 });
  const staged = await result;
  expect(shot.crops).toEqual([{ x: 150, y: 75, width: 300, height: 150 }]);
  expect(staged!.name).toMatch(/^screenshot-\d{8}-\d{6}\.png$/);
  expect(Buffer.from(staged!.bytes).toString()).toBe('png main 150,75,300,150');
  expect(overlay!.destroyed).toBe(true);
  expect(state.owner).toMatchObject({ shown: 1, focused: 1, visible: true });
});

it('takes the crop from the display it was dragged on, and gives the keyboard to the one under the pointer', async () => {
  const left = picture(2560, 1440, 'left'), right = picture(1920, 1080, 'right');
  state.displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  ];
  // Sources do not have to come in display order.
  state.sources = [{ display_id: '2', thumbnail: right }, { display_id: '1', thumbnail: left }];
  state.cursor = { x: 3000, y: 200 };
  const result = captureScreenRegion(owner());
  await overlaysOpen(2);
  expect(state.windows.map(win => win.bounds?.x)).toEqual([0, 2560]);
  expect(state.windows.map(win => win.focused)).toEqual([false, true]);
  state.windows[1]!.pick({ x: 10, y: 20, width: 30, height: 40 });
  expect(Buffer.from((await result)!.bytes).toString()).toBe('png right 10,20,30,40');
  expect(left.crops).toEqual([]);
  expect(state.windows.every(win => win.destroyed)).toBe(true);
});

it('adds nothing when the person cancels or closes an overlay, and brings the window back', async () => {
  const shot = picture(800, 600, 'main');
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }];
  state.sources = [{ display_id: '1', thumbnail: shot }];
  const cancelled = captureScreenRegion(owner());
  await overlaysOpen(1);
  // A second click while one capture is open does not open another.
  expect(await captureScreenRegion(owner())).toBeNull();
  state.windows[0]!.pick(null);
  expect(await cancelled).toBeNull();
  state.windows.length = 0;
  const closed = captureScreenRegion(owner());
  await overlaysOpen(1);
  state.windows[0]!.close();
  expect(await closed).toBeNull();
  expect(shot.crops).toEqual([]);
  expect(state.owner).toMatchObject({ hidden: 2, shown: 2, visible: true });
});

it('keeps a huge busy crop under the staging bound: lower JPEG quality first, then half the size', async () => {
  const MiB = 1024 * 1024;
  const qualities: number[] = [];
  const resized: number[] = [];
  const image = (width: number): any => ({
    getSize: () => ({ width, height: width / 2 }),
    toPNG: () => Buffer.alloc(20 * MiB),
    toJPEG: (quality: number) => { qualities.push(quality); return Buffer.alloc(width > 4000 ? 13 * MiB : 11 * MiB, 1); },
    resize: ({ width: next }: { width: number }) => { resized.push(next); return image(next); }
  });
  const shot = { isEmpty: () => false, getSize: () => ({ width: 7680, height: 4320 }), toJPEG: () => Buffer.from('jpeg'), crop: () => image(7680) };
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 2 }];
  state.sources = [{ display_id: '1', thumbnail: shot }];
  const result = captureScreenRegion(owner());
  await overlaysOpen(1);
  state.windows[0]!.pick({ x: 0, y: 0, width: 3840, height: 2160 });
  const staged = (await result)!;
  expect(qualities).toEqual([92, 80, 65, 92]);
  expect(resized).toEqual([3840]);
  expect(staged.name).toMatch(/^screenshot-\d{8}-\d{6}\.jpg$/);
  expect(staged.bytes.byteLength).toBe(11 * MiB);
});

/** Runs `body` as if on another platform, whatever this machine is. */
const onPlatform = async (platform: NodeJS.Platform, body: () => Promise<void>) => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  try { await body(); } finally { Object.defineProperty(process, 'platform', real); }
};

it('says the screen could not be captured when no display gave a picture', async () => {
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }];
  state.sources = [{ display_id: '1', thumbnail: picture(0, 0, 'empty') }];
  await onPlatform('win32', async () => {
    await expect(captureScreenRegion(owner())).rejects.toThrow('The screen could not be captured');
  });
  expect(state.windows).toHaveLength(0);
  expect(state.owner).toMatchObject({ hidden: 1, shown: 1, visible: true });
});

it('asks for Screen Recording on macOS, before hiding the window when it is denied', async () => {
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }];
  state.sources = [{ display_id: '1', thumbnail: picture(0, 0, 'empty') }];
  const status = vi.spyOn(electron.systemPreferences, 'getMediaAccessStatus');
  await onPlatform('darwin', async () => {
    status.mockReturnValueOnce('denied');
    await expect(captureScreenRegion(owner())).rejects.toThrow('Allow Screen Recording for Chat On Steroids in System Settings, then try again');
    expect(state.owner.hidden).toBe(0);
    // Not asked yet: macOS answers the capture with empty pictures instead of an error.
    status.mockReturnValueOnce('not-determined');
    await expect(captureScreenRegion(owner())).rejects.toThrow('Allow Screen Recording for Chat On Steroids in System Settings, then try again');
  });
  status.mockRestore();
  expect(state.windows).toHaveLength(0);
  expect(state.owner).toMatchObject({ hidden: 1, shown: 1, visible: true });
});

it('covers the display a PipeWire portal capture shows when two displays get one unnamed source', async () => {
  const shot = picture(1080, 1920, 'portrait');
  state.displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1080, height: 1920 }, scaleFactor: 1 }
  ];
  state.sources = [{ display_id: '', thumbnail: shot }];
  const result = captureScreenRegion(owner());
  await overlaysOpen(1);
  expect(state.windows[0]!.bounds).toEqual({ x: 1920, y: 0, width: 1080, height: 1920 });
  state.windows[0]!.pick({ x: 5, y: 6, width: 70, height: 80 });
  expect(Buffer.from((await result)!.bytes).toString()).toBe('png portrait 5,6,70,80');
});

it('maps a selection into the captured picture, clamped to its edges', () => {
  expect(selectionToImageRect({ x: 1270, y: 700, width: 50, height: 50 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }))
    .toEqual({ x: 1905, y: 1050, width: 15, height: 30 });
  expect(selectionToImageRect({ x: -20, y: -20, width: 40, height: 40 }, { width: 100, height: 100 }, { width: 100, height: 100 }))
    .toEqual({ x: 0, y: 0, width: 20, height: 20 });
  expect(selectionToImageRect({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 })).toBeNull();
});

it('pairs sources without display ids in display order, as Linux reports them', () => {
  const source = (display_id: string, width = 1920, height = 1080) => ({ display_id, thumbnail: { getSize: () => ({ width, height }) } });
  const displays = [{ id: 5, bounds: { width: 1920, height: 1080 } }, { id: 6, bounds: { width: 1280, height: 1024 } }];
  const a = source(''), b = source('');
  expect(pairScreenSources(displays, [a, b])).toEqual([a, b]);
  const square = source('', 1280, 1024);
  expect(pairScreenSources(displays, [square])).toEqual([undefined, square]);
  // Two displays of the same shape: the picture is offered on both.
  const twins = [{ id: 7, bounds: { width: 1920, height: 1080 } }, { id: 8, bounds: { width: 2560, height: 1440 } }];
  expect(pairScreenSources(twins, [a])).toEqual([a, a]);
  const named = source('6');
  expect(pairScreenSources(displays, [named])).toEqual([undefined, named]);
  expect(pairScreenSources(displays, [])).toEqual([undefined, undefined]);
});
