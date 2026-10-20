import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionChange, SessionSummary } from '../src/shared/session.js';

const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  handlers: new Map<string, (...args: any[]) => unknown>(),
  listeners: new Map<string, (...args: any[]) => void>(),
  shortcuts: new Map<string, () => void>(),
  register: vi.fn(),
  unregister: vi.fn(),
  config: { ui: { quickAsk: false, theme: 'dark' } } as any,
  projects: [] as Array<{ id: string; name: string; path: string; createdAt: number; ungrouped?: boolean }>,
  send: vi.fn(),
  session: null as Partial<SessionSummary> | null,
  answer: null as string | null,
  sessionChange: null as ((change: SessionChange) => void) | null,
  catalog: { state: 'unknown', models: [] } as any,
  loading: false
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    visible = false;
    focused = false;
    dead = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 7, isDestroyed: () => false, isLoadingMainFrame: () => mocks.loading, isDevToolsOpened: () => false, send: vi.fn(),
      setWindowOpenHandler: vi.fn()
    });
    constructor(readonly options: Record<string, unknown>) { super(); mocks.windows.push(this); }
    isDestroyed() { return this.dead; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    hide() { this.visible = false; this.focused = false; }
    destroy() { this.dead = true; this.emit('closed'); }
    getSize() { return [560, 420]; }
    setPosition = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);
  }
  return {
    BrowserWindow: Window,
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => unknown) => mocks.handlers.set(name, handler),
      on: (name: string, listener: (...args: any[]) => void) => mocks.listeners.set(name, listener)
    },
    globalShortcut: {
      register: (accelerator: string, callback: () => void) => {
        mocks.register(accelerator);
        if (mocks.shortcuts.has(accelerator)) return false;
        mocks.shortcuts.set(accelerator, callback); return true;
      },
      unregister: (accelerator: string) => { mocks.unregister(accelerator); mocks.shortcuts.delete(accelerator); }
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } })
    }
  };
});
vi.mock('../src/main/config.js', () => ({ getConfig: () => mocks.config }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/chat-models.js', () => ({ getChatModels: () => mocks.catalog }));
vi.mock('../src/main/projects.js', () => ({ listProjects: async () => mocks.projects }));
vi.mock('../src/main/session/start-input.js', () => ({ sendDesktopInput: mocks.send }));
vi.mock('../src/main/session/recorder.js', () => ({
  onSessionChange: (listener: (change: SessionChange) => void) => { mocks.sessionChange = listener; return () => { mocks.sessionChange = null; }; }
}));
vi.mock('../src/main/session/store.js', () => ({
  getSession: async () => mocks.session,
  readRecentEvents: async () => mocks.answer === null ? [] : [{ kind: 'assistant_message', message: { text: mocks.answer, truncated: false, chars: mocks.answer.length }, final: true }]
}));
import { QUICK_ASK_SHORTCUT, setQuickAskShortcut, shutdownQuickAsk, startQuickAsk, toggleQuickAsk } from '../src/main/quick-ask.js';

const PROJECT = '6c0b1f9e-2a7d-4c3e-9f1a-000000000001';
const owner = { isDestroyed: () => false, webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false, send: vi.fn(), once: vi.fn() } };
const requestOwner = vi.fn();

beforeEach(() => {
  mocks.windows.length = 0; mocks.shortcuts.clear(); mocks.register.mockClear(); mocks.unregister.mockClear();
  mocks.send.mockReset(); owner.webContents.send.mockClear(); requestOwner.mockClear();
  mocks.config = { ui: { quickAsk: false, theme: 'dark' } };
  mocks.projects = [{ id: PROJECT, name: 'demo-app', path: '/home/you/demo-app', createdAt: 1 }];
  mocks.session = null; mocks.answer = null; mocks.catalog = { state: 'unknown', models: [] }; mocks.loading = false;
  mocks.send.mockImplementation(async (input: { id: string }) => ({ ...input, sessionId: input.id, state: 'queued', createdAt: Date.now() }));
});
afterEach(() => shutdownQuickAsk());

/** Press the shortcut and return the quick-ask window it opened. */
function press(): any {
  mocks.shortcuts.get(QUICK_ASK_SHORTCUT)!();
  return mocks.windows.at(-1);
}

it('holds the global shortcut only while quick ask is on and reports one another app holds', () => {
  startQuickAsk(() => owner as any, requestOwner);
  expect(mocks.register).not.toHaveBeenCalled();
  setQuickAskShortcut(true);
  expect(mocks.register).toHaveBeenCalledWith(QUICK_ASK_SHORTCUT);
  setQuickAskShortcut(false);
  expect(mocks.unregister).toHaveBeenCalledWith(QUICK_ASK_SHORTCUT);
  expect(mocks.shortcuts.size).toBe(0);
  mocks.shortcuts.set(QUICK_ASK_SHORTCUT, () => undefined);
  expect(() => setQuickAskShortcut(true)).toThrow(/another app already uses it/);
});

it('opens a sandboxed window and toggles it with the shortcut', () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(win.isVisible()).toBe(true);
  expect(win.webContents.send).toHaveBeenCalledWith('quick-ask:shown');
  press();
  expect(win.isVisible()).toBe(false);
  expect(mocks.windows).toHaveLength(1);
});

