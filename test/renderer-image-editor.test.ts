import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * A staged image can be redacted or marked up before Send. What leaves the editor is one flattened
 * copy: Redact is an opaque whole-pixel fill burned into the canvas, never a blur or a layer.
 */
let dom: JSDOM;
let calls: Array<[string, ...unknown[]]>;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  calls = [];
  w.HTMLCanvasElement.prototype.getContext = (() => recorder()) as any;
  w.HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback, type?: string) { done(new Blob(['edited'], { type: type ?? 'image/png' })); };
  // Shown at half size: a drag in the window is twice as long in image pixels.
  w.HTMLCanvasElement.prototype.getBoundingClientRect = function () { return { left: 10, top: 20, width: this.width / 2, height: this.height / 2 } as DOMRect; };
});
afterEach(() => dom.window.close());

function recorder(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get: (_target, key: string) => key in state ? state[key] : (...args: unknown[]) => { calls.push([key, ...args]); },
    set: (_target, key: string, value) => { state[key] = value; calls.push([`${key}=`, value]); return true; }
  }) as unknown as CanvasRenderingContext2D;
}
function drag(canvas: HTMLCanvasElement, from: [number, number], to: [number, number]): void {
  const fire = (type: string, [clientX, clientY]: [number, number]) =>
    canvas.dispatchEvent(new dom.window.MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
  fire('pointerdown', from); fire('pointermove', to); fire('pointerup', to);
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.image-editor-dialog button')];
const named = (label: string) => buttons().find(node => node.textContent === label)!;

it('turns a drag into a clamped whole-pixel rectangle and ignores a click', async () => {
  const { editBetween } = await import('../src/renderer/image-editor.js');
  expect(editBetween('redact', { x: 40.6, y: 30.2 }, { x: 10.4, y: 5.9 }, 100, 80)).toEqual({ tool: 'redact', x: 10, y: 5, width: 31, height: 26 });
  expect(editBetween('box', { x: -20, y: 70 }, { x: 140, y: 120 }, 100, 80)).toEqual({ tool: 'box', x: 0, y: 70, width: 100, height: 10 });
  expect(editBetween('redact', { x: 12, y: 12 }, { x: 13, y: 40 }, 100, 80)).toBeNull();
});

it('burns an opaque redact fill over the image and returns the flattened copy on Save', async () => {
  const { openImageEditor, REDACT_FILL } = await import('../src/renderer/image-editor.js');
  const image = { tag: 'picture' } as unknown as CanvasImageSource;
  const result = openImageEditor({ image, width: 400, height: 200, name: 'screen.png' });
  const canvas = document.querySelector<HTMLCanvasElement>('.image-editor-canvas')!;
  expect([canvas.width, canvas.height]).toEqual([400, 200]);
  expect(named('Save').disabled).toBe(true);
  expect(named('Redact').getAttribute('aria-pressed')).toBe('true');
  drag(canvas, [20, 30], [60, 50]);
  expect(named('Save').disabled).toBe(false);
  calls = [];
  named('Save').click();
  const blob = await result;
  expect(blob?.type).toBe('image/png');
  expect(calls).toContainEqual(['globalAlpha=', 1]);
  expect(calls).toContainEqual(['filter=', 'none']);
  expect(calls).toContainEqual(['drawImage', image, 0, 0, 400, 200]);
  const fill = calls.findIndex(call => call[0] === 'fillRect');
  expect(calls[fill]).toEqual(['fillRect', 20, 20, 80, 40]);
  expect(calls.slice(0, fill).filter(call => call[0] === 'fillStyle=').at(-1)).toEqual(['fillStyle=', REDACT_FILL]);
  expect(calls.findIndex(call => call[0] === 'drawImage')).toBeLessThan(fill);
  expect(document.querySelector('.image-editor-dialog')).toBeNull();
});

it('draws a Box outline, undoes the last edit and returns nothing on Cancel', async () => {
  const { openImageEditor, BOX_STROKE } = await import('../src/renderer/image-editor.js');
  const result = openImageEditor({ image: {} as CanvasImageSource, width: 400, height: 200, name: 'screen.png' });
  const canvas = document.querySelector<HTMLCanvasElement>('.image-editor-canvas')!;
  named('Box').click();
  expect(named('Box').getAttribute('aria-pressed')).toBe('true');
  drag(canvas, [20, 30], [60, 50]);
  expect(calls).toContainEqual(['strokeStyle=', BOX_STROKE]);
  expect(calls.some(call => call[0] === 'fillRect')).toBe(false);
  drag(canvas, [70, 30], [90, 50]);
  calls = [];
  named('Undo').click();
  expect(calls.filter(call => call[0] === 'strokeRect')).toHaveLength(1);
  named('Undo').click();
  expect(named('Undo').disabled).toBe(true);
  expect(named('Save').disabled).toBe(true);
  named('Cancel').click();
  expect(await result).toBeNull();
  expect(document.querySelector('.image-editor-dialog')).toBeNull();
});
