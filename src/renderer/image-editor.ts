import { el, icon, toast } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * Redact or mark up a staged image before Send. Redact covers the dragged area with solid black and
 * Box draws a red outline; both are burned into one flattened copy, so nothing layered, blurred or
 * otherwise reversible leaves the editor, and the canvas keeps none of the original's metadata.
 */
export type ImageEdit = { tool: 'redact' | 'box'; x: number; y: number; width: number; height: number };
export const REDACT_FILL = '#000000';
export const BOX_STROKE = '#e5484d';
/** What a pasted image may weigh on its way to staging (preload's in-memory limit). */
const MAX_EDITED_BYTES = 12 * 1024 * 1024;

/** The rectangle between two drag points in whole image pixels, clamped to the image. A click or a sliver is no edit. */
export function editBetween(tool: ImageEdit['tool'], from: { x: number; y: number }, to: { x: number; y: number }, width: number, height: number): ImageEdit | null {
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(0, value));
  const left = Math.floor(clamp(Math.min(from.x, to.x), width)), top = Math.floor(clamp(Math.min(from.y, to.y), height));
  const right = Math.ceil(clamp(Math.max(from.x, to.x), width)), bottom = Math.ceil(clamp(Math.max(from.y, to.y), height));
  return right - left < 3 || bottom - top < 3 ? null : { tool, x: left, y: top, width: right - left, height: bottom - top };
}

/** The image, then every edit in order. Whole-pixel opaque fills leave no partly covered edge. */
export function paintEdits(context: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number, edits: readonly ImageEdit[]): void {
  context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.filter = 'none';
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  for (const edit of edits) {
    if (edit.tool === 'redact') { context.fillStyle = REDACT_FILL; context.fillRect(edit.x, edit.y, edit.width, edit.height); continue; }
    const line = Math.max(2, Math.round(Math.min(width, height) / 200));
    context.lineWidth = line; context.strokeStyle = BOX_STROKE;
    context.strokeRect(edit.x + line / 2, edit.y + line / 2, Math.max(0, edit.width - line), Math.max(0, edit.height - line));
  }
}

/** PNG keeps screenshots sharp; a photo too heavy for staging as PNG goes as JPEG instead. */
async function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const as = (type: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
  const png = await as('image/png');
  if (png && png.size <= MAX_EDITED_BYTES) return png;
  const jpeg = await as('image/jpeg', 0.92);
  return jpeg && jpeg.size <= MAX_EDITED_BYTES ? jpeg : null;
}

/** Resolves with the edited copy, or null when the person closes the editor without saving. */
export function openImageEditor(picture: { image: CanvasImageSource; width: number; height: number; name: string }): Promise<Blob | null> {
  const { image, width, height } = picture;
  const dialog = document.createElement('dialog');
  dialog.className = 'plugin-dialog image-editor-dialog'; dialog.setAttribute('aria-labelledby', 'imageEditorTitle');
  const head = el('div', 'plugin-dialog-head'), title = el('h2', '', () => t('Edit {0}', [picture.name]));
  title.id = 'imageEditorTitle';
  const button = (label: () => string, className = 'btn') => { const node = el('button', className, label) as HTMLButtonElement; node.type = 'button'; return node; };
  const close = button(() => t('Close'));
  head.append(title, close);
  const body = el('div', 'plugin-dialog-body');
  const tools = el('div', 'image-editor-tools'); tools.setAttribute('role', 'toolbar'); ui(tools, 'aria-label', () => t('Image tools'));
  const redact = button(() => t('Redact')), box = button(() => t('Box')), undo = button(() => t('Undo'));
  redact.dataset.tool = 'redact'; box.dataset.tool = 'box';
  undo.prepend(icon('i-zoom-reset'));
  tools.append(redact, box, undo);
  const hint = el('p', 'image-editor-hint', () => t('Drag across the image. Redact covers that area with solid black; only the edited copy is attached.'));
  const canvas = document.createElement('canvas');
  canvas.className = 'image-editor-canvas'; canvas.width = width; canvas.height = height;
  ui(canvas, 'aria-label', () => t('Edit {0}', [picture.name]));
  const actions = el('div', 'pet-delete-actions'), cancel = button(() => t('Cancel')), save = button(() => t('Save'), 'btn btn-solid');
  actions.append(cancel, save);
  body.append(tools, hint, canvas, actions);
  dialog.append(head, body);

  const context = canvas.getContext('2d');
  const edits: ImageEdit[] = [];
  let tool: ImageEdit['tool'] = 'redact';
  let drag: { from: { x: number; y: number }; to: { x: number; y: number }; pointer: number } | null = null;
  const paint = () => {
    const live = drag && editBetween(tool, drag.from, drag.to, width, height);
    if (context) paintEdits(context, image, width, height, live ? [...edits, live] : edits);
    for (const node of [redact, box]) { const on = node.dataset.tool === tool; node.classList.toggle('is-on', on); node.setAttribute('aria-pressed', String(on)); }
    undo.disabled = !edits.length; save.disabled = !edits.length;
  };
  const point = (event: PointerEvent) => {
    const frame = canvas.getBoundingClientRect();
    return { x: (event.clientX - frame.left) * width / (frame.width || width), y: (event.clientY - frame.top) * height / (frame.height || height) };
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { from: point(event), to: point(event), pointer: event.pointerId };
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* A pointer that already ended keeps the drag local. */ }
  });
  canvas.addEventListener('pointermove', event => { if (drag?.pointer !== event.pointerId) return; drag.to = point(event); paint(); });
  const release = (event: PointerEvent, keep: boolean) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.to = point(event);
    const edit = keep ? editBetween(tool, drag.from, drag.to, width, height) : null;
    drag = null;
    if (edit) edits.push(edit);
    paint();
  };
  canvas.addEventListener('pointerup', event => release(event, true));
  canvas.addEventListener('pointercancel', event => release(event, false));
  for (const node of [redact, box]) node.addEventListener('click', () => { tool = node.dataset.tool as ImageEdit['tool']; paint(); });
  undo.addEventListener('click', () => { edits.pop(); paint(); });
  dialog.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey && edits.length) { event.preventDefault(); edits.pop(); paint(); }
  });

  return new Promise(resolve => {
    let settled = false;
    const finish = (result: Blob | null) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    dialog.addEventListener('close', () => finish(null));
    for (const node of [close, cancel]) node.addEventListener('click', () => finish(null));
    save.addEventListener('click', async () => {
      if (!edits.length || save.disabled) return;
      drag = null; paint(); save.disabled = true;
      const blob = await encode(canvas);
      if (!blob) { toast(t('Could not save the edited image')); save.disabled = false; return; }
      finish(blob);
    });
    document.body.append(dialog);
    paint();
    dialog.showModal();
    redact.focus();
  });
}
