import { afterEach, expect, it, vi } from 'vitest';
import { answerSpawnReview, configureSpawnReview, resetSpawnReviewsForTests, reviewSpawn, SPAWN_REVIEW_MS } from '../src/main/spawn-review.js';
import type { SpawnReviewRequest } from '../src/shared/spawn-review.js';

afterEach(() => {
  resetSpawnReviewsForTests();
  vi.useRealTimers();
});

const batch = [
  { label: 'Tests', task: 'Write the parser tests' },
  { label: 'Docs', task: 'Update the parser docs', model: 'gpt-6', reasoning_effort: 'high' },
  { task: 'Benchmark the parser' }
];

function presenting(): { shown: SpawnReviewRequest[]; closed: string[] } {
  const seen = { shown: [] as SpawnReviewRequest[], closed: [] as string[] };
  configureSpawnReview({ show: request => { seen.shown.push(request); return true; }, close: id => { seen.closed.push(id); } });
  return seen;
}

it('starts only the workers the person kept, with their edits, and never one they did not see', async () => {
  const seen = presenting();
  const review = reviewSpawn(batch, 'Repository: /home/you/project', 1_000);
  const request = seen.shown[0]!;
  expect(request).toMatchObject({ workers: batch, context: 'Repository: /home/you/project', expiresAt: 1_000 + SPAWN_REVIEW_MS });
  expect(() => answerSpawnReview(request.id, [{ index: 3, task: 'Something else', model: '', reasoningEffort: '' }])).toThrow(/not in this spawn/);
  expect(() => answerSpawnReview(request.id, [
    { index: 0, task: 'a', model: '', reasoningEffort: '' }, { index: 0, task: 'b', model: '', reasoningEffort: '' }
  ])).toThrow(/not in this spawn/);
  expect(answerSpawnReview(request.id, [
    { index: 2, task: 'Benchmark the parser', model: '', reasoningEffort: 'low' },
    { index: 0, task: 'Write the parser tests', model: '', reasoningEffort: '' }
  ])).toBe(true);
  await expect(review).resolves.toEqual({
    outcome: 'accepted',
    workers: [
      { label: 'Tests', task: 'Write the parser tests' },
      { task: 'Benchmark the parser', reasoning_effort: 'low' }
    ],
    dropped: 1,
    edited: 1
  });
  expect(answerSpawnReview(request.id, null)).toBe(false);
});

it("keeps the prime's exact task text when the person did not change it", async () => {
  const seen = presenting();
  const review = reviewSpawn([{ task: 'Write the parser tests\n' }, { task: 'Update the docs' }], null);
  answerSpawnReview(seen.shown[0]!.id, [{ index: 0, task: 'Write the parser tests', model: '', reasoningEffort: '' }]);
  await expect(review).resolves.toMatchObject({ workers: [{ task: 'Write the parser tests\n' }], dropped: 1, edited: 0 });
});

it('clears a model or effort the person set back to the app default', async () => {
  const seen = presenting();
  const review = reviewSpawn(batch, null);
  answerSpawnReview(seen.shown[0]!.id, [0, 1, 2].map(index => ({ index, task: batch[index]!.task, model: '', reasoningEffort: '' })));
  const outcome = await review;
  expect(outcome).toMatchObject({ outcome: 'accepted', dropped: 0, edited: 1 });
  expect(outcome.outcome === 'accepted' && outcome.workers[1]).toEqual({ label: 'Docs', task: 'Update the parser docs' });
});

it('spawns nothing when the person keeps no worker', async () => {
  const seen = presenting();
  const none = reviewSpawn(batch, null);
  answerSpawnReview(seen.shown[0]!.id, null);
  await expect(none).resolves.toEqual({ outcome: 'declined' });
  const empty = reviewSpawn(batch, null);
  answerSpawnReview(seen.shown[1]!.id, []);
  await expect(empty).resolves.toEqual({ outcome: 'declined' });
});

it('gives up after the review window and closes the sheet nobody answered', async () => {
  vi.useFakeTimers();
  const seen = presenting();
  const review = reviewSpawn(batch, null);
  await vi.advanceTimersByTimeAsync(SPAWN_REVIEW_MS - 1);
  expect(seen.closed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(review).resolves.toEqual({ outcome: 'expired' });
  expect(seen.closed).toEqual([seen.shown[0]!.id]);
  expect(answerSpawnReview(seen.shown[0]!.id, [{ index: 0, task: 'late', model: '', reasoningEffort: '' }])).toBe(false);
});

it('spawns nothing when there is no window to show the sheet in', async () => {
  await expect(reviewSpawn(batch, null)).resolves.toEqual({ outcome: 'unavailable' });
  configureSpawnReview({ show: () => false, close: () => undefined });
  await expect(reviewSpawn(batch, null)).resolves.toEqual({ outcome: 'unavailable' });
  configureSpawnReview({ show: () => { throw new Error('window destroyed'); }, close: () => undefined });
  await expect(reviewSpawn(batch, null)).resolves.toEqual({ outcome: 'unavailable' });
});
