/**
 * The outbox inspector (View › Outbox): every message the app still owes a chat, across all chats,
 * read from the same outbox list each chat's queue reads (`sessions:outbox`). A chat's queue shows
 * only its own rows, so a message stuck in another chat was out of sight (#326, #327). Each row says
 * which chat it belongs to and, in that chat's own words, what it waits for. Its actions are the ones
 * the chat's own queue offers for that row; the inspector decides nothing about delivery itself.
 */
import type { InputEntry } from '../main/session/input.js';
import { authoredTextOf, queuedFollowup } from '../shared/input.js';
import { el, icon } from './dom.js';
import { t } from './i18n.js';

export interface OutboxInspectorDeps {
  /** The outbox as this window last read it. */
  entries(): readonly InputEntry[];
  /** Reads the outbox again; the chat queue's refresh, which repaints this view too. */
  refresh(): void;
  /** A chat the sidebar has loaded, named as it shows it; null for one with nothing to open yet, undefined when not loaded. */
  chat(id: string): Chat | null | undefined;
  /** Reads a chat the sidebar has not loaded; rejects when the read fails. */
  findChat(id: string): Promise<Chat | null>;
  /** What the row's chat queue says about it: its error, or its state and what it waits for. */
  status(entry: InputEntry): string;
  /** A failed or cancelled row whose notice is still shown in its chat. */
  notice(entry: InputEntry): boolean;
  /** The chat queue's Cancel delivery, which is also its notice's Dismiss: withdraws the row and hides its notice. */
  cancel(id: string): Promise<boolean | null>;
  retryBrowser(id: string): Promise<unknown>;
  open(sessionId: string): void;
}

type Chat = { id: string; title: string };

const WAITING = ['queued', 'browser', 'tool', 'decision'];
/** The errors a chat's queue offers Retry browser for. */
const RETRY_BROWSER = ['Message queued. Browser startup failed:', 'Message queued. Finish Setup to send:', 'Local chat setup failed:'];

/** The rows the inspector lists: everything still waiting, then every notice not dismissed, oldest first. */
export function outboxRows(entries: readonly InputEntry[], notice: (entry: InputEntry) => boolean): InputEntry[] {
  const waiting = entries.filter(entry => WAITING.includes(entry.state));
  const problems = entries.filter(entry => (entry.state === 'failed' || entry.state === 'cancelled') && notice(entry));
  const byAge = (a: InputEntry, b: InputEntry) => a.createdAt - b.createdAt;
  return [...waiting.sort(byAge), ...problems.sort(byAge)];
}

