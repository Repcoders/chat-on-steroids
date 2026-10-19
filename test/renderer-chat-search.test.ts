import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSearchReply } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(chatOpen = true) {
  dom = new JSDOM(readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8'), { url: 'https://local.test', pretendToBeVisual: true });
  const win = dom.window;
  // The dialog closes as a browser does: open turns false, then the close event arrives as a task.
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; setTimeout(() => this.dispatchEvent(new win.Event('close')), 0); };
  win.HTMLElement.prototype.scrollIntoView = () => undefined;
  const reply: SessionSearchReply = { results: [{ id: 'chat-1', title: 'Rename the release branch', projectId: null, titleMatches: [[0, 6]] }], indexed: 1, total: 1 };
  Object.assign(win, { api: { searchSessions: vi.fn(async () => ({ ok: true, data: reply })) } });
  vi.stubGlobal('window', win); vi.stubGlobal('document', win.document);
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const { APP_COMMANDS } = await import('../src/renderer/skills.js');
  const { initChatSearch } = await import('../src/renderer/chat-search.js');
  const calls: string[] = [];
  const search = initChatSearch({
    select: id => calls.push(`chat ${id}`),
    selectedId: () => null,
    recent: () => [],
    commands: () => APP_COMMANDS.filter(row => chatOpen || row.command !== 'rename'),
    // Recorded with the dialog's state: a command focuses what the open dialog keeps inert.
    runCommand: name => calls.push(`command ${name} ${(win.document.getElementById('searchDialog') as HTMLDialogElement).open ? 'open' : 'closed'}`),
    openSettings: tab => calls.push(`settings ${tab}`)
  });
  const type = async (text: string) => {
    const field = win.document.getElementById('chatSearch') as HTMLInputElement;
    field.value = text;
    field.dispatchEvent(new win.Event('input'));
    await pause(250);
  };
  const groups = () => [...win.document.querySelectorAll('#searchResults > *')].map(node => node.classList.contains('search-list')
    ? [...node.querySelectorAll('.search-result')].map(row => [...row.children].map(part => part.textContent).join(' | '))
    : node.textContent);
  return { win, search, calls, type, groups };
}

it('finds commands by name or slash command, names that start with the query first', async () => {
  await mount();
  const { APP_COMMANDS } = await import('../src/renderer/skills.js');
  const { searchCommands } = await import('../src/renderer/chat-search.js');
  expect(searchCommands(APP_COMMANDS, 're').map(row => row.command)).toEqual(['reasoning', 'rename', 'review']);
  expect(searchCommands(APP_COMMANDS, 'chat new').map(row => row.command)).toEqual(['new']);
  expect(searchCommands(APP_COMMANDS, 'feed').map(row => row.command)).toEqual(['feedback']);
  expect(searchCommands(APP_COMMANDS, '   ')).toEqual([]);
});

it('lists matching commands below the chats and runs one once the dialog has closed', async () => {
  const { win, search, calls, type, groups } = await mount();
  search.open();
  await type('rename');
  expect(groups()).toEqual([
    ['Rename the release branch'],
    'Commands',
    ['Rename | Rename this chat in the app.']
  ]);
  // Enter still opens the first chat, never a command.
  expect(win.document.querySelector('#searchResults .search-result')!.getAttribute('data-search-id')).toBe('chat-1');
  win.document.querySelectorAll<HTMLButtonElement>('#searchResults .search-result')[1]!.click();
  expect(calls).toEqual([]);
  await pause(20);
  expect(calls).toEqual(['command rename closed']);
});

it('leaves out commands that cannot run now', async () => {
  const { search, type, groups } = await mount(false);
  search.open();
  await type('rename');
  expect(groups()).toEqual([['Rename the release branch']]);
});

it('finds settings by the same query and opens the one picked at its place', async () => {
  const { win, search, calls, type, groups } = await mount();
  search.open();
  await type('bridge port');
  const shown = groups();
  expect(shown.slice(0, 2)).toEqual([['Rename the release branch'], 'Settings']);
  expect(shown[2]).toContainEqual(expect.stringMatching(/^Browser bridge port \| /));
  const row = [...win.document.querySelectorAll<HTMLButtonElement>('#searchResults .search-result')].find(node => node.textContent!.startsWith('Browser bridge port'))!;
  expect(row.querySelector('mark')?.textContent).toBe('bridge');
  row.click();
  await pause(60);
  expect(calls).toEqual([expect.stringMatching(/^settings /)]);
  expect(win.document.getElementById('browserBridgePort')!.closest('.setting')!.classList.contains('is-found')).toBe(true);
});

it('keeps the keyboard on the row it was on when a running chat repaints the results', async () => {
  const { win, search, type } = await mount();
  search.open();
  await type('usage');
  const usage = () => [...win.document.querySelectorAll<HTMLButtonElement>('#searchResults .search-result')].find(node => node.textContent!.startsWith('Usage'))!;
  const before = usage();
  before.focus();
  // The same query again repaints, as a running chat's refresh does.
  await type('usage');
  expect(usage()).not.toBe(before);
  expect(win.document.activeElement).toBe(usage());
});
