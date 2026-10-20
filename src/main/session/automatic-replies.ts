/**
 * Goal and Loop follow-ups, by the text their page will type (#1655).
 *
 * The page types a follow-up itself, so it reaches ChatGPT with no outbox row and comes back as an
 * ordinary sent message; prompt recall then brought it back as if the person had typed it. The app
 * notes each follow-up it hands out, and the recorder marks the one message that returns with that
 * text in that chat as `automatic`. ChatGPT stores text a page inserted with its Markdown escaped,
 * so both sides are compared without escapes and with whitespace folded.
 */
const KEEP_MS = 60 * 60_000;
/**
 * A Goal opening message the ChatGPT page drafted for a chat that has no id yet (`/goal/opening`):
 * it is noted here and taken by whichever chat it arrives in.
 */
export const NEW_CHAT = '';
const PER_CHAT = 4;
const handed = new Map<string, Array<{ text: string; at: number; loop?: true }>>();
let loopDelivered: ((conversationId: string) => void) | null = null;

/**
 * Told once for each automatic Loop message that reached its chat: a noted after-turn follow-up
 * the recorder took back, or a finish follow-up the outbox handed over. Loop's limits count these.
 */
export function onLoopReplyDelivered(listener: ((conversationId: string) => void) | null): void {
  loopDelivered = listener;
}

export function loopMessageDelivered(conversationId: string): void {
  try { loopDelivered?.(conversationId); } catch { /* counting never blocks delivery or recording */ }
}

function comparable(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** A Goal or Loop follow-up for this chat is ready for its page to type. */
export function noteAutomaticReply(conversationId: string, text: string, now = Date.now(), loop = false): void {
  const value = comparable(text);
  if (!value) return;
  const kept = (handed.get(conversationId) ?? []).filter(entry => now - entry.at < KEEP_MS && entry.text !== value);
  kept.push({ text: value, at: now, ...(loop ? { loop: true as const } : {}) });
  handed.delete(conversationId);
  handed.set(conversationId, kept.slice(-PER_CHAT));
  if (handed.size > 200) handed.delete(handed.keys().next().value!);
}

/** Whether this sent message is a noted follow-up; a match is used up, so the same text later is the person's. */
export function takeAutomaticReply(conversationId: string, text: string, now = Date.now()): boolean {
  return takeFrom(conversationId, text, now) || (conversationId !== NEW_CHAT && takeFrom(NEW_CHAT, text, now));
}

function takeFrom(conversationId: string, text: string, now: number): boolean {
  const kept = handed.get(conversationId);
  if (!kept) return false;
  const value = comparable(text);
  const at = kept.findIndex(entry => entry.text === value && now - entry.at < KEEP_MS);
  if (at < 0) return false;
  const [taken] = kept.splice(at, 1);
  if (!kept.length) handed.delete(conversationId);
  if (taken?.loop) loopMessageDelivered(conversationId);
  return true;
}

export function resetAutomaticRepliesForTests(): void {
  handed.clear();
}
