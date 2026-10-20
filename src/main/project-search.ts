import { projectFileTarget } from './project-files.js';
import { DEFAULT_EXCLUDES, search } from './search.js';
import type { ProjectSearchQuery, ProjectSearchResult } from '../shared/project-files.js';

/** Enough to scan by eye; a broader query is told to narrow instead of filling the IPC message. */
export const MAX_PROJECT_SEARCH_HITS = 500;

let running: AbortController | null = null;

/**
 * The Search panel's text search over one project on this computer. The project root comes from
 * the same containment as Files, ripgrep reads the tree's ignore files on top of the usual build
 * and dependency folders, and links are not followed. One search runs at a time: a new query
 * cancels the one still running, as typing a new query does in an editor.
 */
export async function searchProject(query: ProjectSearchQuery): Promise<ProjectSearchResult> {
  running?.abort();
  const controller = new AbortController();
  running = controller;
  try {
    const root = await projectFileTarget(query.projectId, '', { allowRoot: true });
    const outcome = await search({
      realDir: root.real,
      virtualDir: '',
      query: query.query,
      mode: 'content',
      include: query.include || undefined,
      exclude: [...DEFAULT_EXCLUDES, ...query.excludeFolders],
      caseSensitive: query.caseSensitive,
      regex: query.regex,
      maxResults: MAX_PROJECT_SEARCH_HITS,
      respectIgnore: true,
      signal: controller.signal
    });
    return {
      projectId: query.projectId,
      // With an empty virtual root every hit reads "/src/a.ts"; Files names it "src/a.ts".
      hits: outcome.hits.map(hit => ({ path: hit.path.replace(/^\/+/, ''), line: hit.line ?? 1, text: hit.text ?? '' })),
      filesScanned: outcome.filesScanned,
      stoppedBecause: outcome.stoppedBecause
    };
  } catch (error) {
    // ripgrep exits 2 on a pattern it cannot parse, and search() keeps its stderr out of the
    // message. With regex off the query is a fixed string, so the same exit is something else.
    if (query.regex && error instanceof Error && error.message.startsWith('ripgrep search failed')) {
      throw new Error('The search failed. Check the regular expression.');
    }
    throw error;
  } finally {
    if (running === controller) running = null;
  }
}

/** Stops the running search, which then answers with what it found so far. */
export function cancelProjectSearch(): boolean {
  if (!running) return false;
  running.abort();
  return true;
}
