/**
 * Saved answers: the star under an answer and the shelf that lists every starred answer.
 *
 * Main owns the shelf (session/saved-answers.ts) and copies each answer's whole Markdown when it is
 * starred; the renderer keeps the latest list to paint stars and to search it while typing. An
 * entry whose chat was removed stays readable, copyable and exportable, marked as such.
 */
import { savedAnswerKey, type SavedAnswerView } from '../shared/saved-answers.js';
import { foldCase } from '../shared/fold-case.js';
import { $, el, icon, run, setIcon, toast } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

const api = window.api;
const SNIPPET_CHARS = 240;

let shelf: SavedAnswerView[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Each entry's title and text folded once for search; an entry's text never changes. */
const folded = new Map<string, string>();
let requests = 0;
let shown = 0;

/**
 * Asks main for the shelf (or to change it). Main answers in the order it was asked, so a reply is
 * shown unless the reply to a later request already is.
 */
function request(call: Promise<{ ok: true; data: SavedAnswerView[] } | { ok: false; error: string }>): Promise<void> {
  const generation = ++requests;
  return run(call).then(next => {
    if (!next || generation < shown) return;
    shown = generation;
    publish(next);
  });
}

function publish(next: SavedAnswerView[] | null): void {
  if (!next) return;
  shelf = next;
  const ids = new Set(next.map(entry => entry.id));
  for (const id of folded.keys()) if (!ids.has(id)) folded.delete(id);
  // Timeline rows are cached across repaints, so their stars are repainted here, in place.
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-saved-answer]')) paintSaveButton(button);
  for (const listener of listeners) listener();
}

/** Reads the shelf again: its first read at startup, and each time it is opened. */
export function loadSavedAnswers(): Promise<void> {
  loaded = request(api.savedAnswers());
  return loaded;
}

function savedEntry(key: string): SavedAnswerView | undefined {
  return shelf.find(entry => savedAnswerKey(entry.sessionId, entry.turnId, entry.messageId) === key);
}

/** The star under one answer, named the way export names it. */
export function saveAnswerButton(sessionId: string, turnId: string | null, messageId?: string): HTMLButtonElement {
  const button = el('button', 'answer-action answer-save') as HTMLButtonElement;
  button.type = 'button';
  const key = savedAnswerKey(sessionId, turnId, turnId ? undefined : messageId);
  button.dataset.savedAnswer = key;
  button.append(icon('i-star'));
  paintSaveButton(button);
  button.addEventListener('click', async () => {
    if (button.dataset.busy) return;
    button.dataset.busy = '1';
    try {
      await loaded;
      const entry = savedEntry(key);
      await request(entry ? api.removeSavedAnswer(entry.id)
        : api.saveAnswer({ id: sessionId, ...(turnId ? { turnId } : messageId ? { messageId } : {}) }));
    } finally { delete button.dataset.busy; }
  });
  return button;
}

/** Fills or empties a star after the shelf changed. */
function paintSaveButton(button: HTMLButtonElement): void {
  const saved = !!savedEntry(button.dataset.savedAnswer ?? '');
  button.classList.toggle('is-saved', saved);
  button.setAttribute('aria-pressed', String(saved));
  const glyph = button.querySelector('.ico');
  if (glyph) setIcon(glyph, saved ? 'i-star-fill' : 'i-star');
  const label = (): string => saved ? t('Remove from saved answers') : t('Save answer');
  ui(button, 'title', label); ui(button, 'aria-label', label);
}

