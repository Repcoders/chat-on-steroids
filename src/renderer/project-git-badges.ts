import type { ProjectGitSummary } from '../shared/project-git.js';
import { t, tn, ui } from './i18n.js';
import { el } from './dom.js';

/** A row is read again once it is this old, on the next paint, focus or expand that asks for it. */
const STALE_MS = 60_000;
/** The main process accepts this many projects per request. */
const REQUEST_LIMIT = 32;

/**
 * The branch, uncommitted changes and ahead/behind on each sidebar project heading. A read-only
 * projection of `projectGit:summaries`: rows are read lazily when painted, again when stale, on
 * window focus and when the open project's Review watch reports a change. One request at a time.
 */
export function createProjectGitBadges(
  read: (projectIds: string[]) => Promise<ProjectGitSummary[]>,
  changed: () => void,
  now: () => number = Date.now
) {
  const summaries = new Map<string, ProjectGitSummary>();
  // When each row was last asked for, answered or not: a failing read waits like a stale one.
  const asked = new Map<string, number>();
  const due = new Set<string>();
  let reading = false;
  let wanted = new Set<string>();

  async function drain(): Promise<void> {
    if (reading) return;
    reading = true;
    let different = false;
    try {
      while (due.size) {
        const batch = [...due].slice(0, REQUEST_LIMIT);
        for (const id of batch) { due.delete(id); asked.set(id, now()); }
        let replies: ProjectGitSummary[] = [];
        // A failed read, or an answer that is not a list, keeps the last badge until the row is stale again.
        try { const answer = await read(batch); if (Array.isArray(answer)) replies = answer; } catch { /* kept */ }
        for (const id of batch) {
          const reply = replies.find(entry => entry.projectId === id);
          if (!reply || !wanted.has(id)) continue;
          const previous = summaries.get(id);
          // Git could not be read this time (a lock, a slow disk): the last badge stays, as after a failed request.
          if (reply.state === 'unavailable' && previous?.state === 'ready') continue;
          if (JSON.stringify(previous) !== JSON.stringify(reply)) different = true;
          summaries.set(id, reply);
        }
      }
    } finally { reading = false; }
    if (different) changed();
  }

  function request(ids: Iterable<string>, maxAge: number): void {
    const at = now();
    for (const id of ids) {
      const last = asked.get(id);
      if (last === undefined || at - last >= maxAge) due.add(id);
    }
    if (due.size) void drain();
  }

  return {
    /** The projects this paint shows; any that were never read, or are stale, are read. */
    want(ids: string[]): void {
      wanted = new Set(ids);
      for (const id of [...asked.keys()]) if (!wanted.has(id)) { asked.delete(id); summaries.delete(id); }
      request(ids, STALE_MS);
    },
    /** Window focus or an expanded project: Git may have changed outside the app. */
    refresh(ids: Iterable<string> = wanted): void { request([...ids].filter(id => wanted.has(id)), 5_000); },
    /** The open project's Review watch saw its worktree or refs change. */
    invalidate(id: string): void { if (wanted.has(id)) request([id], 0); },
    badge(id: string): HTMLElement | null {
      const summary = summaries.get(id);
      return summary ? projectGitBadge(summary) : null;
    }
  };
}

/** Nothing for a folder outside Git or one Git could not read; Review explains those states. */
export function projectGitBadge(summary: ProjectGitSummary): HTMLElement | null {
  if (summary.state !== 'ready' || !summary.branch) return null;
  const badge = el('span', 'project-git');
  badge.append(el('span', 'project-git-branch', summary.branch));
  const count = summary.truncated ? `${summary.changes}+` : String(summary.changes);
  if (summary.changes > 0) badge.append(el('span', 'project-git-changes', count));
  const { upstream } = summary;
  if (upstream && (upstream.ahead || upstream.behind)) {
    badge.append(el('span', 'project-git-sync', [upstream.ahead ? `↑${upstream.ahead}` : '', upstream.behind ? `↓${upstream.behind}` : ''].filter(Boolean).join(' ')));
  }
  ui(badge, 'title', () => [
    summary.branch,
    ...(summary.changes > 0 ? [tn('{0} uncommitted change', '{0} uncommitted changes', summary.changes, [count])] : []),
    ...(upstream ? [t('{0} ahead, {1} behind {2}', [upstream.ahead, upstream.behind, upstream.label])] : [])
  ].join(' · '));
  return badge;
}
