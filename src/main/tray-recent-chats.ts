import type { MenuItemConstructorOptions } from 'electron';
import type { MainText } from '../shared/main-texts.js';
import type { SessionSummary } from '../shared/session.js';

/** How many chats the tray's Recent chats lists. */
export const TRAY_RECENT_CHATS = 5;
/** A native menu row does not wrap; a long ChatGPT title would widen the whole menu. */
const TITLE_CHARS = 48;

export interface TrayRecentChat {
  id: string;
  label: string;
}

/**
 * The newest chats the sidebar lists, as tray menu rows: sub-agents, helpers and unattributed
 * diagnostics rows stay out, as in the chat search's recent list.
 */
export function trayRecentChats(sessions: readonly SessionSummary[], limit = TRAY_RECENT_CHATS): TrayRecentChat[] {
  return sessions
    .filter(entry => entry.origin?.kind !== 'worker' && entry.origin?.kind !== 'helper' && (!!entry.conversationId || entry.origin?.kind === 'desktop'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(entry => ({ id: entry.id, label: trayChatLabel(entry.title) }));
}

/** One line, clipped, and with `&` doubled: native menus read a single `&` as a mnemonic marker and hide it. */
export function trayChatLabel(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  const clipped = chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join('').trimEnd()}…` : line;
  return clipped.replaceAll('&', '&&');
}

/** The menu is rebuilt only when this list changes, not on every recorded event. */
export function sameTrayRecentChats(a: readonly TrayRecentChat[], b: readonly TrayRecentChat[]): boolean {
  return a.length === b.length && a.every((chat, index) => chat.id === b[index]!.id && chat.label === b[index]!.label);
}

/** New chat, then Recent chats as a submenu once there is one. `open(null)` is New chat. */
export function trayChatItems(
  chats: readonly TrayRecentChat[],
  text: (source: MainText) => string,
  open: (sessionId: string | null) => void
): MenuItemConstructorOptions[] {
  return [
    { label: text('New chat'), click: () => open(null) },
    ...(chats.length ? [{
      label: text('Recent chats'),
      submenu: chats.map(chat => ({ label: chat.label || text('New chat'), click: () => open(chat.id) }))
    }] : [])
  ];
}
