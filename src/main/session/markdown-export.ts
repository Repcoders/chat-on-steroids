import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';
import type { SessionSearchLocation, StoredText } from '../../shared/session.js';
import { answerArtifacts, type SessionArtifact, type SessionArtifactsReply } from '../../shared/answer-artifacts.js';
import { positionOf } from '../../shared/chronology.js';
import {
  answerMarkdown, completedTurnIds, markdownFileName, messageAnswerEntries, sessionMarkdown, transcriptEntries, turnAnswerEntries
} from '../../shared/markdown-export.js';
import { getSession, readEvents, readOverflowText } from './store.js';
import { providerEntitiesAsMarkdown } from '../../shared/content-reference.js';
import { dialogLabel, mainText } from '../main-texts.js';
import { completedDilText } from '../../shared/dil-tables.js';

export type MarkdownExportRequest = {
  id: string;
  scope: 'answer' | 'session';
  /** The completed turn whose answer is wanted; `answer` names this or `messageId`. */
  turnId?: string;
  /** An answer recorded outside any turn (copied branch history, an adopted chat's history). */
  messageId?: string;
  target: 'clipboard' | 'file';
};

export type MarkdownExportResult = { done: 'copied' } | { done: 'saved'; name: string } | { done: 'cancelled' };

/** The whole text: an answer cut in the log is read back from the overflow copy beside it. */
async function fullText(sessionId: string, stored: StoredText, html?: StoredText): Promise<string> {
  // ChatGPT's link cards arrive as private-use markup; exported Markdown gets real links. A table
  // it drew in full but wrote with only its header gets its recorded rows (#1477).
  const text = !stored.truncated || !stored.assetId ? stored.text : (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
  return providerEntitiesAsMarkdown(completedDilText(text, html));
}

/** Builds a completed turn's answer or the session transcript and copies or saves it. */
export async function exportSessionMarkdown(request: MarkdownExportRequest, owner: BrowserWindow | null): Promise<MarkdownExportResult> {
  const summary = await getSession(request.id);
  if (!summary) throw new Error('Session not found');
  const events = await readEvents(request.id);
  let markdown: string;
  let name: string;
  if (request.scope === 'answer') {
    // Only a turn the page reported as completed has an answer to hand out; an answer recorded
    // outside any turn is final already, and is named by its message instead.
    if (!request.messageId && (!request.turnId || !completedTurnIds(events).has(request.turnId))) throw new Error('This turn has not completed');
    const entries = request.messageId ? messageAnswerEntries(events, request.messageId) : turnAnswerEntries(events, request.turnId!);
    if (!entries.length) throw new Error('This turn has no answer to export');
    markdown = answerMarkdown(await Promise.all(entries.map(entry => fullText(request.id, entry.stored, entry.html))));
    name = markdownFileName(summary.title, ' - answer');
  } else {
    const entries = transcriptEntries(events);
    markdown = sessionMarkdown(summary.title, await Promise.all(entries.map(async entry =>
      ({ role: entry.role, text: await fullText(request.id, entry.stored, entry.html) }))));
    name = markdownFileName(summary.title);
  }
  if (request.target === 'clipboard') {
    await clipboard.writeText(markdown);
    return { done: 'copied' };
  }
  const options = {
    ...dialogLabel('Export as Markdown'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: mainText('Markdown files'), extensions: ['md'] }]
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { done: 'cancelled' };
  await fs.writeFile(result.filePath, markdown, 'utf8');
  return { done: 'saved', name: path.basename(result.filePath) };
}

/** Most artifacts one chat lists, and the most text they carry together. */
const MAX_CHAT_ARTIFACTS = 500;
const MAX_ARTIFACT_CHARS = 2_000_000;
const QUESTION_CHARS = 120;

/**
 * Artifacts: the code blocks, tables and display formulas of the chat's final answers, in spoken
 * order, read from the whole recording with the full text of answers the log cut (the same text
 * Copy answer gives). Each carries its answer's number, the question before it and where it is.
 */
export async function artifactsInSession(id: string): Promise<SessionArtifactsReply> {
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const bySeq = new Map(events.map(event => [event.seq, event]));
  // A revised answer keeps the place where it first appeared.
  const firstPosition = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'assistant_message' || !event.messageId) continue;
    const at = positionOf(event);
    if (at < (firstPosition.get(event.messageId) ?? Number.POSITIVE_INFINITY)) firstPosition.set(event.messageId, at);
  }
  const artifacts: SessionArtifact[] = [];
  let question = '', answer = 0, chars = 0;
  for (const entry of transcriptEntries(events)) {
    if (entry.role === 'user') {
      question = entry.stored.text.replace(/\s+/g, ' ').trim().slice(0, QUESTION_CHARS);
      continue;
    }
    answer++;
    const event = bySeq.get(entry.seq);
    if (event?.kind !== 'assistant_message') continue;
    const found = answerArtifacts(await fullText(id, entry.stored, entry.html));
    if (!found.length) continue;
    const messageId = event.messageId ?? null;
    const position = Math.min(positionOf(event), messageId === null ? Number.POSITIVE_INFINITY : firstPosition.get(messageId) ?? Number.POSITIVE_INFINITY);
    const location: SessionSearchLocation = { seq: event.seq, kind: 'assistant_message', messageId, position };
    for (const artifact of found) {
      if (artifacts.length >= MAX_CHAT_ARTIFACTS || chars + artifact.text.length > MAX_ARTIFACT_CHARS) return { artifacts, limited: true };
      chars += artifact.text.length;
      artifacts.push({ ...artifact, answer, question, location });
    }
  }
  return { artifacts };
}
