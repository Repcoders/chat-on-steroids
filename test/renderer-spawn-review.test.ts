import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpawnReviewRequest } from '../src/shared/spawn-review.js';

/**
 * `multiAgent.reviewSpawns`: the sheet a batch of workers waits on. It sends back only positions
 * and edited values, and every way of closing it answers, so the prime's call never hangs on it.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const request: SpawnReviewRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  workers: [
    { label: 'Tests', task: 'Write the parser tests' },
    { label: 'Docs', task: 'Update the parser docs', model: 'gpt-6', reasoning_effort: 'high' },
    { task: 'Benchmark the parser' }
  ],
  context: 'Repository: /home/you/project',
  expiresAt: Date.now() + 120_000
};
const models = () => [{ id: 'gpt-6', label: 'GPT-6', efforts: ['low', 'medium', 'high'] }];

async function mount() {
  const { initSpawnReview } = await import('../src/renderer/spawn-review.js');
  let show!: (request: SpawnReviewRequest) => void;
  let closed!: (id: string) => void;
  const answerSpawnReview = vi.fn(async () => ({ ok: true as const, data: true }));
  initSpawnReview({
    onSpawnReview: listener => { show = listener; return () => undefined; },
    onSpawnReviewClosed: listener => { closed = listener; return () => undefined; },
    answerSpawnReview
  }, models);
  return { show: (next: SpawnReviewRequest) => show(next), closed: (id: string) => closed(id), answerSpawnReview };
}
const rows = () => [...document.querySelectorAll<HTMLElement>('#spawnReviewWorkers .spawn-review-worker')];
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it('sends back the kept workers with their edits after one is dropped', async () => {
  const sheet = await mount();
  sheet.show(request);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(true);
  expect(rows().map(row => row.querySelector('b')!.textContent)).toEqual(['Tests', 'Docs', 'Worker 3']);
  expect($('spawnReviewContext').textContent).toBe('Repository: /home/you/project');
  expect($('spawnReviewSubmit').textContent).toBe('Start 3 of 3');
  const [tests, docs, bench] = rows();
  expect(docs!.querySelectorAll('select')[0]!.value).toBe('gpt-6');
  expect(docs!.querySelectorAll('select')[1]!.value).toBe('high');
  docs!.querySelector('button')!.click();
  expect($('spawnReviewSubmit').textContent).toBe('Start 2 of 3');
  expect(docs!.querySelector('textarea')!.disabled).toBe(true);
  tests!.querySelector('textarea')!.value = 'Write the parser tests, edge cases first';
  const [model, effort] = [...bench!.querySelectorAll('select')];
  model!.value = 'gpt-6';
  model!.dispatchEvent(new dom.window.Event('change'));
  expect([...effort!.options].map(option => option.value)).toEqual(['', 'low', 'medium', 'high']);
  effort!.value = 'low';
  $('spawnReviewForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect(sheet.answerSpawnReview).toHaveBeenCalledWith(request.id, [
    { index: 0, task: 'Write the parser tests, edge cases first', model: '', reasoningEffort: '' },
    { index: 2, task: 'Benchmark the parser', model: 'gpt-6', reasoningEffort: 'low' }
  ]);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
});

it('cannot start an empty batch, and Start none or Escape answers with none', async () => {
  const sheet = await mount();
  sheet.show(request);
  for (const row of rows()) row.querySelector('button')!.click();
  expect($<HTMLButtonElement>('spawnReviewSubmit').disabled).toBe(true);
  $('spawnReviewCancel').click();
  await settle();
  expect(sheet.answerSpawnReview).toHaveBeenLastCalledWith(request.id, null);
  sheet.show({ ...request, id: '00000000-0000-4000-8000-000000000002' });
  $('spawnReviewDialog').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
  await settle();
  expect(sheet.answerSpawnReview).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000002', null);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
});

// Found by review: a refused answer used to close the sheet while the prime's call kept waiting.
it('keeps the sheet open with the reason when the app refuses the answer', async () => {
  const sheet = await mount();
  sheet.answerSpawnReview.mockResolvedValueOnce({ ok: false, error: 'The answer names a worker that is not in this spawn.' } as never);
  sheet.show(request);
  $('spawnReviewForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(true);
  expect($('spawnReviewError').hidden).toBe(false);
  expect($('spawnReviewError').textContent).toBe('The answer names a worker that is not in this spawn.');
  expect($<HTMLButtonElement>('spawnReviewSubmit').disabled).toBe(false);
  $('spawnReviewForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await settle();
  expect(sheet.answerSpawnReview).toHaveBeenCalledTimes(2);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
});

// Found by review: a request can reach a page that finished loading after its deadline.
it('never shows a batch whose deadline passed, and closes itself at the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const sheet = await mount();
    sheet.show({ ...request, expiresAt: Date.now() - 1 });
    expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
    sheet.show({ ...request, id: '00000000-0000-4000-8000-000000000002', expiresAt: Date.now() + 5_000 });
    expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
    expect(sheet.answerSpawnReview).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

// Found by review: dimming the whole dropped worker dimmed its Keep button too.
it("dims a dropped worker's fields but not the button that keeps it", () => {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  expect(css).not.toMatch(/\.spawn-review-worker\.dropped\s*\{[^}]*opacity/);
  expect(css).toMatch(/\.spawn-review-worker\.dropped :is\([^)]*\.plugin-field[^)]*\)\s*\{[^}]*opacity/);
});

it('shows a second batch after the first, and drops one the app closed for time', async () => {
  const sheet = await mount();
  const second = { ...request, id: '00000000-0000-4000-8000-000000000002', workers: request.workers.slice(0, 2) };
  const third = { ...request, id: '00000000-0000-4000-8000-000000000003' };
  sheet.show(request);
  sheet.show(second);
  sheet.show(third);
  expect(rows()).toHaveLength(3);
  sheet.closed(third.id);
  sheet.closed(request.id);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(true);
  expect(rows()).toHaveLength(2);
  $('spawnReviewCancel').click();
  await settle();
  expect(sheet.answerSpawnReview).toHaveBeenCalledTimes(1);
  expect($<HTMLDialogElement>('spawnReviewDialog').open).toBe(false);
});