export function createOutboxInspector(deps: OutboxInspectorDeps): { open(): void; update(): void } {
  let dialog: HTMLDialogElement | null = null;
  let list: HTMLElement | null = null;
  // The sidebar loads chats a page at a time; an older chat is read once, and again after a failed read.
  const found = new Map<string, Chat | null>();
  const reading = new Set<string>();
  const chatOf = (entry: InputEntry): Chat | null => {
    const id = entry.sessionId ?? entry.deliveredSessionId;
    if (!id) return null;
    const known = deps.chat(id);
    if (known !== undefined) return known;
    if (found.has(id)) return found.get(id)!;
    if (!reading.has(id)) {
      reading.add(id);
      void deps.findChat(id).then(chat => { reading.delete(id); found.set(id, chat); paint(); }, () => { reading.delete(id); });
    }
    return null;
  };

  // Electron has the dialog methods; a bare DOM (the tests) gets the same effect by hand.
  const closeDialog = (): void => {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  };

  const action = (label: () => string, symbol: string, work: () => Promise<unknown>): HTMLButtonElement => {
    const button = el('button', 'btn outbox-action') as HTMLButtonElement;
    button.type = 'button';
    button.append(icon(symbol), el('span', '', label));
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await work(); } finally { button.disabled = false; deps.refresh(); }
    };
    return button;
  };

  const row = (entry: InputEntry): HTMLElement => {
    const item = el('li', 'outbox-row');
    item.dataset.inputId = entry.id;
    item.dataset.state = entry.state;
    const chat = chatOf(entry);
    const head = el('div', 'outbox-row-head');
    if (chat) {
      const link = el('button', 'outbox-chat', chat.title) as HTMLButtonElement;
      link.type = 'button';
      link.title = chat.title;
      link.onclick = () => { closeDialog(); deps.open(chat.id); };
      head.append(link);
    } else head.append(el('span', 'outbox-chat', () => t('New chat')));
    const status = el('span', 'outbox-status', () => deps.status(entry));
    status.classList.toggle('is-problem', !!entry.error || entry.state === 'failed');
    head.append(status);
    item.append(head);
    const text = authoredTextOf(entry) || entry.text;
    const body = el('p', 'outbox-text', text);
    body.dir = 'auto';
    item.append(body);
    const actions = el('div', 'outbox-actions');
    if (entry.state === 'failed' || entry.state === 'cancelled') {
      actions.append(action(() => t('Dismiss delivery notice'), 'i-x', () => deps.cancel(entry.id)));
    } else if (entry.state === 'queued' || entry.state === 'browser') {
      const label = entry.recovery ? () => t('Cancel automatic Continue')
        : entry.state === 'queued' && queuedFollowup(entry) ? () => t('Remove queued task') : () => t('Cancel delivery');
      actions.append(action(label, 'i-x', () => deps.cancel(entry.id)));
      if (entry.state === 'queued' && RETRY_BROWSER.some(prefix => entry.error?.startsWith(prefix))) {
        actions.append(action(() => t('Retry browser'), 'i-retry', () => deps.retryBrowser(entry.id)));
      }
    }
    if (actions.childElementCount) item.append(actions);
    return item;
  };

  const paint = (): void => {
    if (!list) return;
    const rows = outboxRows(deps.entries(), deps.notice);
    // Chats repaint their queue often (each running tool call); an unchanged row keeps its node and focus.
    const previous = new Map([...list.children].map(node => [(node as HTMLElement).dataset.inputId, node as HTMLElement]));
    const next = rows.map(entry => {
      const sig = JSON.stringify([entry.state, entry.error, entry.text, deps.status(entry), chatOf(entry)]);
      const old = previous.get(entry.id);
      if (old?.dataset.signature === sig) return old;
      const node = row(entry); node.dataset.signature = sig; return node;
    });
    for (const old of previous.values()) if (!next.includes(old)) old.remove();
    let cursor = list.firstChild;
    for (const node of next) {
      if (node !== cursor) list.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    list.hidden = rows.length === 0;
    dialog?.querySelector<HTMLElement>('.outbox-empty')?.toggleAttribute('hidden', rows.length > 0);
  };

  return {
    open() {
      if (dialog?.open) return;
      dialog?.remove();
      const box = document.createElement('dialog');
      box.className = 'plugin-dialog outbox-dialog';
      const head = el('div', 'plugin-dialog-head');
      const heading = el('h2', '', () => t('Outbox'));
      heading.id = 'outboxTitle';
      box.setAttribute('aria-labelledby', heading.id);
      const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
      close.type = 'button';
      close.onclick = closeDialog;
      head.append(heading, close);
      const body = el('div', 'plugin-dialog-body');
      list = el('ul', 'outbox-list');
      list.setAttribute('aria-live', 'polite');
      body.append(list, el('p', 'outbox-empty', () => t('Nothing is waiting to be sent.')));
      box.append(head, body);
      box.addEventListener('close', () => { box.remove(); if (dialog === box) { dialog = null; list = null; } });
      document.body.append(box);
      dialog = box;
      paint();
      if (typeof box.showModal === 'function') box.showModal(); else box.setAttribute('open', '');
      close.focus();
      deps.refresh();
    },
    /** Repaints an open inspector from the latest outbox read; a closed one costs nothing. */
    update: paint
  };
}
