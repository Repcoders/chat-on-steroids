vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session.js';

// Project windows in the production Chat renderer: the project window's sidebar and the main
// window's composer for a chat whose project has its own window.
const P = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const Q = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const projects = [
  { id: P, name: 'Alpha', path: '/home/you/alpha', createdAt: 1 },
  { id: Q, name: 'Beta', path: '/home/you/beta', createdAt: 2 }
];

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

function summary(id: string, projectId: string | undefined, updatedAt: number): SessionSummary {
  return {
    id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`], startedAt: updatedAt - 1_000, updatedAt,
    endedAt: null, events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0,
    toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, ...(projectId ? { projectId } : {})
  } as SessionSummary;
}

const alpha = summary('2026-10-19-aaaaaaaa', P, 30_000);
const beta = summary('2026-10-19-bbbbbbbb', Q, 20_000);
const loose = summary('2026-10-19-cccccccc', undefined, 10_000);

async function boot(search: string, openWindows: string[]) {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: `https://local.test/${search}`, pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const opened: string[] = [];
  const api: any = new Proxy({
    listSessions: () => ok({ sessions: [alpha, beta, loose], activeId: null, pressure: [], total: 3, nextCursor: null }),
    listProjects: () => ok(projects),
    getSession: (id: string) => ok({ summary: [alpha, beta, loose].find(entry => entry.id === id), events: [], total: 0, nextFrom: 0 }),
    turnTraces: () => ok({}),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    openProjectWindow: (id: string) => { opened.push(id); return ok(true); },
    onSessionChanged: () => () => undefined,
    onSwarmChanged: () => () => undefined
  }, { get: (target, prop) => prop in target ? (target as any)[prop] : (..._args: any[]) => ok(null) });
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  const { chatVisible, initChat } = await import('../src/renderer/chat.js');
  initChat({
    save: async () => undefined,
    state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: {} }, projectWindows: openWindows }) as any
  });
  chatVisible(true);
  await vi.waitFor(() => expect(w.document.querySelector('#sessionList [data-id]')).not.toBeNull());
  const doc = w.document;
  return {
    doc, opened,
    rows: () => [...doc.querySelectorAll<HTMLElement>('#sessionList .sess[data-id]')].map(row => row.dataset.id),
    open: (id: string) => doc.querySelector<HTMLElement>(`#sessionList .sess[data-id="${id}"]`)!.click(),
    composer: () => doc.getElementById('composer')!,
    notice: () => doc.getElementById('projectWindowNotice')!
  };
}

it('lists only its own project\'s chats in a project window and writes new chats there', async () => {
  const f = await boot(`?project=${P}`, [P]);
  expect(f.rows()).toEqual([alpha.id]);
  expect([...f.doc.querySelectorAll<HTMLElement>('#projectList [data-project-id]')].map(group => group.dataset.projectId)).toEqual([P]);
  expect(f.doc.getElementById('chatsSection')!.hidden).toBe(true);
  // A new chat here is in the window's project, so its composer is the one that sends.
  expect(f.composer().hidden).toBe(false);
  expect(f.notice().hidden).toBe(true);
  expect(f.doc.title).toBe('Alpha');
});

it('offers no composer in the main window for a chat whose project has its own window', async () => {
  const f = await boot('', [P]);
  expect(f.rows()).toEqual(expect.arrayContaining([alpha.id, beta.id, loose.id]));
  expect(f.doc.getElementById('chatsSection')!.hidden).toBe(false);
  expect(f.composer().hidden).toBe(false);
  f.open(alpha.id);
  await vi.waitFor(() => expect(f.composer().hidden).toBe(true));
  expect(f.notice().hidden).toBe(false);
  expect(f.notice().textContent).toContain('This project is open in its own window.');
  const show = f.notice().querySelector('button')!;
  expect(show.hidden).toBe(false);
  show.click();
  expect(f.opened).toEqual([P]);
  // Another project's chat, and a chat in no project, keep this window's composer.
  f.open(beta.id);
  await vi.waitFor(() => expect(f.composer().hidden).toBe(false));
  expect(f.notice().hidden).toBe(true);
});
