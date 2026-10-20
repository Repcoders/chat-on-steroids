/**
 * Links to one answer (`chat-on-steroids://answer/<session id>/<message id>`): the app's local
 * session id, which Compact & Resume keeps, and the answer's native ChatGPT message id.
 */
export const ANSWER_LINK_SCHEME = 'chat-on-steroids';

export interface AnswerLink {
  sessionId: string;
  messageId: string;
}

const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK = /^chat-on-steroids:\/\/answer\/([0-9a-z-]{8,64})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The link for one answer, or null when either id could not be read back from it. */
export function answerLinkUrl(sessionId: string, messageId: string): string | null {
  if (!SESSION_ID.test(sessionId) || !MESSAGE_ID.test(messageId)) return null;
  return `${ANSWER_LINK_SCHEME}://answer/${sessionId}/${messageId}`;
}

/** The answer a link names. Anything else, a longer path or a query included, is no link. */
export function parseAnswerLink(value: unknown): AnswerLink | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const match = LINK.exec(value);
  return match ? { sessionId: match[1]!, messageId: match[2]! } : null;
}

/** The link a launch was asked to open: Windows and Linux pass it as a command-line argument. */
export function answerLinkInArgv(argv: readonly string[]): AnswerLink | null {
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(`${ANSWER_LINK_SCHEME}:`)) return parseAnswerLink(arg);
  }
  return null;
}
