/**
 * Spawn batch review (`multiAgent.reviewSpawns`, off by default).
 *
 * A prime that splits its task asks for several workers in one `agents action=spawn` call. With
 * the setting on, the person sees that batch before anything is admitted and can edit each
 * worker's task, model and effort, or drop it. Nothing is staged while the sheet is open: no slot
 * is held, no worktree made and no chat opened, so dropping a worker leaves nothing behind. The
 * kept, edited batch then goes through the ordinary spawn, which checks it like any other.
 *
 * The prime's tool call waits for the answer, so the wait is bounded: after `SPAWN_REVIEW_MS`
 * nothing is spawned and the call says why. Without a window to show the sheet in, nothing is
 * spawned either; the person asked to see every batch first.
 */
import { randomUUID } from 'node:crypto';
import type { SpawnReviewKept, SpawnReviewRequest, SpawnReviewWorker } from '../shared/spawn-review.js';

/** How long a prime's spawn call waits for the person. */
export const SPAWN_REVIEW_MS = 120_000;

export type SpawnReviewOutcome =
  | { outcome: 'accepted'; workers: SpawnReviewWorker[]; dropped: number; edited: number }
  | { outcome: 'declined' | 'expired' | 'unavailable' };

interface Presenter {
  /** Shows the sheet; false when there is no window to show it in. */
  show(request: SpawnReviewRequest): boolean;
  /** Closes a sheet nobody answered in time. */
  close(id: string): void;
}

interface Pending { request: SpawnReviewRequest; resolve(outcome: SpawnReviewOutcome): void; timer: NodeJS.Timeout }

let presenter: Presenter | null = null;
const pending = new Map<string, Pending>();

export function configureSpawnReview(next: Presenter | null): void {
  presenter = next;
}

function settle(id: string, outcome: SpawnReviewOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(outcome);
  return true;
}

/** Waits for the person's answer to this batch. Resolves; never rejects. */
export function reviewSpawn(workers: readonly SpawnReviewWorker[], context: string | null, now = Date.now()): Promise<SpawnReviewOutcome> {
  const request: SpawnReviewRequest = {
    id: randomUUID(),
    workers: workers.map(worker => ({ ...worker })),
    context,
    expiresAt: now + SPAWN_REVIEW_MS
  };
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (settle(request.id, { outcome: 'expired' })) presenter?.close(request.id);
    }, SPAWN_REVIEW_MS);
    pending.set(request.id, { request, resolve, timer });
    let shown = false;
    try { shown = presenter?.show(request) === true; } catch { shown = false; }
    if (!shown) settle(request.id, { outcome: 'unavailable' });
  });
}

/**
 * The person's answer: the workers to keep, or null to spawn none. A kept worker names its
 * position in the request, so an answer can drop and edit workers but never add one.
 */
export function answerSpawnReview(id: string, kept: readonly SpawnReviewKept[] | null): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (!kept?.length) return settle(id, { outcome: 'declined' });
  const original = entry.request.workers;
  const indexes = kept.map(worker => worker.index);
  if (new Set(indexes).size !== indexes.length || indexes.some(index => !original[index])) {
    throw new Error('The answer names a worker that is not in this spawn.');
  }
  let edited = 0;
  const workers = [...kept].sort((a, b) => a.index - b.index).map(answer => {
    const source = original[answer.index]!;
    // The IPC trims the task; an unedited one keeps the prime's exact text.
    const task = answer.task.trim() === source.task.trim() ? source.task : answer.task;
    const worker: SpawnReviewWorker = { ...(source.label === undefined ? {} : { label: source.label }), task };
    if (answer.model) worker.model = answer.model;
    if (answer.reasoningEffort) worker.reasoning_effort = answer.reasoningEffort;
    if (worker.task !== source.task || (worker.model ?? '') !== (source.model ?? '') ||
      (worker.reasoning_effort ?? '') !== (source.reasoning_effort ?? '')) edited++;
    return worker;
  });
  return settle(id, { outcome: 'accepted', workers, dropped: original.length - workers.length, edited });
}

export function resetSpawnReviewsForTests(): void {
  for (const id of [...pending.keys()]) settle(id, { outcome: 'declined' });
  presenter = null;
}