/** Every query word must appear in the title or the answer, in any order, case and accents ignored. */
export function matchingSavedAnswers(entries: readonly SavedAnswerView[], query: string): SavedAnswerView[] {
  const words = foldCase(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter(entry => {
    let text = folded.get(entry.id);
    if (text === undefined) folded.set(entry.id, text = foldCase(`${entry.title}\n${entry.markdown}`));
    return words.every(word => text.includes(word));
  });
}

export interface SavedAnswersOptions {
  /** Shows the entry's chat at its answer. */
  open(entry: SavedAnswerView): void;
}

export function initSavedAnswers(options: SavedAnswersOptions): { open(): void } {
  const dialog = $<HTMLDialogElement>('savedAnswersDialog');
  const field = $<HTMLInputElement>('savedAnswersSearch');
  const results = $('savedAnswersList');
  const opener = $<HTMLButtonElement>('sidebarSavedAnswers');

  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const finish = (): void => { if (dialog.classList.contains('is-closing')) { dialog.classList.remove('is-closing'); dialog.close(); } };
    const animation = window.getComputedStyle(dialog).animationName;
    if (!animation || animation === 'none') { finish(); return; }
    dialog.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 300);
  };

  const action = (name: string, label: string, act: (button: HTMLButtonElement) => void): HTMLButtonElement => {
    const button = el('button', 'answer-action') as HTMLButtonElement;
    button.type = 'button';
    button.append(icon(name));
    ui(button, 'title', () => t(label)); ui(button, 'aria-label', () => t(label));
    button.addEventListener('click', () => act(button));
    return button;
  };

  const row = (entry: SavedAnswerView): HTMLElement => {
    const item = el('div', `saved-answer${entry.orphaned ? ' is-orphaned' : ''}`);
    item.setAttribute('role', 'listitem');
    const open = el('button', 'search-result') as HTMLButtonElement;
    open.type = 'button';
    const title = el('b', '', entry.title || t('Untitled session'));
    title.dir = 'auto';
    const preview = entry.markdown.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
    const snippet = el('span', 'search-snippet', preview);
    snippet.dir = 'auto';
    const date = new Date(entry.savedAt).toLocaleDateString(currentLanguage(), { year: 'numeric', month: 'short', day: 'numeric' });
    const meta = el('span', 'saved-answer-meta', () => entry.orphaned ? `${date} · ${t('Chat removed')}` : date);
    open.append(title, snippet, meta);
    if (entry.orphaned) {
      // No chat to open it in: the row unfolds to the whole answer instead.
      open.setAttribute('aria-expanded', 'false');
      open.addEventListener('click', () => {
        const expanded = item.classList.toggle('is-expanded');
        open.setAttribute('aria-expanded', String(expanded));
        snippet.textContent = expanded ? entry.markdown.trim() : preview;
      });
    } else open.addEventListener('click', () => { close(); options.open(entry); });
    const actions = el('div', 'saved-answer-actions');
    actions.append(
      action('i-copy', 'Copy answer', async () => {
        if (await run(api.writeClipboard(entry.markdown))) toast(t('Copied'));
      }),
      action('i-export', 'Export as Markdown', async () => {
        const result = await run(api.exportSavedAnswer(entry.id));
        if (result?.done === 'saved') toast(t('Saved {0}', [result.name]));
      }),
      action('i-trash', 'Remove from saved answers', () => void request(api.removeSavedAnswer(entry.id))));
    item.append(open, actions);
    return item;
  };

  const paint = (): void => {
    if (!dialog.open) return;
    const query = field.value.trim();
    const matches = matchingSavedAnswers(shelf, query);
    const list = el('div', 'search-list');
    list.setAttribute('role', 'list');
    list.append(...matches.map(row));
    results.replaceChildren(list);
    if (!shelf.length) results.append(el('p', 'empty search-status', () => t('Star an answer to keep it here.')));
    else if (!matches.length) results.append(el('p', 'empty search-status', () => t('No saved answers match')));
  };

  const open = (): void => {
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
    field.focus();
    field.select();
    paint();
    // Orphaned marks change when a chat is removed, so the list is read again on every open.
    void loadSavedAnswers();
  };

  ui(dialog, 'aria-label', () => t('Saved answers'));
  ui(field, 'placeholder', () => t('Search saved answers'));
  ui(field, 'aria-label', () => t('Search saved answers'));
  listeners.add(paint);
  field.addEventListener('input', paint);
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Enter') results.querySelector<HTMLButtonElement>('.saved-answer:not(.is-orphaned) > .search-result')?.click();
  });
  opener.addEventListener('click', open);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  void loadSavedAnswers();
  return { open };
}
