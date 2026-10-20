/**
 * A spawn of several workers, shown to the person before any of them is admitted
 * (`multiAgent.reviewSpawns`). The main process owns the wait; the renderer only shows the request
 * and sends back which workers to keep, each by its position in the request, with its edits.
 */
export interface SpawnReviewWorker {
  label?: string;
  task: string;
  model?: string | null;
  reasoning_effort?: string | null;
}

export interface SpawnReviewRequest {
  id: string;
  workers: SpawnReviewWorker[];
  /** Shared instructions the prime wrote for every worker; shown, not edited. */
  context: string | null;
  /** When nothing is spawned if the person has not answered. */
  expiresAt: number;
}

/** One kept worker: `index` into the request, an empty model or effort means the app default. */
export interface SpawnReviewKept {
  index: number;
  task: string;
  model: string;
  reasoningEffort: string;
}
