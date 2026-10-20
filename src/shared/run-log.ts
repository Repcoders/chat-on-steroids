/**
 * The run log: what the app did about a chat while it worked, collected in one list.
 *
 * Every row here is already recorded. A reload the app made to recover the chat is an app-owned
 * `progress` row (`browser-repair:`), hidden from the timeline outside developer mode; a wait on
 * ChatGPT's tool approval card is one too (`approval-wait:`); an error ChatGPT showed is a
 * `chat_error`; a turn the app reopened after the page ended it falsely is a `turn_start` with a
 * `detail`; app notes and Compact & Resume handoffs are their own kinds. Only the app's own rows
 * count: ChatGPT's commentary is also `progress`, and it is never part of this list. The rows are
 * picked by kind, source and id prefix, never by their words.
 */
import { APPROVAL_PROGRESS_PREFIX } from './approval-wait.js';
import type { SessionEvent, SessionEventKind } from './session.js';

export type RunLogKind = 'recovery' | 'approval' | 'error' | 'reopen' | 'compaction' | 'note';

/** The recorded kinds a run log reads; the store filters on them before `runLogKind` picks rows. */
export const RUN_LOG_EVENT_KINDS = ['progress', 'chat_error', 'turn_start', 'note', 'handoff'] as const satisfies readonly SessionEventKind[];

export const RECOVERY_PROGRESS_PREFIX = 'browser-repair:';

export interface RunLogEntry {
  kind: RunLogKind;
  /** When it happened: an updated row keeps the time it was first written. */
  at: number;
  /** When an updated row (a reload that later succeeded, an answered card) last changed; absent otherwise. */
  until?: number;
  /** The newest recorded event of the row, for its text. */
  event: SessionEvent;
}

export function runLogKind(event: SessionEvent): RunLogKind | null {
  switch (event.kind) {
    case 'progress':
      if (event.source !== 'app' || !event.progressId) return null;
      if (event.progressId.startsWith(RECOVERY_PROGRESS_PREFIX)) return 'recovery';
      return event.progressId.startsWith(APPROVAL_PROGRESS_PREFIX) ? 'approval' : null;
    case 'chat_error': return 'error';
    case 'turn_start': return event.detail ? 'reopen' : null;
    case 'handoff': return 'compaction';
    case 'note': return event.continuation ? 'compaction' : 'note';
    default: return null;
  }
}

/**
 * The run log of these events, oldest first. Later snapshots of one app progress row (the same
 * `progressId`) update that row's text and end time in place, as the timeline folds them.
 */
export function runLogEntries(events: readonly SessionEvent[]): RunLogEntry[] {
  const entries: RunLogEntry[] = [];
  const rows = new Map<string, RunLogEntry>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const kind = runLogKind(event);
    if (!kind) continue;
    const id = event.kind === 'progress' ? event.progressId! : null;
    const held = id ? rows.get(id) : undefined;
    if (held) {
      held.event = event;
      if (event.time > held.at) held.until = event.time;
      continue;
    }
    const entry: RunLogEntry = { kind, at: event.time, event };
    if (id) rows.set(id, entry);
    entries.push(entry);
  }
  return entries.sort((a, b) => a.at - b.at);
}
