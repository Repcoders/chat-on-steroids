import type { MenuItemConstructorOptions, WebContents } from 'electron';
import type { MainText } from '../shared/main-texts.js';
import type { SessionSummary } from '../shared/session.js';

/** How many chats the tray's Recent chats lists. */
export const TRAY_RECENT_CHATS = 5;
/** A native menu row does not wrap; a long ChatGPT title would widen the whole menu. */
const TITLE_CHARS = 48;
/** The sidebar's first page (`sessions:list` and the renderer's SESSION_PAGE_SIZE). */
export const SIDEBAR_FIRST_PAGE = 60;

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

/**
 * Reads the same newest page the sidebar loads first. A chat beyond it would not be in the
 * window's list, and the sidebar's next refresh would drop the selection again.
 */
export async function readTrayRecentChats(
  listPage: (options: { limit: number }) => Promise<{ sessions: SessionSummary[] }>
): Promise<TrayRecentChat[]> {
  return trayRecentChats((await listPage({ limit: SIDEBAR_FIRST_PAGE })).sessions);
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

export interface TrayChatWindow {
  /** False once quit has begun or window activation is otherwise refused. */
  allowed(): boolean;
  /** Shows the window through the activation gate, creating it when there is none. */
  show(): void;
  contents(): Pick<WebContents, 'isDestroyed' | 'isLoadingMainFrame' | 'once' | 'send'> | null;
}

/** Shows the window and opens a chat in it: a session id, or `null` for New chat. */
export function openTrayChat(window: TrayChatWindow, sessionId: string | null): void {
  if (!window.allowed()) return;
  window.show();
  const target = window.contents();
  if (!target) return;
  const open = (): void => { if (window.allowed() && !target.isDestroyed()) target.send('chat:open', sessionId); };
  if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
}
