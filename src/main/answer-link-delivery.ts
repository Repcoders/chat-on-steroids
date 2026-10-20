import type { AnswerLink } from '../shared/answer-link.js';

/** The part of the window's contents a link is handed to. */
export interface AnswerLinkTarget {
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  once(event: 'did-finish-load', listener: () => void): unknown;
  send(channel: 'answer-link:open', link: AnswerLink): void;
}

/**
 * Hands an opened answer link to the window. A link can arrive before there is one to take it:
 * macOS reports a cold-start link before `ready`, and a second launch can come while startup
 * is still restoring state. The newest link waits until `flush` finds a window to take it.
 */
export function createAnswerLinkDelivery(showWindow: () => void, target: () => AnswerLinkTarget | null): {
  open: (link: AnswerLink) => void;
  flush: () => void;
} {
  let pending: AnswerLink | null = null;
  const flush = (): void => {
    if (!pending) return;
    showWindow();
    const contents = target();
    if (!contents || contents.isDestroyed()) return;
    const link = pending;
    pending = null;
    const send = (): void => { if (!contents.isDestroyed()) contents.send('answer-link:open', link); };
    if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send); else send();
  };
  return {
    open: link => {
      pending = link;
      flush();
    },
    flush
  };
}
