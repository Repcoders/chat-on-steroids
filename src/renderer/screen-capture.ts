/**
 * The "Capture part of the screen" overlay's page. The main process hands it the display's picture
 * through `cosShot` and reads the dragged rectangle, in page coordinates, from `cosShotPick`; Esc
 * or a right click answers null. It has no preload and asks for nothing.
 */
type Area = { x: number; y: number; width: number; height: number };

const query = new URLSearchParams(location.search);
const shot = document.getElementById('shot') as HTMLImageElement;
const box = document.getElementById('selection') as HTMLDivElement;
document.getElementById('hint')!.textContent = (query.get('hint') ?? '').slice(0, 200);

let answer: (selection: Area | null) => void = () => undefined;
const pick = new Promise<Area | null>(resolve => { answer = resolve; });
let start: { x: number; y: number } | null = null;
let done = false;

const rectFrom = (x: number, y: number): Area => {
  const from = start!;
  return { x: Math.min(from.x, x), y: Math.min(from.y, y), width: Math.abs(x - from.x), height: Math.abs(y - from.y) };
};
const finish = (selection: Area | null): void => { if (done) return; done = true; answer(selection); };
const paint = (rect: Area | null): void => {
  document.body.classList.toggle('selecting', !!rect);
  box.hidden = !rect;
  if (!rect) return;
  Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
};

addEventListener('pointerdown', event => {
  if (event.button === 2) { finish(null); return; }
  if (event.button !== 0 || done) return;
  start = { x: event.clientX, y: event.clientY };
  document.body.setPointerCapture(event.pointerId);
  paint(rectFrom(event.clientX, event.clientY));
});
addEventListener('pointermove', event => { if (start && !done) paint(rectFrom(event.clientX, event.clientY)); });
addEventListener('pointerup', event => {
  if (!start || event.button !== 0 || done) return;
  const rect = rectFrom(event.clientX, event.clientY);
  start = null;
  // A click without a drag is not a selection; the person can try again.
  if (rect.width < 4 || rect.height < 4) { paint(null); return; }
  finish(rect);
});
addEventListener('contextmenu', event => event.preventDefault());
addEventListener('keydown', event => { if (event.key === 'Escape') finish(null); });

Object.assign(window, {
  cosShotPick: pick,
  cosShot: (url: string): Promise<void> => new Promise(resolve => {
    shot.onload = shot.onerror = () => resolve();
    shot.src = url;
  })
});

export {};
