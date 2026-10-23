import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session.js';

const { on, removeListener, expose } = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke: vi.fn(), on, removeListener },
  webUtils: { getPathForFile: vi.fn() }
}));

import { openTrayChat, readTrayRecentChats, sameTrayRecentChats, trayChatItems, trayChatLabel, trayRecentChats } from '../src/main/tray-recent-chats.js';

const chat = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: `Chat ${id}`, conversationId: `conv-${id}`, origin: { kind: 'desktop' }, updatedAt, ...extra }) as SessionSummary;

it('lists the five newest chats the sidebar shows, without sub-agents, helpers or unattributed rows', () => {
  const sessions = [
    chat('a', 1), chat('b', 7), chat('c', 3), chat('d', 5), chat('e', 2), chat('f', 6),
    chat('worker', 9, { origin: { kind: 'worker', fromSessionId: 'b', agentId: 'worker-1', task: 'Inspect' } } as Partial<SessionSummary>),
    chat('helper', 9, { origin: { kind: 'helper' } } as Partial<SessionSummary>),
    chat('unattributed', 9, { conversationId: null, origin: null }),
    chat('opening', 8, { conversationId: null })
  ];
  expect(trayRecentChats(sessions).map(row => row.id)).toEqual(['opening', 'b', 'f', 'd', 'c']);
  expect(trayRecentChats(sessions, 2).map(row => row.label)).toEqual(['Chat opening', 'Chat b']);
});

it('reads only the page the sidebar loads first, so a picked chat is one the window has', async () => {
  const listPage = vi.fn(async (_options: { limit: number }) => ({ sessions: [chat('a', 1)] }));
  expect(await readTrayRecentChats(listPage)).toEqual([{ id: 'a', label: 'Chat a' }]);
  const sidebarPage = Number(/const SESSION_PAGE_SIZE = (\d+);/.exec(readFileSync('src/renderer/chat.ts', 'utf8'))![1]);
  expect(listPage).toHaveBeenCalledWith({ limit: sidebarPage });
});

it('puts a title on one clipped line and keeps a literal ampersand', () => {
  expect(trayChatLabel('  Fix\nthe   build  ')).toBe('Fix the build');
  expect(trayChatLabel('Q&A notes')).toBe('Q&&A notes');
  const long = trayChatLabel(`${'word '.repeat(20)}end`);
  expect(Array.from(long)).toHaveLength(48);
  expect(long.endsWith('…')).toBe(true);
  // Clipping counts characters, so an emoji is never cut in half.
  expect(trayChatLabel('😀'.repeat(60)).replace('…', '')).toBe('😀'.repeat(47));
});

it('rebuilds the menu only when the listed chats or their titles change', () => {
  const rows = trayRecentChats([chat('a', 2), chat('b', 1)]);
  expect(sameTrayRecentChats(rows, trayRecentChats([chat('a', 4), chat('b', 3)]))).toBe(true);
  expect(sameTrayRecentChats(rows, trayRecentChats([chat('b', 4), chat('a', 3)]))).toBe(false);
  expect(sameTrayRecentChats(rows, trayRecentChats([chat('a', 2, { title: 'Renamed' }), chat('b', 1)]))).toBe(false);
  expect(sameTrayRecentChats(rows, trayRecentChats([chat('a', 2)]))).toBe(false);
});

it('offers New chat and a Recent chats submenu that open their chat in the window', () => {
  const open = vi.fn();
  const text = (source: string) => `«${source}»`;
  const items = trayChatItems(trayRecentChats([chat('a', 2), chat('b', 1, { title: '' })]), text, open);
  expect(items.map(item => item.label)).toEqual(['«New chat»', '«Recent chats»']);
  const submenu = items[1]!.submenu as Array<{ label: string; click: () => void }>;
  expect(submenu.map(item => item.label)).toEqual(['Chat a', '«New chat»']);
  submenu[1]!.click();
  (items[0]!.click as () => void)();
  expect(open.mock.calls).toEqual([['b'], [null]]);
  // No chats yet: New chat alone, no empty submenu.
  expect(trayChatItems([], text, open).map(item => item.label)).toEqual(['«New chat»']);
});

it('hands the tray choice to the renderer over chat:open', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const listener = vi.fn();
  const stop = api.onOpenChat(listener);
  const [, wrapped] = on.mock.calls.find(([name]) => name === 'chat:open')!;
  wrapped({}, 'session-a');
  wrapped({}, null);
  expect(listener.mock.calls).toEqual([['session-a'], [null]]);
  stop();
  expect(removeListener).toHaveBeenCalledWith('chat:open', wrapped);
});

it('opens nothing once quit has begun, also when the page finishes loading after it', () => {
  const send = vi.fn();
  let loaded: (() => void) | undefined;
  let loading = false;
  const target = { isDestroyed: () => false, isLoadingMainFrame: () => loading, once: (_name: string, fn: () => void) => { loaded = fn; }, send };
  let allowed = true;
  const show = vi.fn();
  const window = { allowed: () => allowed, show, contents: () => target as never };

  openTrayChat(window, 'session-a');
  expect(show).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('chat:open', 'session-a');

  loading = true;
  openTrayChat(window, null);
  allowed = false;
  loaded!();
  openTrayChat(window, 'session-b');
  expect(show).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(1);
});
