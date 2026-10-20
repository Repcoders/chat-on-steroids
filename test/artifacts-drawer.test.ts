import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionArtifact, SessionArtifactsReply } from '../src/shared/answer-artifacts.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<div id="dock"></div>', { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

const at = (seq: number) => ({ seq, kind: 'assistant_message' as const, messageId: `m${seq}`, position: seq });
const code = Array.from({ length: 12 }, (_, n) => `line ${n + 1}`).join('\n');
const artifacts: SessionArtifact[] = [
  { kind: 'code', language: 'ts', text: 'const a = 1;', answer: 1, question: 'First question', location: at(2) },
  { kind: 'table', text: '| A |\n|---|\n| 1 |', answer: 1, question: 'First question', location: at(2) },
  { kind: 'code', text: code, answer: 2, question: 'Second question', location: at(4) },
  { kind: 'code', language: 'py', text: 'print(3)', answer: 3, question: '', location: at(6) }
];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup() {
  const { createArtifactsDrawer } = await import('../src/renderer/artifacts-drawer.js');
  const deps = { load: vi.fn(async (_id: string): Promise<SessionArtifactsReply> => ({ artifacts })), copy: vi.fn(async () => true), reveal: vi.fn() };
  const drawer = createArtifactsDrawer(deps);
  const mount = document.getElementById('dock')!;
  return { drawer, deps, mount };
}
const filter = (key: string) => document.querySelector<HTMLButtonElement>(`.artifacts-filter[data-filter="${key}"]`)!;
const items = () => [...document.querySelectorAll<HTMLElement>('.artifact')];

it('lists a chat\'s code, tables and formulas by kind, copies one whole and opens its answer', async () => {
  const { drawer, deps, mount } = await setup();
  drawer.update('chat-1', '1');
  drawer.show(mount);
  await flush();
  expect(deps.load).toHaveBeenCalledWith('chat-1');
  expect(items().map(item => item.querySelector('.artifact-kind')!.textContent)).toEqual(['ts', 'Table', 'Code', 'py']);
  expect([...document.querySelectorAll('.artifacts-filter')].map(button => button.textContent)).toEqual(['All4', 'Code3', 'Tables1', 'Formulas']);
  // This chat has no formulas to filter by.
  expect(filter('formula').disabled).toBe(true);
  filter('code').click();
  expect(items().map(item => item.querySelector('.artifact-kind')!.textContent)).toEqual(['ts', 'Code', 'py']);
  const long = items()[1]!;
  // The entry shows the start of the block; Copy gives all of it.
  expect(long.querySelector('.artifact-preview')!.textContent).toBe(code.split('\n').slice(0, 8).join('\n'));
  expect(long.querySelector('.artifact-lines')!.textContent).toBe('12 lines');
  long.querySelector<HTMLButtonElement>('.artifact-copy')!.click();
  await flush();
  expect(deps.copy).toHaveBeenCalledWith(code);
  long.querySelector<HTMLButtonElement>('.artifact-source')!.click();
  expect(deps.reveal).toHaveBeenCalledWith('chat-1', at(4));
  expect(items()[2]!.querySelector('.artifact-source')!.textContent).toBe('Answer 3');
});

it('reads again only when the chat or its answers change, and not while hidden', async () => {
  const { drawer, deps, mount } = await setup();
  drawer.update('chat-1', '1');
  expect(deps.load).not.toHaveBeenCalled();
  drawer.show(mount);
  await flush();
  const list = document.querySelector('.artifacts-list')!;
  const first = list.firstElementChild;
  // A repaint for paging or streaming carries the same answers: nothing is read or redrawn.
  drawer.update('chat-1', '1');
  drawer.hide(); drawer.show(mount);
  await flush();
  expect(deps.load).toHaveBeenCalledTimes(1);
  expect(list.firstElementChild).toBe(first);
  drawer.update('chat-1', '2');
  await flush();
  expect(deps.load).toHaveBeenCalledTimes(2);
  // Another chat clears the list at once instead of showing the last chat's artifacts.
  deps.load.mockImplementationOnce(() => new Promise(() => undefined));
  drawer.update('chat-2', '2');
  expect(items()).toHaveLength(0);
  expect(document.querySelector('.artifacts-status')!.textContent).toBe('Loading…');
  expect(deps.load).toHaveBeenLastCalledWith('chat-2');
});

it('says when a chat has none, and when the list holds only part of them', async () => {
  const { drawer, deps, mount } = await setup();
  deps.load.mockResolvedValueOnce({ artifacts: [] });
  drawer.update('chat-1', '1'); drawer.show(mount);
  await flush();
  expect(document.querySelector('.artifacts-status')!.textContent).toBe('No code, tables or formulas in this chat');
  deps.load.mockResolvedValueOnce({ artifacts, limited: true });
  drawer.update('chat-1', '2');
  await flush();
  const status = document.querySelector<HTMLElement>('.artifacts-status')!;
  expect(status.hidden).toBe(false);
  expect(status.textContent).toBe('Showing the first 4');
});
