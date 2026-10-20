import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProjectGitBadges, projectGitBadge } from '../src/renderer/project-git-badges.js';
import type { ProjectGitSummary } from '../src/shared/project-git.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('<div></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

const ready = (projectId: string, extra: Partial<ProjectGitSummary> = {}): ProjectGitSummary =>
  ({ projectId, state: 'ready', branch: 'main', changes: 0, truncated: false, ...extra });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(reply: (ids: string[]) => ProjectGitSummary[] | Promise<ProjectGitSummary[]> = ids => ids.map(id => ready(id))) {
  const reads: string[][] = [];
  let clock = 1_000, paints = 0;
  const badges = createProjectGitBadges(async ids => { reads.push(ids); return reply(ids); }, () => { paints++; }, () => clock);
  return { badges, reads, paints: () => paints, advance: (ms: number) => { clock += ms; } };
}

it('shows the branch, uncommitted changes and ahead/behind, and spells them out on hover', () => {
  const badge = projectGitBadge(ready('p', { branch: 'feature/badges', changes: 3, upstream: { label: 'origin/feature/badges', ahead: 1, behind: 2 } }))!;
  expect([...badge.children].map(child => [child.className, child.textContent])).toEqual([
    ['project-git-branch', 'feature/badges'], ['project-git-changes', '3'], ['project-git-sync', '↑1 ↓2']
  ]);
  expect(badge.getAttribute('title')).toBe('feature/badges · 3 uncommitted changes · 1 ahead, 2 behind origin/feature/badges');

  const clean = projectGitBadge(ready('p', { upstream: { label: 'origin/main', ahead: 0, behind: 0 } }))!;
  expect(clean.textContent).toBe('main');
  expect(clean.getAttribute('title')).toBe('main · 0 ahead, 0 behind origin/main');
  expect(projectGitBadge(ready('p', { changes: 2_000, truncated: true }))!.textContent).toBe('main2000+');
  expect(projectGitBadge({ projectId: 'p', state: 'not-repository', changes: 0, truncated: false })).toBeNull();
  expect(projectGitBadge({ projectId: 'p', state: 'unavailable', changes: 0, truncated: false })).toBeNull();
});

it('reads each shown project once, repaints only on a change and reads again when stale', async () => {
  const { badges, reads, paints, advance } = fixture();
  badges.want(['a', 'b']);
  badges.want(['a', 'b']);
  await settle();
  expect(reads).toEqual([['a', 'b']]);
  expect(paints()).toBe(1);
  expect(badges.badge('a')?.textContent).toBe('main');

  advance(30_000); badges.want(['a', 'b']); await settle();
  expect(reads).toHaveLength(1);
  advance(30_000); badges.want(['a', 'b']); await settle();
  expect(reads).toEqual([['a', 'b'], ['a', 'b']]);
  // The same answer again is no reason to repaint the sidebar.
  expect(paints()).toBe(1);
});

it('reads again on focus or expand after a few seconds, and at once when Review saw a change', async () => {
  let branch = 'main';
  const { badges, reads, advance } = fixture(ids => ids.map(id => ready(id, { branch })));
  badges.want(['a', 'b']); await settle();
  badges.refresh(); await settle();
  expect(reads).toHaveLength(1);
  advance(5_000); badges.refresh(['b', 'gone']); await settle();
  expect(reads.at(-1)).toEqual(['b']);
  branch = 'next';
  badges.invalidate('a'); badges.invalidate('gone'); await settle();
  expect(reads.at(-1)).toEqual(['a']);
  expect(badges.badge('a')?.textContent).toBe('next');
});

it('keeps one request in flight with at most 32 projects, and waits after a failed read', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failing = false;
  const { badges, reads, advance } = fixture(async ids => {
    if (failing) throw new Error('offline');
    await gate;
    return ids.map(id => ready(id));
  });
  const ids = Array.from({ length: 40 }, (_, index) => `p${index}`);
  badges.want(ids); await settle();
  badges.invalidate('p0'); await settle();
  expect(reads.map(batch => batch.length)).toEqual([32]);
  release(); await settle(); await settle();
  expect(reads.map(batch => batch.length)).toEqual([32, 9]);
  expect(reads[1]).toContain('p0');

  failing = true;
  advance(60_000); badges.want(ids); await settle(); await settle();
  const after = reads.length;
  badges.want(ids); await settle();
  expect(reads).toHaveLength(after);
  // The last known badge stays while Git cannot be read.
  expect(badges.badge('p1')?.textContent).toBe('main');
});

it('treats an answer that is not a list as a failed read', async () => {
  let answer: unknown = null;
  const { badges, reads, paints, advance } = fixture(() => answer as ProjectGitSummary[]);
  badges.want(['a']); await settle();
  expect(badges.badge('a')).toBeNull();
  expect(paints()).toBe(0);
  answer = [ready('a')];
  advance(60_000); badges.want(['a']); await settle();
  expect(reads).toHaveLength(2);
  expect(badges.badge('a')?.textContent).toBe('main');
});

it('keeps the last badge when Git cannot be read this time', async () => {
  let state: ProjectGitSummary['state'] = 'ready';
  const { badges, advance } = fixture(ids => ids.map(id => state === 'ready' ? ready(id) : { projectId: id, state, changes: 0, truncated: false }));
  badges.want(['a']); await settle();
  state = 'unavailable';
  advance(60_000); badges.want(['a', 'b']); await settle();
  expect(badges.badge('a')?.textContent).toBe('main');
  expect(badges.badge('b')).toBeNull();
  // A second unreadable answer in a row (a deleted folder, a revoked root) drops it.
  advance(60_000); badges.want(['a', 'b']); await settle();
  expect(badges.badge('a')).toBeNull();
  // One good read resets the count.
  state = 'ready';
  advance(60_000); badges.want(['a', 'b']); await settle();
  state = 'unavailable';
  advance(60_000); badges.want(['a', 'b']); await settle();
  expect(badges.badge('a')?.textContent).toBe('main');
  // A folder that is no longer a repository loses its badge at once.
  state = 'not-repository';
  advance(60_000); badges.want(['a', 'b']); await settle();
  expect(badges.badge('a')).toBeNull();
});

it('forgets a project the sidebar no longer shows', async () => {
  const { badges, reads } = fixture();
  badges.want(['a']); await settle();
  badges.want([]);
  expect(badges.badge('a')).toBeNull();
  badges.want(['a']); await settle();
  expect(reads).toEqual([['a'], ['a']]);
});
