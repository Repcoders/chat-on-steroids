import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { cancelProjectSearch, MAX_PROJECT_SEARCH_HITS, searchProject } from '../src/main/project-search.js';
import { writeTree } from './helpers.js';

let directory: string;
let projectPath: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-search-'));
  let approved = path.join(directory, 'approved');
  await fs.mkdir(path.join(approved, 'project'), { recursive: true });
  await fs.mkdir(path.join(approved, 'sibling'));
  approved = await validateNewRoot(approved, []);
  projectPath = path.join(approved, 'project');
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  cancelProjectSearch();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const query = (projectId: string, text: string, overrides: Partial<Parameters<typeof searchProject>[0]> = {}) =>
  ({ projectId, query: text, include: '', excludeFolders: [], caseSensitive: false, regex: false, ...overrides });

it('finds text in one project by project-relative path and line, skipping ignored, dependency and sibling folders', async () => {
  await writeTree(projectPath, {
    '.gitignore': 'generated/\n',
    'src/app.ts': 'const a = 1;\nexport const needle = a;\n',
    'README.md': 'Needle in the docs\n',
    'generated/out.ts': 'needle\n',
    'node_modules/pkg/index.js': 'needle\n',
    'fixtures/data.txt': 'needle\n'
  });
  await writeTree(path.join(projectPath, '..', 'sibling'), { 'other.ts': 'needle\n' });
  const project = await addProject(projectPath);

  const all = await searchProject(query(project.id, 'needle'));
  expect(all.projectId).toBe(project.id);
  expect(all.stoppedBecause).toBeNull();
  expect(all.hits.map(hit => `${hit.path}:${hit.line}`).sort()).toEqual(['README.md:1', 'fixtures/data.txt:1', 'src/app.ts:2']);
  expect(all.hits.find(hit => hit.path === 'src/app.ts')?.text).toBe('export const needle = a;');

  const narrowed = await searchProject(query(project.id, 'needle', { include: '*.ts', excludeFolders: ['fixtures'], caseSensitive: true }));
  expect(narrowed.hits.map(hit => hit.path)).toEqual(['src/app.ts']);
});

it('caps the hits it returns and says the cap stopped it', async () => {
  await writeTree(projectPath, { 'many.txt': `${Array.from({ length: MAX_PROJECT_SEARCH_HITS + 50 }, (_, i) => `needle ${i}`).join('\n')}\n` });
  const project = await addProject(projectPath);
  const result = await searchProject(query(project.id, 'needle'));
  expect(result.hits).toHaveLength(MAX_PROJECT_SEARCH_HITS);
  expect(result.stoppedBecause).toBe('limit');
});

it('runs one search at a time: a new query or Stop cancels the running one', async () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `needle ${i}`).join('\n');
  await writeTree(projectPath, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.txt`, `${lines}\n`])));
  const project = await addProject(projectPath);

  const first = searchProject(query(project.id, 'needle'));
  const second = searchProject(query(project.id, 'needle 39'));
  expect((await first).stoppedBecause).toBe('cancelled');
  expect((await second).stoppedBecause).not.toBe('cancelled');

  expect(cancelProjectSearch()).toBe(false);
  const third = searchProject(query(project.id, 'needle'));
  expect(cancelProjectSearch()).toBe(true);
  expect((await third).stoppedBecause).toBe('cancelled');
});

it('says a regular expression ripgrep cannot read is the problem, and only for a regex search', async () => {
  await writeTree(projectPath, { 'a.txt': 'needle (\n' });
  const project = await addProject(projectPath);
  await expect(searchProject(query(project.id, '(', { regex: true }))).rejects.toThrow('The search failed. Check the regular expression.');
  expect((await searchProject(query(project.id, '(', { regex: false }))).hits.map(hit => hit.line)).toEqual([1]);
});

// chmod 000 keeps a file from its owner only off Windows and without root.
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable file as a failed search, not as a bad regular expression', async () => {
  await writeTree(projectPath, { 'a.txt': 'needle\n', 'locked.txt': 'needle\n' });
  await fs.chmod(path.join(projectPath, 'locked.txt'), 0o000);
  try {
    const project = await addProject(projectPath);
    await expect(searchProject(query(project.id, 'need.e', { regex: true }))).rejects.toThrow(/ripgrep search failed/);
  } finally {
    await fs.chmod(path.join(projectPath, 'locked.txt'), 0o644);
  }
});

it('refuses a project id that is not a known project', async () => {
  await expect(searchProject(query('33333333-3333-4333-8333-333333333333', 'needle'))).rejects.toThrow(/not found/i);
});
