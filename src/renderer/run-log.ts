/**
 * The run log drawer, opened from a turn's "Worked for" line: what the app did about this chat
 * while it worked, oldest first, with times. It reads the chat's recorded run rows
 * (`sessions:events` with `runLog`) each time it opens; the rows of the work whose line was
 * clicked are marked. It shows what was recorded and decides nothing.
 */
import type { SessionEvent } from '../shared/session.js';
import { runLogEntries, type RunLogEntry, type RunLogKind } from '../shared/run-log.js';
import { clockTime, compactNumber, el, icon } from './dom.js';
import { currentLanguage, t } from './i18n.js';

export interface RunLogDeps {
  /** The chat's run rows; null when the read failed. */
  load(sessionId: string): Promise<readonly SessionEvent[] | null>;
  /** A recorded app text in the interface language, where the app knows it (the approval row). */
  localize(text: string): string;
}

/** The work a line stands for: from its question until the next one (open-ended for the latest). */
export interface RunLogWindow { from: number; to: number }

const KIND: Record<RunLogKind, { icon: string; label: () => string }> = {
  recovery: { icon: 'i-retry', label: () => t('Recovery') },
  approval: { icon: 'i-lock', label: () => t('Approval card') },
  error: { icon: 'i-warning', label: () => t('Error') },
  reopen: { icon: 'i-play', label: () => t('Turn reopened') },
  compaction: { icon: 'i-file-text', label: () => t('Compact & resume') },
  note: { icon: 'i-pulse', label: () => t('Note') }
};

function entryText(entry: RunLogEntry, localize: (text: string) => string): string {
  const event = entry.event;
  if (event.kind === 'handoff') return t('Handoff saved — {0} characters ({1})', [compactNumber(event.chars), event.reason]);
  if (event.kind === 'turn_start') return event.detail ?? '';
  return 'message' in event ? localize(event.message.text) : '';
}

function stamp(at: number, now: number): string {
  if (new Date(at).toDateString() === new Date(now).toDateString()) return clockTime(at);
  return new Date(at).toLocaleString(currentLanguage(), { dateStyle: 'short', timeStyle: 'medium' });
}

/** One row: its time (a span when it was updated later), what it was, and the recorded words. */
export function runLogRow(entry: RunLogEntry, localize: (text: string) => string, now = Date.now()): HTMLElement {
  const row = el('li', 'run-log-row');
  row.dataset.kind = entry.kind;
  const time = el('time', 'run-log-time', entry.until ? `${stamp(entry.at, now)} – ${clockTime(entry.until)}` : stamp(entry.at, now));
  time.setAttribute('datetime', new Date(entry.at).toISOString());
  const head = el('div', 'run-log-head');
  head.append(icon(KIND[entry.kind].icon), el('span', 'run-log-kind', KIND[entry.kind].label), time);
  row.append(head);
  const text = entryText(entry, localize);
  if (text) {
    const body = el('p', 'run-log-text', text);
    body.dir = 'auto';
    row.append(body);
  }
  return row;
}

export function createRunLog(deps: RunLogDeps): { open(sessionId: string, work?: RunLogWindow): Promise<void> } {
  let dialog: HTMLDialogElement | null = null;
  // Electron has the dialog methods; a bare DOM (the tests) gets the same effect by hand.
  const closeDialog = (): void => {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  };
  return {
    async open(sessionId, work) {
      if (dialog?.open) closeDialog();
      const box = document.createElement('dialog');
      box.className = 'plugin-dialog run-log-dialog';
      const head = el('div', 'plugin-dialog-head');
      const heading = el('h2', '', () => t('Run log'));
      heading.id = 'runLogTitle';
      box.setAttribute('aria-labelledby', heading.id);
      const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
      close.type = 'button';
      close.onclick = closeDialog;
      head.append(heading, close);
      const body = el('div', 'plugin-dialog-body');
      const status = el('p', 'run-log-empty', () => t('Loading…'));
      body.append(el('p', 'run-log-intro', () => t('Recoveries, approval waits and errors in this chat')), status);
      box.append(head, body);
      box.addEventListener('close', () => { box.remove(); if (dialog === box) dialog = null; });
      document.body.append(box);
      dialog = box;
      if (typeof box.showModal === 'function') box.showModal(); else box.setAttribute('open', '');
      close.focus();
      const events = await deps.load(sessionId);
      if (dialog !== box) return;
      if (!events) { status.textContent = t('The run log could not be read.'); return; }
      const entries = runLogEntries(events);
      if (!entries.length) {
        status.textContent = t('No recoveries, approval waits or errors were recorded in this chat.');
        return;
      }
      const list = el('ol', 'run-log-list');
      const now = Date.now();
      let first: HTMLElement | null = null;
      for (const entry of entries) {
        const row = runLogRow(entry, deps.localize, now);
        if (work && entry.at >= work.from && entry.at < work.to) {
          row.setAttribute('aria-current', 'true');
          first ??= row;
        }
        list.append(row);
      }
      status.replaceWith(list);
      first?.scrollIntoView({ block: 'nearest' });
    }
  };
}