it('starts a new chat in the chosen project through the composer send path, for its own window only', async () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const send = mocks.handlers.get('quick-ask:send')!;
  expect(await send({ sender: { id: 99 } }, { text: 'Hi', projectId: null })).toEqual({ ok: false, error: 'Not allowed' });
  const reply = await send({ sender: win.webContents }, { text: '  Why does the build fail?  ', projectId: PROJECT }) as any;
  expect(reply.ok).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const input = mocks.send.mock.calls[0]![0];
  expect(input).toMatchObject({ sessionId: null, projectId: PROJECT, text: 'Why does the build fail?', mode: 'auto', model: null, reasoningEffort: null, authoredSource: 'text' });
  expect(reply.data).toEqual({ sessionId: input.id, error: null });
  // A project the sidebar no longer shows is not a place for a new chat.
  mocks.projects[0]!.ungrouped = true;
  expect(await send({ sender: win.webContents }, { text: 'Again', projectId: PROJECT })).toMatchObject({ ok: false });
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('shows the finished answer once the turn ends, and opens the chat in the main window', async () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const reply = await mocks.handlers.get('quick-ask:send')!({ sender: win.webContents }, { text: 'Explain HTTPS', projectId: null }) as any;
  const sessionId = reply.data.sessionId as string;
  const answers = () => win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'quick-ask:answer');
  // Still answering: nothing yet.
  mocks.session = { id: sessionId, activeTurnId: 'turn-1', lastTurnEndAt: null, lastTurnOutcome: null };
  mocks.sessionChange!({ sessionIds: [sessionId] });
  await new Promise(resolve => setTimeout(resolve, 0));
  // A fresh turn for long work ends the first one as interrupted; the answer is still coming.
  mocks.session = { id: sessionId, activeTurnId: null, lastTurnEndAt: Date.now() + 1, lastTurnOutcome: 'interrupted' };
  mocks.sessionChange!({ sessionIds: [sessionId] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(answers()).toHaveLength(0);
  mocks.session = { id: sessionId, activeTurnId: null, lastTurnEndAt: Date.now() + 1, lastTurnOutcome: 'completed' };
  mocks.answer = 'HTTPS is **HTTP** over TLS.';
  mocks.sessionChange!({ sessionIds: ['someone-else'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(answers()).toHaveLength(0);
  mocks.sessionChange!({ sessionIds: [sessionId] });
  await vi.waitFor(() => expect(answers()).toEqual([['quick-ask:answer', { sessionId, text: 'HTTPS is **HTTP** over TLS.' }]]));
  mocks.listeners.get('quick-ask:openChat')!({ sender: win.webContents }, { sessionId });
  expect(requestOwner).toHaveBeenCalled();
  expect(owner.webContents.send).toHaveBeenCalledWith('session:write', sessionId);
  expect(win.isVisible()).toBe(false);
});

it('says a turn that stopped without an answer ended that way', async () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const reply = await mocks.handlers.get('quick-ask:send')!({ sender: win.webContents }, { text: 'Explain HTTPS', projectId: null }) as any;
  const sessionId = reply.data.sessionId as string;
  mocks.session = { id: sessionId, activeTurnId: null, lastTurnEndAt: Date.now() + 1, lastTurnOutcome: 'stopped' };
  mocks.sessionChange!({ sessionIds: [sessionId] });
  await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalledWith('quick-ask:answer', { sessionId, text: null }));
});

it('opens nothing once shut down, so a press while the app quits cannot hold the quit open', () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const callback = mocks.shortcuts.get(QUICK_ASK_SHORTCUT)!;
  shutdownQuickAsk();
  expect(mocks.shortcuts.has(QUICK_ASK_SHORTCUT)).toBe(false);
  // A press Electron had already queued before the release.
  callback(); toggleQuickAsk();
  expect(mocks.windows).toHaveLength(0);
});

it('sends with the composer default model, and High when no effort was saved', async () => {
  mocks.config.ui.quickAsk = true;
  mocks.catalog = { state: 'ready', models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['medium', 'high'] }, { id: 'gpt-5.6', label: 'GPT-5.6', efforts: ['low', 'medium'] }] };
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const send = mocks.handlers.get('quick-ask:send')!;
  const sent = () => mocks.send.mock.calls.at(-1)![0];
  mocks.config.ui.defaultChatModel = 'gpt-6'; mocks.config.ui.defaultChatReasoning = 'medium';
  await send({ sender: win.webContents }, { text: 'One', projectId: null });
  expect(sent()).toMatchObject({ model: 'gpt-6', reasoningEffort: 'medium' });
  delete mocks.config.ui.defaultChatReasoning;
  await send({ sender: win.webContents }, { text: 'Two', projectId: null });
  expect(sent()).toMatchObject({ model: 'gpt-6', reasoningEffort: 'high' });
  mocks.config.ui.defaultChatModel = 'gpt-5.6';
  await send({ sender: win.webContents }, { text: 'Three', projectId: null });
  expect(sent()).toMatchObject({ model: 'gpt-5.6', reasoningEffort: 'low' });
  // A saved effort the model no longer offers leaves the choice to ChatGPT, as before.
  mocks.config.ui.defaultChatReasoning = 'high';
  await send({ sender: win.webContents }, { text: 'Four', projectId: null });
  expect(sent()).toMatchObject({ model: null, reasoningEffort: null });
});

