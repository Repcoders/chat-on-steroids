import { isMac } from './shortcuts.js';

type PickKeys = Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/**
 * What a click (or, with `keyboard`, Space) on a chat does to the picks. A click toggles with the
 * platform's own modifier: Cmd on macOS, where Ctrl-click is a right click that opens the chat's
 * menu, and Ctrl elsewhere. Space takes either, since the keyboard has no such clash and Cmd+Space
 * is usually Spotlight. Shift adds the run; Alt, and the other platform's modifier, pick nothing.
 */
export function pickGesture(event: PickKeys, keyboard = false): 'toggle' | 'extend' | null {
  const mac = isMac();
  const primary = keyboard ? event.ctrlKey || event.metaKey : mac ? event.metaKey : event.ctrlKey;
  const foreign = !keyboard && (mac ? event.ctrlKey : event.metaKey);
  if (event.altKey || foreign) return null;
  return event.shiftKey ? 'extend' : primary ? 'toggle' : null;
}

/**
 * Chats picked in the sidebar for one action on all of them: Cmd-click (Ctrl-click off macOS) toggles a chat,
 * Shift-click adds the run from the last picked chat. Presentation only and never saved: the
 * open chat is not changed by picking, and each action goes through the same owner as its
 * row-menu item.
 */
export function createSidebarSelection() {
  const picked = new Set<string>();
  let anchor: string | null = null;
  /** The first pick of a selection also takes the open chat, as a file list keeps its current item. */
  function start(id: string, open: string | null, order: readonly string[]): void {
    if (picked.size || !open || open === id || !order.includes(open)) return;
    picked.add(open);
    anchor = open;
  }
  return {
    has: (id: string): boolean => picked.has(id),
    get size(): number { return picked.size; },
    /** The picked chats in sidebar order. */
    ids: (order: readonly string[]): string[] => order.filter(id => picked.has(id)),
    toggle(id: string, open: string | null, order: readonly string[]): void {
      start(id, open, order);
      if (picked.delete(id)) return;
      picked.add(id);
      anchor = id;
    },
    /** Adds every chat from the last picked one to `id`, in sidebar order. */
    extend(id: string, open: string | null, order: readonly string[]): void {
      start(id, open, order);
      const from = anchor && order.includes(anchor) ? order.indexOf(anchor) : order.indexOf(id);
      const to = order.indexOf(id);
      if (to < 0) return;
      for (const each of order.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(each);
      anchor ??= id;
    },
    /** Drops chats no longer shown, so an action never reaches a row the user cannot see. */
    keep(order: readonly string[]): boolean {
      const shown = new Set(order);
      const before = picked.size;
      for (const id of picked) if (!shown.has(id)) picked.delete(id);
      if (anchor && !picked.has(anchor)) anchor = null;
      return picked.size !== before;
    },
    clear(): boolean {
      const had = picked.size > 0;
      picked.clear();
      anchor = null;
      return had;
    }
  };
}
