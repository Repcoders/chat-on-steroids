import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import * as agents from '../src/main/agents.js';
import { onSwarmPersistNow, resetAgentsForTests, snapshotSwarm } from '../src/main/agents.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { answerSpawnReview, configureSpawnReview, resetSpawnReviewsForTests } from '../src/main/spawn-review.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import type { SpawnReviewKept, SpawnReviewRequest } from '../src/shared/spawn-review.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

/** `multiAgent.reviewSpawns`: the person sees a batch of workers before any of them is admitted. */
const primeConversation = 'mcp-spawn-review-prime';
let temp: string;

beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-spawn-review-'));
  initConfigPath(temp);
  initSessionStore(temp);
});
afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  resetSpawnReviewsForTests();
  await fs.rm(temp, { recursive: true, force: true });
});
beforeEach(async () => {
  resetAgentsForTests();
  resetWorkspaces();
  resetSpawnReviewsForTests();
  vi.restoreAllMocks();
  await review(true);
  onSwarmPersistNow(async () => undefined);
});

async function review(on: boolean): Promise<void> {
  const defaults = defaultConfig();
  await saveConfig({ ...defaults, multiAgent: { ...defaults.multiAgent, enabled: true, maxWorkers: 4, reviewSpawns: on } });
}

/** The person's answer, given as soon as the sheet is shown. */
function answering(answer: (request: SpawnReviewRequest) => SpawnReviewKept[] | null): SpawnReviewRequest[] {
  const shown: SpawnReviewRequest[] = [];
  configureSpawnReview({
    show: request => { shown.push(request); queueMicrotask(() => answerSpawnReview(request.id, answer(request))); return true; },
    close: () => undefined
  });
  return shown;
}

function spawn(workers: Array<{ label?: string; task: string }>): Promise<ToolResult> {
  const ctx: ToolContext = { roots: getConfig().roots, caps: DEFAULT_CAPABILITIES, readOnly: false, agentTools: true, sessionTools: false, exposedFinishTool: false };
  const registrar = createRegistrar(null, ctx, 'core');
  let handler: ((input: { action: 'spawn'; workers: Array<{ task: string }> }) => Promise<ToolResult>) | undefined;
  registrar.register = ((name, _config, callback) => {
    if (name === 'agents') handler = callback as typeof handler;
  }) as typeof registrar.register;
  registerCoreTools(registrar);
  const call: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId: primeConversation, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  return runInCallContext(call, () => handler!({ action: 'spawn', workers }));
}

const three = [
  { label: 'Tests', task: 'Write the parser tests' },
  { label: 'Docs', task: 'Update the parser docs' },
  { label: 'Bench', task: 'Benchmark the parser' }
];
const workerTasks = () => (snapshotSwarm()?.agents ?? []).filter(row => row.info.role === 'worker').map(row => row.info.task);

it('opens only the workers left after the person dropped one and edited another', async () => {
  const shown = answering(() => [
    { index: 0, task: 'Write the parser tests, edge cases first', model: '', reasoningEffort: '' },
    { index: 2, task: 'Benchmark the parser', model: '', reasoningEffort: '' }
  ]);
  const response = await spawn(three);
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.workers.map(worker => worker.task)).toEqual(three.map(worker => worker.task));
  expect(response.structuredContent).toMatchObject({
    action: 'spawn',
    workers: [{ id: 'worker-1', label: 'Tests' }, { id: 'worker-2', label: 'Bench' }],
    reviewed: { dropped: 1, edited: 1 }
  });
  expect((response.structuredContent as { workers: unknown[] }).workers).toHaveLength(2);
  expect(response.content[0]).toMatchObject({ text: expect.stringContaining('1 of 3 worker(s) dropped and 1 edited') });
  const tasks = workerTasks();
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toContain('edge cases first');
  expect(tasks.some(task => task.includes('parser docs'))).toBe(false);
});

it('spawns nothing and holds no slot when the person starts none', async () => {
  answering(() => null);
  const response = await spawn(three);
  expect(response.isError).toBe(true);
  expect(response.content[0]).toMatchObject({ text: expect.stringContaining('SPAWN_DECLINED') });
  expect(workerTasks()).toEqual([]);
});

it('checks again after the wait that a retired worker still has its checkout owner', async () => {
  // Found by review: the person can take two minutes, and the owner can be lost in that time.
  const required = vi.spyOn(agents, 'managedWorkerIsolationRequired').mockReturnValueOnce(false).mockReturnValue(true);
  vi.spyOn(agents, 'managedWorkerAllocationIdentity').mockReturnValue(null);
  answering(request => request.workers.map((worker, index) => ({ index, task: worker.task, model: '', reasoningEffort: '' })));
  const response = await spawn(three);
  expect(required).toHaveBeenCalledTimes(2);
  expect(response.isError).toBe(true);
  expect(response.content[0]).toMatchObject({ text: expect.stringContaining('WORKTREE_OWNER_UNAVAILABLE') });
  expect(workerTasks()).toEqual([]);
});

it('refuses rather than waits when no window can show the review', async () => {
  configureSpawnReview(null);
  const response = await spawn(three);
  expect(response.isError).toBe(true);
  expect(response.content[0]).toMatchObject({ text: expect.stringContaining('SPAWN_REVIEW_UNAVAILABLE') });
  expect(workerTasks()).toEqual([]);
});

it('asks nothing for a single worker, or with the setting off', async () => {
  const shown = answering(() => null);
  expect((await spawn([three[0]!])).isError).not.toBe(true);
  resetAgentsForTests();
  onSwarmPersistNow(async () => undefined);
  await review(false);
  const response = await spawn(three);
  expect(response.isError).not.toBe(true);
  expect(shown).toEqual([]);
  expect(response.structuredContent).not.toHaveProperty('reviewed');
  expect(workerTasks()).toHaveLength(3);
});
