import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QuickAskAnswer } from '../src/shared/quick-ask.js';

let dom: JSDOM;
const PROJECT = '6c0b1f9e-2a7d-4c3e-9f1a-000000000001';

beforeEach(() => {
  const page = readFileSync('src/renderer/quick-ask.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(page, { url: 'https://quick-ask.test' });
  const w = dom.window;
  for (const [key, value] of Object.entries({ window: w, document: w.document, localStorage: w.localStorage, Option: w.Option, navigator: w.navigator })) vi.stubGlobal(key, value);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fakeApi() {
  let answer: ((reply: QuickAskAnswer) => void) | null = null;
  const api = {
    state: vi.fn(async () => ({ ok: true as const, data: { theme: 'dark' as const, background: '#09090b', accent: '#b0cbed', projects: [{ id: PROJECT, name: 'demo-app' }] } })),
    send: vi.fn(async () => ({ ok: true as const, data: { sessionId: 'quick-session-1', error: null } })),
    openChat: vi.fn(), hide: vi.fn(),
    onShown: vi.fn(() => () => undefined),
    onAnswer: vi.fn((listener: (reply: QuickAskAnswer) => void) => { answer = listener; return () => undefined; })
  };
  return { api, answer: (reply: QuickAskAnswer) => answer!(reply) };
}

it('sends the question with its project and draws the finished answer without running anything from it', async () => {
  const { startQuickAskPage } = await import('../src/renderer/quick-ask.js');
  const { api, answer } = fakeApi();
  startQuickAskPage(api);
  await flush();
  const doc = dom.window.document;
  const text = doc.getElementById('text') as HTMLTextAreaElement, project = doc.getElementById('project') as HTMLSelectElement;
  expect([...project.options].map(option => option.textContent)).toEqual(['No project', 'demo-app']);
  expect(doc.documentElement.dataset.theme).toBe('dark');
  project.value = PROJECT;
  text.value = 'Why does the build fail?';
  text.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(api.send).toHaveBeenCalledWith('Why does the build fail?', PROJECT);
  expect(text.value).toBe('');
  expect(doc.getElementById('question')!.textContent).toBe('Why does the build fail?');
  expect(doc.getElementById('status')!.textContent).toBe('Waiting for the answer…');
  // The project is remembered for the next question.
  expect(dom.window.localStorage.getItem('cos.quickAsk.project')).toBe(PROJECT);

  answer({ sessionId: 'another-chat', text: 'Not this one' });
  expect(doc.getElementById('answer')!.textContent).toBe('');
  answer({ sessionId: 'quick-session-1', text: 'Run **npm ci** first. [Docs](https://example.com)\n\n<script>window.ran = true</script><img src=x onerror="window.ran = true">' });
  const drawn = doc.getElementById('answer')!;
  expect(drawn.querySelector('strong')?.textContent).toBe('npm ci');
  expect(drawn.querySelector('a, script, img')).toBeNull();
  expect(drawn.textContent).toContain('Docs');
  expect((dom.window as unknown as { ran?: boolean }).ran).toBeUndefined();
  expect(doc.getElementById('status')!.textContent).toBe('');

  (doc.getElementById('open') as HTMLButtonElement).click();
  expect(api.openChat).toHaveBeenCalledWith('quick-session-1');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(api.hide).toHaveBeenCalled();
});

it('keeps Shift+Enter for a new line and shows why a send was refused', async () => {
  const { startQuickAskPage } = await import('../src/renderer/quick-ask.js');
  const { api } = fakeApi();
  api.send.mockResolvedValueOnce({ ok: false, error: 'The app is shutting down' } as never);
  startQuickAskPage(api);
  await flush();
  const doc = dom.window.document;
  const text = doc.getElementById('text') as HTMLTextAreaElement;
  text.value = 'First line';
  text.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await flush();
  expect(api.send).not.toHaveBeenCalled();
  text.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(doc.getElementById('status')!.textContent).toBe('The app is shutting down');
  expect(text.value).toBe('First line');
  expect((doc.getElementById('open') as HTMLButtonElement).hidden).toBe(true);
});
