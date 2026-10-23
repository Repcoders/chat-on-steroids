import type { InputAttachment } from '../shared/input.js';
import { el, icon } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

/** "1.5 MB" in the reader's own number format ("1,5 MB" in German). */
function sizeLabel(bytes: number): string {
  const number = (value: number, digits: number) => new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${number(bytes / (1024 * 1024), bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AttachmentLibraryOptions {
  menu: HTMLDetailsElement;
  /** The "Recent files" row; it keeps the menu open and expands the list under it. */
  toggle: HTMLButtonElement;
  host: HTMLElement;
  list: () => Promise<Reply<InputAttachment[]>>;
  /** Ids already in the visible draft; the same staged file is not offered twice. */
  attached: () => ReadonlySet<string>;
  /** Called when a row is picked; the caller restages it into the draft it captured. */
  choose: (attachment: InputAttachment) => void;
}

/**
 * Files attached earlier, from any chat, offered again from the composer's + menu.
 *
 * Only staged originals are listed (main/session/input-attachments.ts owns them and their 24-hour
 * expiry), so a row always names bytes that still exist. Nothing here reads a path.
 */
export function initAttachmentLibrary(options: AttachmentLibraryOptions): void {
  const { menu, toggle, host } = options;
  let generation = 0;
  const collapse = () => { generation++; host.hidden = true; host.replaceChildren(); toggle.setAttribute('aria-expanded', 'false'); };
  const row = (file: InputAttachment): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'attachment-library-item'; button.dataset.attachmentId = file.id; button.title = file.name;
    ui(button, 'aria-label', () => t('Attach {0} again', [file.name]));
    const thumb = el('span', 'attachment-library-thumb');
    if (file.preview) { const image = document.createElement('img'); image.src = file.preview; image.alt = ''; thumb.append(image); }
    else thumb.append(icon('i-file-text'));
    const details = el('span', 'attachment-library-details');
    details.append(el('span', 'attachment-library-name', file.name),
      el('span', 'attachment-library-meta', () => `${file.mimeType.startsWith('image/') ? t('Image') : t('File')} · ${sizeLabel(file.size)}`));
    button.append(thumb, details);
    // The row is about to be removed; focus goes to the menu button, and the caller moves it on once the file is in.
    button.addEventListener('click', () => { collapse(); menu.querySelector('summary')?.focus(); options.choose(file); });
    return button;
  };
  const expand = async () => {
    const mine = ++generation;
    toggle.setAttribute('aria-expanded', 'true');
    host.hidden = false; host.replaceChildren(el('p', 'attachment-library-note', () => t('Loading…')));
    // Beside the menu when the window has room, else above it; either way no menu row moves.
    host.classList.remove('is-above');
    if (host.getBoundingClientRect().right > window.innerWidth - 8) host.classList.add('is-above');
    const reply = await options.list();
    if (mine !== generation) return;
    if (!reply.ok) { host.replaceChildren(el('p', 'attachment-library-note', () => t('Recent files could not be loaded'))); return; }
    const attached = options.attached();
    const files = reply.data.filter(file => !attached.has(file.id));
    host.replaceChildren(...(files.length ? files.map(row) : [el('p', 'attachment-library-note', () => t('No files attached in the last 24 hours'))]));
  };
  toggle.setAttribute('aria-expanded', 'false');
  // Escape closes the menu with focus inside the list; it lands on the menu button, not the page.
  host.addEventListener('keydown', event => { if (event.key === 'Escape') menu.querySelector('summary')?.focus(); });
  toggle.addEventListener('click', () => { if (host.hidden) void expand(); else collapse(); });
  menu.addEventListener('toggle', () => { if (!menu.open) collapse(); });
}
