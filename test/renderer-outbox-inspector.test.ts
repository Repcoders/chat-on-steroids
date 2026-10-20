vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { InputEntry } from '../src/main/session/input.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

let ids = 0;
const row = (fields: Partial<InputEntry>): InputEntry => ({
  id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, sessionId: 'chat-a', projectId: null, text: 'Placeholder message',
  mode: 'auto', state: 'queued', owner: null, conversationId: null, createdAt: ids, dueAt: 0, model: null, reasoningEffort: null,
  ...fields
}) as InputEntry;

async function mount(start: InputEntry[], findChat: (id: string) => Promise<{ id: string; title: string } | null> = async () => null) {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('navigator', { platform: 'Win32', language: 'en', languages: ['en'] });
  const doc = dom.window.document;
  let entries = start;
  const calls: string[] = [];
  const titles: Record<string, string> = { 'chat-a': 'Placeholder chat A', 'chat-b': 'Placeholder chat B' };
  const { createOutboxInspector } = await import('../src/renderer/outbox-inspector.js');
  const inspector = createOutboxInspector({
    entries: () => entries,
    refresh: () => calls.push('refresh'),
    chat: id => titles[id] ? { id, title: titles[id]! } : undefined,
    findChat,
    status: entry => entry.error ?? `status of ${entry.text}`,
    notice: entry => !!entry.error && !entry.text.includes('dismissed'),
    cancel: async id => { calls.push(`cancel ${id}`); return true; },
    retryBrowser: async id => { calls.push(`retry ${id}`); },
    open: id => calls.push(`open ${id}`)
  });
  const rows = () => [...doc.querySelectorAll<HTMLElement>('.outbox-row')].map(node => [
    node.querySelector('.outbox-chat')!.textContent,
    node.querySelector('.outbox-text')!.textContent,
    node.querySelector('.outbox-status')!.textContent,
    [...node.querySelectorAll('.outbox-action')].map(button => button.textContent)
  ]);
  const button = (text: string, label: string) => {
    const node = [...doc.querySelectorAll<HTMLElement>('.outbox-row')].find(item => item.querySelector('.outbox-text')!.textContent === text)!;
    return [...node.querySelectorAll<HTMLButtonElement>('.outbox-action')].find(action => action.textContent === label)!;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { doc, inspector, rows, button, calls, settle, set: (next: InputEntry[]) => { entries = next; } };
}

it('lists the waiting messages of every chat with what each waits for, then the notices still shown', async () => {
  const view = await mount([
    row({ text: 'Failed in chat B', sessionId: 'chat-b', state: 'failed', error: 'Delivery failed placeholder', createdAt: 1 }),
    row({ text: 'Queued in chat A', sessionId: 'chat-a', createdAt: 2 }),
    row({ text: 'Already sent', sessionId: 'chat-a', state: 'sent', createdAt: 3 }),
    row({ text: 'Queued in chat B', sessionId: 'chat-b', createdAt: 4 }),
    row({ text: 'Cancelled by you', sessionId: 'chat-b', state: 'cancelled', createdAt: 5 }),
    row({ text: 'Notice dismissed', sessionId: 'chat-b', state: 'cancelled', error: 'Old notice', createdAt: 6 }),
    row({ text: 'Opening a new chat', sessionId: 'chat-new', opening: true, state: 'browser', createdAt: 7 }),
    row({ text: 'Awaiting receipt', sessionId: 'chat-a', state: 'tool', createdAt: 8 }),
    row({ text: 'Follow-up in chat A', sessionId: 'chat-a', mode: 'after-turn', createdAt: 9 })
  ]);
  view.inspector.open();
  const dialog = view.doc.querySelector('dialog.outbox-dialog')!;
  expect(dialog.querySelector('h2')!.textContent).toBe('Outbox');
  // Waiting rows first, oldest first, whatever chat is selected; sent rows and your own cancellations stay out.
  expect(view.rows()).toEqual([
    ['Placeholder chat A', 'Queued in chat A', 'status of Queued in chat A', ['Cancel delivery']],
    ['Placeholder chat B', 'Queued in chat B', 'status of Queued in chat B', ['Cancel delivery']],
    ['New chat', 'Opening a new chat', 'status of Opening a new chat', ['Cancel delivery']],
    ['Placeholder chat A', 'Awaiting receipt', 'status of Awaiting receipt', []],
    ['Placeholder chat A', 'Follow-up in chat A', 'status of Follow-up in chat A', ['Remove queued task']],
    ['Placeholder chat B', 'Failed in chat B', 'Delivery failed placeholder', ['Dismiss delivery notice']]
  ]);
  expect(view.doc.querySelector<HTMLElement>('.outbox-empty')!.hidden).toBe(true);
  // Opening reads the outbox again, so the list is not the window's last, possibly older, read.
  expect(view.calls).toEqual(['refresh']);
});

it('cancels through the chat queue\'s own action, and the next read repaints the list', async () => {
  const kept = row({ text: 'Queued in chat B', sessionId: 'chat-b' });
  const cancelled = row({ text: 'Queued in chat A', sessionId: 'chat-a' });
  const view = await mount([cancelled, kept]);
  view.inspector.open();
  const keptNode = view.doc.querySelector(`[data-input-id="${kept.id}"]`);
  view.button('Queued in chat A', 'Cancel delivery').click();
  await view.settle();
  expect(view.calls).toEqual(['refresh', `cancel ${cancelled.id}`, 'refresh']);
  // The chat queue's refresh repaints the inspector from its read.
  view.set([{ ...cancelled, state: 'cancelled', cancelledByUser: true }, kept]);
  view.inspector.update();
  expect(view.rows().map(([, text]) => text)).toEqual(['Queued in chat B']);
  // An unchanged row keeps its node, so focus on it survives the frequent repaints.
  expect(view.doc.querySelector(`[data-input-id="${kept.id}"]`)).toBe(keptNode);
  view.set([{ ...kept, state: 'sent' }]);
  view.inspector.update();
  expect(view.rows()).toEqual([]);
  expect(view.doc.querySelector<HTMLElement>('.outbox-empty')!.hidden).toBe(false);
  expect(view.doc.querySelector('.outbox-empty')!.textContent).toBe('Nothing is waiting to be sent.');
});

it('offers Retry browser only where the chat queue does, and opens a row\'s chat', async () => {
  const startup = row({ text: 'Browser did not start', sessionId: 'chat-b', error: 'Message queued. Browser startup failed: placeholder' });
  const view = await mount([startup, row({ text: 'Other error', sessionId: 'chat-a', error: 'Some other placeholder error' })]);
  view.inspector.open();
  expect(view.rows().map(([, text, , actions]) => [text, actions])).toEqual([
    ['Browser did not start', ['Cancel delivery', 'Retry browser']],
    ['Other error', ['Cancel delivery']]
  ]);
  view.button('Browser did not start', 'Retry browser').click();
  await view.settle();
  expect(view.calls).toContain(`retry ${startup.id}`);
  view.doc.querySelector<HTMLButtonElement>(`[data-input-id="${startup.id}"] button.outbox-chat`)!.click();
  expect(view.calls.at(-1)).toBe('open chat-b');
  expect(view.doc.querySelector('dialog.outbox-dialog')).toBeNull();
  // A closed inspector paints nothing.
  view.inspector.update();
  expect(view.doc.querySelector('.outbox-row')).toBeNull();
});

it('names a chat the sidebar has not loaded after reading it, and reads it again when a read fails', async () => {
  const reads: string[] = [];
  let fail = true;
  const older = row({ text: 'Queued in an older chat', sessionId: 'chat-old' });
  const view = await mount([older], async id => {
    reads.push(id);
    if (fail) throw new Error('read failed');
    return { id, title: 'Placeholder older chat' };
  });
  view.inspector.open();
  await view.settle();
  expect(view.rows().map(([chat]) => chat)).toEqual(['New chat']);
  // A failed read is not kept: the next repaint asks again, once.
  fail = false;
  view.inspector.update();
  view.inspector.update();
  await view.settle();
  expect(reads).toEqual(['chat-old', 'chat-old']);
  expect(view.rows().map(([chat]) => chat)).toEqual(['Placeholder older chat']);
  view.inspector.update();
  expect(reads).toHaveLength(2);
  view.doc.querySelector<HTMLButtonElement>('button.outbox-chat')!.click();
  expect(view.calls.at(-1)).toBe('open chat-old');
});

/** The production chat renderer with one recent chat on the first sidebar page and an older one beyond it. */
async function mountChat(inputs: InputEntry[], held: string[] = []) {
  dom = new JSDOM(await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'), { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'Event']) vi.stubGlobal(name, name === 'window' ? w : name === 'document' ? w.document : (w as any)[name]);
  (w.HTMLElement.prototype as any).scrollIntoView ??= () => {};
  const chat = (id: string, title: string, updatedAt: number): SessionSummary => ({
    id, title, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`], startedAt: updatedAt - 1_000, updatedAt, endedAt: null,
    events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  });
  const recent = chat(RECENT, 'Placeholder recent chat', 50_000);
  const older = chat(OLDER, 'Placeholder older chat', 10_000);
  const state = { lists: 0, changed: () => {} };
  const ok = (data: unknown) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy({
    // The first page holds only the recent chat; the older one lies on a page not read yet.
    listSessions: () => { state.lists++; return ok({ sessions: [recent], activeId: null, pressure: [], total: 2, nextCursor: { updatedAt: recent.updatedAt, id: recent.id }, blocked: [] }); },
    listInputs: () => ok([...inputs]),
    cancelInput: (id: string) => {
      const index = inputs.findIndex(entry => entry.id === id);
      if (index >= 0) inputs.splice(index, 1);
      return ok(index >= 0);
    },
    // A held chat's detail never arrives, as while a slow read is still on its way.
    getSession: (id: string) => held.includes(id) ? new Promise(() => {}) : ok({ summary: [recent, older].find(entry => entry.id === id), events: [], total: 0, nextFrom: 0 }),
    turnTraces: () => ok({}),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onSessionChanged: (listener: () => void) => { state.changed = listener; return () => undefined; },
    onSwarmChanged: () => () => undefined
  }, { get: (target, prop) => prop in target ? (target as any)[prop] : () => ok(null) });
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  const { chatVisible, initChat, openOutbox } = await import('../src/renderer/chat.js');
  initChat({ save: async () => undefined,
    state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: {} } }) as any });
  chatVisible(true);
  await vi.waitFor(() => expect(w.document.querySelector(`#sessionList [data-id="${recent.id}"]`)).not.toBeNull());
  return { w, state, openOutbox };
}
const RECENT = '2026-10-01-aaaaaaaa';
const OLDER = '2026-01-01-bbbbbbbb';

it('opens a chat older than the loaded sidebar page as a chat of the sidebar, and a refresh keeps it open', async () => {
  const { w, state, openOutbox } = await mountChat([row({ text: 'Queued in the older chat', sessionId: OLDER })]);
  openOutbox();
  await vi.waitFor(() => expect(w.document.querySelector('.outbox-row .outbox-chat')?.textContent).toBe('Placeholder older chat'));
  w.document.querySelector<HTMLButtonElement>('.outbox-row button.outbox-chat')!.click();
  // The chat opens under its own name and is listed in the sidebar, as an older page would list it.
  await vi.waitFor(() => expect(w.document.getElementById('chatTitle')!.textContent).toBe('Placeholder older chat'));
  expect(w.document.querySelector(`#sessionList [data-id="${OLDER}"]`)).not.toBeNull();
  // The next catalog refresh reads only the newest page again; the opened chat stays open.
  const before = state.lists;
  state.changed();
  await vi.waitFor(() => expect(state.lists).toBe(before + 1), { timeout: 1600 });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Placeholder older chat');
  expect(w.document.querySelector(`#sessionList [data-id="${OLDER}"]`)).not.toBeNull();
});

it("lists only the notices a chat queue shows with a Dismiss, by the chat queue's own rule", async () => {
  const { w, openOutbox } = await mountChat([
    row({ text: 'Not confirmed, no notice', sessionId: RECENT, state: 'failed' }),
    row({ text: 'Failed follow-up decision', sessionId: RECENT, state: 'failed', purpose: 'decision', error: 'Placeholder decision error' }),
    row({ text: 'Failed with a notice', sessionId: RECENT, state: 'failed', error: 'Placeholder delivery error' })
  ]);
  openOutbox();
  await vi.waitFor(() => expect(w.document.querySelector('.outbox-row')).not.toBeNull());
  await new Promise(resolve => setTimeout(resolve, 50));
  expect([...w.document.querySelectorAll('.outbox-row .outbox-text')].map(node => node.textContent)).toEqual(['Failed with a notice']);
});

it('repaints the Outbox after a cancel while the open chat is still loading', async () => {
  const inputs = [row({ text: 'First queued', sessionId: RECENT }), row({ text: 'Second queued', sessionId: RECENT })];
  const { w, openOutbox } = await mountChat(inputs, [RECENT]);
  w.document.querySelector<HTMLElement>(`#sessionList [data-id="${RECENT}"]`)!.click();
  await vi.waitFor(() => expect(w.document.getElementById('chatTitle')!.textContent).toBe('Placeholder recent chat'));
  expect(w.document.getElementById('inputQueue')!.hasAttribute('inert')).toBe(true);
  openOutbox();
  const texts = () => [...w.document.querySelectorAll('.outbox-row .outbox-text')].map(node => node.textContent);
  await vi.waitFor(() => expect(texts()).toEqual(['First queued', 'Second queued']));
  w.document.querySelector<HTMLButtonElement>('.outbox-row .outbox-action')!.click();
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  await vi.waitFor(() => expect(texts()).toEqual(['Second queued']));
});
