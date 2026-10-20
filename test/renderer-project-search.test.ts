import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProjectSearchPanel, matchSpan } from '../src/renderer/project-search.js';
import type { LocalProject } from '../src/shared/projects.js';
import type { ProjectSearchResult } from '../src/shared/project-files.js';

let dom: JSDOM;
let mount: HTMLElement;
const project: LocalProject = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', path: 'C:\\alpha', createdAt: 1 };
const other: LocalProject = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', path: 'C:\\beta', createdAt: 2 };
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const tick = async (): Promise<void> => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

beforeEach(() => {
  dom = new JSDOM('<body><section id="mount"></section></body>', { url: 'https://cos.local/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  mount = document.getElementById('mount')!;
  Object.assign(dom.window, { api: { searchProject: vi.fn(), cancelProjectSearch: vi.fn(() => ok(true)) } });
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function search(text: string): void {
  mount.querySelector<HTMLInputElement>('.project-search-query input')!.value = text;
  mount.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

it('marks the matched words, literally or by regex, and leaves a pattern JavaScript cannot read unmarked', () => {
  expect(matchSpan('const Answer = 42', 'answer', false, false)).toEqual([6, 12]);
  expect(matchSpan('const Answer = 42', 'answer', true, false)).toBeNull();
  expect(matchSpan('call(a.b)', 'a.b', false, false)).toEqual([5, 8]);
  expect(matchSpan('value = 42', '\\d+', false, true)).toEqual([8, 10]);
  expect(matchSpan('value', '(?<', false, true)).toBeNull();
});

it('searches the open project with its filters, groups the hits by file and opens one at its line', async () => {
  const result: ProjectSearchResult = { projectId: project.id, filesScanned: 4, stoppedBecause: null, hits: [
    { path: 'src/a.ts', line: 2, text: 'export const needle = 1;' },
    { path: 'src/a.ts', line: 9, text: 'use(needle);' },
    { path: 'README.md', line: 1, text: 'needle docs' }
  ] };
  vi.mocked(window.api.searchProject).mockReturnValue(ok(result));
  const onOpen = vi.fn();
  const panel = createProjectSearchPanel({ mount, onOpen });
  panel.update(project); panel.show();
  const [include, exclude] = mount.querySelectorAll<HTMLInputElement>('.project-search-filters input');
  include!.value = ' *.ts '; exclude!.value = 'fixtures, tmp,';
  mount.querySelector<HTMLButtonElement>('.project-search-toggle')!.click();
  search('needle');
  await tick();
  expect(window.api.searchProject).toHaveBeenCalledWith({ projectId: project.id, query: 'needle', include: '*.ts',
    excludeFolders: ['fixtures', 'tmp'], caseSensitive: true, regex: false });
  const files = [...mount.querySelectorAll('.project-search-file')];
  expect(files.map(file => file.querySelector('strong')?.textContent)).toEqual(['a.ts', 'README.md']);
  expect(files[0]!.querySelector('.project-search-file-folder')?.textContent).toBe('src');
  expect(files[0]!.querySelectorAll('.project-search-hit')).toHaveLength(2);
  expect(files[0]!.querySelector('mark')?.textContent).toBe('needle');
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('3 matches · 2 files');
  files[0]!.querySelectorAll<HTMLButtonElement>('.project-search-hit')[1]!.click();
  expect(onOpen).toHaveBeenCalledWith(project.id, 'src/a.ts', 9);
});

it('stops a running search from Stop or Escape and says what it found before stopping', async () => {
  let answer!: (value: { ok: true; data: ProjectSearchResult }) => void;
  vi.mocked(window.api.searchProject).mockReturnValue(new Promise(resolve => { answer = resolve; }));
  const panel = createProjectSearchPanel({ mount, onOpen: vi.fn() });
  panel.update(project); panel.show();
  search('needle');
  const stop = mount.querySelector<HTMLButtonElement>('.project-search-stop')!;
  expect(stop.hidden).toBe(false);
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('Searching…');
  expect(mount.querySelectorAll('.project-search-hit')).toHaveLength(0);
  mount.querySelector('input')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(window.api.cancelProjectSearch).toHaveBeenCalledOnce();
  expect(mount.querySelector<HTMLElement>('.project-search-panel')!.hidden).toBe(false);
  stop.click();
  expect(window.api.cancelProjectSearch).toHaveBeenCalledTimes(2);
  answer({ ok: true, data: { projectId: project.id, filesScanned: 1, stoppedBecause: 'cancelled', hits: [{ path: 'a.ts', line: 1, text: 'needle' }] } });
  await tick();
  expect(stop.hidden).toBe(true);
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('Search stopped. 1 match · 1 file');
});

it('drops a reply for a project that is no longer open, and cancels its search', async () => {
  let answer!: (value: { ok: true; data: ProjectSearchResult }) => void;
  vi.mocked(window.api.searchProject).mockReturnValue(new Promise(resolve => { answer = resolve; }));
  const panel = createProjectSearchPanel({ mount, onOpen: vi.fn() });
  panel.update(project); panel.show();
  search('needle');
  panel.update(other);
  expect(window.api.cancelProjectSearch).toHaveBeenCalledOnce();
  answer({ ok: true, data: { projectId: project.id, filesScanned: 1, stoppedBecause: null, hits: [{ path: 'a.ts', line: 1, text: 'needle' }] } });
  await tick();
  expect(mount.querySelectorAll('.project-search-hit')).toHaveLength(0);
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('');
});

it('tells the user to narrow a search that hit the result cap, and shows why a search failed', async () => {
  const hits = Array.from({ length: 500 }, (_, index) => ({ path: 'big.txt', line: index + 1, text: 'needle' }));
  vi.mocked(window.api.searchProject).mockReturnValueOnce(ok({ projectId: project.id, filesScanned: 9, stoppedBecause: 'limit', hits }));
  const panel = createProjectSearchPanel({ mount, onOpen: vi.fn() });
  panel.update(project); panel.show();
  search('needle');
  await tick();
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('Showing the first 500 matches. Narrow the search to see the rest.');
  vi.mocked(window.api.searchProject).mockResolvedValueOnce({ ok: false, error: 'The search failed. Check the regular expression.' });
  mount.querySelectorAll<HTMLButtonElement>('.project-search-toggle')[1]!.click();
  await tick();
  expect(window.api.searchProject).toHaveBeenLastCalledWith(expect.objectContaining({ regex: true }));
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('The search failed. Check the regular expression.');
  expect(mount.querySelectorAll('.project-search-hit')).toHaveLength(0);
  // With regex on, a failure that has nothing to do with the pattern still says what it is.
  vi.mocked(window.api.searchProject).mockResolvedValueOnce({ ok: false, error: 'Project not found' });
  search('needle');
  await tick();
  expect(mount.querySelector('.project-search-status')?.textContent).toBe('Project not found');
});
