/**
 * The saved answers shelf: answers the user starred, across chats (see shared/saved-answers.ts).
 *
 * One small durable file, rewritten whole on each change. An entry holds its own Markdown copy,
 * read whole from the recording when it was saved, so removing its chat leaves it readable; such
 * an entry is orphaned only on positive proof that the chat's history is gone.
 */
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import { markdownFileName } from '../../shared/markdown-export.js';
import { savedAnswerKey, type SavedAnswer, type SavedAnswerView } from '../../shared/saved-answers.js';
import type { SessionSearchLocation } from '../../shared/session.js';
import { readAnswerMarkdown, saveMarkdownFile, type MarkdownExportResult } from './markdown-export.js';
import { locateMessage } from './search.js';
import { sessionDirectoryMissing } from './store.js';

const STATE = 'saved-answers';
const STATE_VERSION = 1;
export const MAX_SAVED_ANSWERS = 500;
export const MAX_SAVED_ANSWER_CHARS = 100_000;
/** All entries together: every change rewrites the file and answers with the whole shelf. */
export const MAX_SHELF_CHARS = 2_000_000;
const SHELF_FULL = 'Saved answers are full. Remove one first.';

let entries: SavedAnswer[] = [];
let restoring: Promise<void> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function optionalText(value: unknown): value is string | null {
  return value === null || (text(value, 200) && value.length > 0);
}

function validEntry(value: unknown): value is SavedAnswer {
  const entry = value as Partial<SavedAnswer> | null;
  return !!entry && typeof entry === 'object' && text(entry.id, 64) && text(entry.sessionId, 64) &&
    optionalText(entry.turnId) && optionalText(entry.messageId) && optionalText(entry.anchorMessageId) &&
    (entry.turnId !== null || entry.messageId !== null) && text(entry.title, 500) &&
    text(entry.markdown, MAX_SAVED_ANSWER_CHARS) && Number.isFinite(entry.savedAt);
}

function ready(): Promise<void> {
  restoring ??= (async () => {
    const saved = await readDurable<{ version: number; entries: unknown[] }>(STATE);
    if (saved?.version !== STATE_VERSION || !Array.isArray(saved.entries)) return;
    let chars = 0;
    entries = saved.entries.filter(validEntry).slice(0, MAX_SAVED_ANSWERS)
      .filter(entry => {
        // Only an entry that is kept counts toward the budget; a later one that fits stays.
        if (chars + entry.markdown.length > MAX_SHELF_CHARS) return false;
        chars += entry.markdown.length;
        return true;
      });
  })();
  return restoring;
}

/** One change at a time, published only once its file is written. */
function mutate(change: (current: readonly SavedAnswer[]) => Promise<SavedAnswer[] | null>): Promise<SavedAnswerView[]> {
  const operation = mutationQueue.then(async () => {
    await ready();
    const next = await change(entries);
    if (next) {
      try {
        await writeDurableNow(STATE, { version: STATE_VERSION, entries: next });
      } catch (error) {
        // The failed generation is retried later; it must not win over the shelf that is shown.
        writeDurableSoon(STATE, { version: STATE_VERSION, entries });
        throw error;
      }
      entries = next;
    }
    return views();
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

async function views(): Promise<SavedAnswerView[]> {
  const missing = new Map<string, boolean>();
  for (const id of new Set(entries.map(entry => entry.sessionId))) {
    missing.set(id, await sessionDirectoryMissing(id).catch(() => false));
  }
  return [...entries].sort((a, b) => b.savedAt - a.savedAt)
    .map(entry => ({ ...entry, orphaned: missing.get(entry.sessionId) === true }));
}

export async function listSavedAnswers(): Promise<SavedAnswerView[]> {
  await mutationQueue;
  await ready();
  return views();
}

/** Stars a completed answer: a copy of its whole Markdown goes on the shelf, once. */
export function saveAnswer(sessionId: string, turnId?: string, messageId?: string, now = Date.now()): Promise<SavedAnswerView[]> {
  return mutate(async current => {
    const key = savedAnswerKey(sessionId, turnId, messageId);
    if (current.some(entry => savedAnswerKey(entry.sessionId, entry.turnId, entry.messageId) === key)) return null;
    if (current.length >= MAX_SAVED_ANSWERS) throw new Error(SHELF_FULL);
    const answer = await readAnswerMarkdown(sessionId, turnId, messageId);
    if (answer.markdown.length > MAX_SAVED_ANSWER_CHARS) throw new Error('This answer is too long to save.');
    const chars = current.reduce((sum, entry) => sum + entry.markdown.length, 0);
    if (chars + answer.markdown.length > MAX_SHELF_CHARS) throw new Error(SHELF_FULL);
    return [...current, {
      id: randomUUID(), sessionId, turnId: turnId ?? null, messageId: turnId ? null : messageId ?? null,
      anchorMessageId: answer.entries[0]?.messageId ?? null, title: answer.title.slice(0, 500),
      markdown: answer.markdown, savedAt: now
    }];
  });
}

export function removeSavedAnswer(id: string): Promise<SavedAnswerView[]> {
  return mutate(async current => current.some(entry => entry.id === id) ? current.filter(entry => entry.id !== id) : null);
}

/** Where an entry's answer is in its chat now; null when the chat or the message is gone. */
export async function locateSavedAnswer(id: string): Promise<{ sessionId: string; location: SessionSearchLocation } | null> {
  await ready();
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry?.anchorMessageId) return null;
  const location = await locateMessage(entry.sessionId, entry.anchorMessageId);
  return location ? { sessionId: entry.sessionId, location } : null;
}

/** Saves one entry's Markdown where the person chooses, named after its chat. */
export async function exportSavedAnswer(id: string, owner: BrowserWindow | null): Promise<MarkdownExportResult> {
  await ready();
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry) throw new Error('This saved answer was removed');
  return saveMarkdownFile(markdownFileName(entry.title, ' - answer'), entry.markdown, owner);
}

export function resetSavedAnswersForTests(): void {
  entries = [];
  restoring = null;
  mutationQueue = Promise.resolve();
}
