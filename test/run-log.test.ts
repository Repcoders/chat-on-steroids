import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT } from '../src/shared/approval-wait.js';
import type { SessionEvent } from '../src/shared/session.js';
import { runLogEntries, runLogKind } from '../src/shared/run-log.js';
import { createRunLog } from '../src/renderer/run-log.js';

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
const text = (value: string) => ({ text: value, truncated: false, chars: value.length });

// The rows one long Goal chat records: a reload the app made, a wait on ChatGPT's approval card,
// ChatGPT's own commentary (also `progress`), an error, a reopened turn, a note and a handoff.
const chat: SessionEvent[] = [
  { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'q1', message: text('Run the checks') },
  { seq: 2, time: T0 + 1_000, source: 'extension', kind: 'turn_start', turnId: 't1' },
  { seq: 3, time: T0 + 2_000, source: 'extension', kind: 'progress', progressId: 'caption-1', message: text('Looking at the tests') },
  { seq: 4, time: T0 + 60_000, source: 'app', kind: 'progress', progressId: 'browser-repair:chat-a:r1', turnId: 't1', message: text('Trying to reload chat to recover an interrupted response…') },
  { seq: 5, time: T0 + 75_000, source: 'app', kind: 'progress', progressId: 'browser-repair:chat-a:r1', origin: 4, turnId: 't1', message: text('Reloaded the chat; the answer continued.') },
  { seq: 6, time: T0 + 90_000, source: 'extension', kind: 'turn_start', turnId: 't1', detail: 'a tool call proved the turn was still running' },
  { seq: 7, time: T0 + 120_000, source: 'app', kind: 'progress', progressId: 'approval-wait:chat-a:1', message: text(APPROVAL_WAITING_TEXT) },
  { seq: 8, time: T0 + 180_000, source: 'app', kind: 'progress', progressId: 'approval-wait:chat-a:1', origin: 7, message: text(APPROVAL_ANSWERED_TEXT) },
  { seq: 9, time: T0 + 200_000, source: 'extension', kind: 'chat_error', message: text('Something went wrong.'), recoverable: true },
  { seq: 10, time: T0 + 210_000, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' },
  { seq: 11, time: T0 + 220_000, source: 'app', kind: 'note', message: text('Goal paused: ChatGPT gave the same answer three times in a row.') },
  { seq: 12, time: T0 + 230_000, source: 'app', kind: 'handoff', handoffId: 'h1', chars: 1800, reason: 'compact and resume', continuation: 'c1' },
  { seq: 13, time: T0 + 240_000, source: 'app', kind: 'progress', progressId: 'finish-release:t1', message: text('Astra is wrapping up') }
];

describe('runLogEntries', () => {
  it("lists the app's own run rows, oldest first, and folds a row's later snapshots into it", () => {
    const entries = runLogEntries(chat);
    expect(entries.map(entry => entry.kind)).toEqual(['recovery', 'reopen', 'approval', 'error', 'note', 'compaction']);
    expect(entries[0]).toMatchObject({ at: T0 + 60_000, until: T0 + 75_000, event: { seq: 5 } });
    expect(entries[2]).toMatchObject({ at: T0 + 120_000, until: T0 + 180_000, event: { seq: 8 } });
    expect(entries[3]!.until).toBeUndefined();
  });

  it("never counts ChatGPT's commentary, a page's own turn start or a progress row of another app feature", () => {
    expect(runLogKind(chat[2]!)).toBeNull();
    expect(runLogKind(chat[1]!)).toBeNull();
    expect(runLogKind(chat[12]!)).toBeNull();
    // ChatGPT's commentary keeps out even when its id looks like the app's.
    expect(runLogKind({ ...chat[3]!, source: 'extension' })).toBeNull();
  });
});

describe('createRunLog', () => {
  let dom: JSDOM;
  let scrolled: Element[];
  beforeEach(() => {
    dom = new JSDOM('<body></body>', { url: 'https://local.test/' });
    scrolled = [];
    dom.window.HTMLElement.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('Event', dom.window.Event);
  });
  afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

  const open = async (events: readonly SessionEvent[] | null, work?: { from: number; to: number }) => {
    const load = vi.fn(async () => events);
    await createRunLog({ load, localize: value => value === APPROVAL_ANSWERED_TEXT ? 'Answered (localized)' : value }).open('session-1', work);
    return { load, dialog: document.querySelector<HTMLDialogElement>('dialog.run-log-dialog')! };
  };

  it("shows each row with its time, what it was and the recorded words, and marks the clicked work's rows", async () => {
    const { load, dialog } = await open(chat, { from: T0 + 100_000, to: T0 + 215_000 });
    expect(load).toHaveBeenCalledWith('session-1');
    const rows = [...dialog.querySelectorAll<HTMLElement>('.run-log-row')];
    expect(rows.map(row => row.querySelector('.run-log-kind')!.textContent)).toEqual(['Recovery', 'Turn reopened', 'Approval card', 'Error', 'Note', 'Compact & resume']);
    expect(rows[0]!.querySelector('.run-log-text')!.textContent).toBe('Reloaded the chat; the answer continued.');
    expect(rows[0]!.querySelector('time')!.textContent).toContain('–');
    expect(rows[0]!.querySelector('time')!.getAttribute('datetime')).toBe(new Date(T0 + 60_000).toISOString());
    expect(rows[2]!.querySelector('.run-log-text')!.textContent).toBe('Answered (localized)');
    expect(rows[5]!.querySelector('.run-log-text')!.textContent).toBe('Handoff saved — 1.8k characters (compact and resume)');
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual([null, null, 'true', 'true', null, null]);
    expect(scrolled).toEqual([rows[2]]);
  });

  it('says when nothing was recorded, and when the read failed', async () => {
    const empty = await open(chat.filter(event => !runLogKind(event)));
    expect(empty.dialog.querySelector('.run-log-list')).toBeNull();
    expect(empty.dialog.querySelector('.run-log-empty')!.textContent).toBe('No recoveries, approval waits or errors were recorded in this chat.');
    empty.dialog.querySelector<HTMLButtonElement>('.plugin-dialog-head .btn')!.click();
    expect(document.querySelector('dialog')).toBeNull();
    const failed = await open(null);
    expect(failed.dialog.querySelector('.run-log-empty')!.textContent).toBe('The run log could not be read.');
  });
});
