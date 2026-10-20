/**
 * Saved answers: answers the user starred, kept on one shelf across chats.
 *
 * Each entry keeps its own copy of the answer's Markdown, so it can still be read, copied and
 * exported after its chat is removed; it is then `orphaned` and no longer opens a chat.
 */
export interface SavedAnswer {
  id: string;
  sessionId: string;
  /** The answer as the timeline names it: its completed turn, or its message when outside any turn. */
  turnId: string | null;
  messageId: string | null;
  /** The answer's first message, where opening the entry shows the chat. */
  anchorMessageId: string | null;
  /** The chat's title when the answer was saved. */
  title: string;
  markdown: string;
  savedAt: number;
}

export interface SavedAnswerView extends SavedAnswer {
  /** Its chat was removed: the entry keeps its text but has nowhere to open. */
  orphaned: boolean;
}

/** One answer's identity on the shelf, from the names the timeline gives it. */
export function savedAnswerKey(sessionId: string, turnId: string | null | undefined, messageId: string | null | undefined): string {
  return JSON.stringify(turnId ? [sessionId, 'turn', turnId] : [sessionId, 'message', messageId ?? '']);
}