it('opens nothing for a press that arrives after the setting was turned off', () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const callback = mocks.shortcuts.get(QUICK_ASK_SHORTCUT)!;
  setQuickAskShortcut(false);
  callback();
  expect(mocks.windows).toHaveLength(0);
});

it('does not show a window still loading when the setting is turned off', () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  mocks.loading = true;
  const win = press();
  setQuickAskShortcut(false);
  win.webContents.emit('did-finish-load');
  expect(win.isVisible()).toBe(false);
});

it('does not show an earlier answer once a newer question is being sent', async () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const send = mocks.handlers.get('quick-ask:send')!;
  const first = await send({ sender: win.webContents }, { text: 'First', projectId: null }) as any;
  // The newer question is still being admitted when the earlier chat finishes.
  let admit!: () => void;
  mocks.send.mockImplementationOnce(() => new Promise(resolve => { admit = () => resolve({ id: 'second', sessionId: 'second', state: 'queued', createdAt: Date.now() } as any); }));
  const second = send({ sender: win.webContents }, { text: 'Second', projectId: null });
  mocks.session = { id: first.data.sessionId, activeTurnId: null, lastTurnEndAt: Date.now() + 1, lastTurnOutcome: 'completed' };
  mocks.answer = 'The first answer';
  mocks.sessionChange!({ sessionIds: [first.data.sessionId] });
  await new Promise(resolve => setTimeout(resolve, 0));
  admit();
  await second;
  expect(win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'quick-ask:answer')).toHaveLength(0);
});

it('opens only the chat that quick ask started', async () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  const win = press();
  const reply = await mocks.handlers.get('quick-ask:send')!({ sender: win.webContents }, { text: 'Hi', projectId: null }) as any;
  mocks.listeners.get('quick-ask:openChat')!({ sender: win.webContents }, { sessionId: 'a0b1c2d3-other-chat' });
  expect(owner.webContents.send).not.toHaveBeenCalled();
  mocks.listeners.get('quick-ask:openChat')!({ sender: win.webContents }, { sessionId: reply.data.sessionId });
  expect(owner.webContents.send).toHaveBeenCalledWith('session:write', reply.data.sessionId);
});

it('does not register the shortcut for a setting saved after shutdown began', () => {
  mocks.config.ui.quickAsk = true;
  startQuickAsk(() => owner as any, requestOwner);
  shutdownQuickAsk();
  mocks.register.mockClear();
  setQuickAskShortcut(true);
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.shortcuts.size).toBe(0);
});
