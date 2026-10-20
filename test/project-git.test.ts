import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { commitProjectGit, gitExecutable, ProjectGitWatchSet, readProjectGitDiff, readProjectGitSnapshot, setProjectGitStaged } from '../src/main/project-git.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const exec = promisify(execFile);
let directory: string;
let approved: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd, windowsHide: true });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-git-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(approved, { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

async function committedProject(): Promise<{ root: string; id: string }> {
  const root = path.join(approved, 'project');
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'deleted.txt'), 'delete me\n');
  await fs.writeFile(path.join(root, 'old-name.ts'), 'export const renamed = 1;\n');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, 'large.txt'), 'a\n'.repeat(300_000));
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'baseline');
  const project = await addProject(root);
  return { root, id: project.id };
}

it('reconciles modified, untracked, deleted, renamed, binary and large changes from real Git', async () => {
  const { root, id } = await committedProject();
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 2;\nexport const next = true;\n');
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');
  await fs.writeFile(path.join(root, 'staged.ts'), 'export const staged = true;\n');
  await git(root, 'add', 'staged.ts');
  await fs.rm(path.join(root, 'deleted.txt'));
  await git(root, 'mv', 'old-name.ts', 'new-name.ts');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
  await fs.appendFile(path.join(root, 'large.txt'), 'changed\n');

  const snapshot = await readProjectGitSnapshot(id);
  expect(snapshot.state).toBe('ready');
  const byPath = new Map(snapshot.changes.map(change => [change.path, change]));
  expect(byPath.get('modified.ts')).toMatchObject({ status: 'M', additions: 2, deletions: 1, binary: false });
  expect(byPath.get('added.ts')).toMatchObject({ status: 'U', additions: 1, deletions: 0, binary: false });
  expect(byPath.get('staged.ts')).toMatchObject({ status: 'A', additions: 1, deletions: 0, binary: false });
  expect(byPath.get('deleted.txt')).toMatchObject({ status: 'D', additions: 0, deletions: 1 });
  expect(byPath.get('new-name.ts')).toMatchObject({ status: 'R', previousPath: 'old-name.ts' });
  expect(byPath.get('binary.bin')).toMatchObject({ status: 'M', additions: null, deletions: null, binary: true });

  const modified = await readProjectGitDiff(id, 'modified.ts');
  expect(modified.baseText).toContain('value = 1');
  expect(modified.currentText).toContain('value = 2');
  const renamed = await readProjectGitDiff(id, 'new-name.ts');
  expect(renamed.previousPath).toBe('old-name.ts');
  expect(renamed.baseText).toBe(renamed.currentText);
  const deleted = await readProjectGitDiff(id, 'deleted.txt');
  expect(deleted.currentText).toBe('');
  const added = await readProjectGitDiff(id, 'added.ts');
  expect(added).toMatchObject({ status: 'U', baseText: '', currentText: 'export const added = true;\n' });
  const staged = await readProjectGitDiff(id, 'staged.ts');
  expect(staged).toMatchObject({ status: 'A', baseText: '', currentText: 'export const staged = true;\n' });
  const binary = await readProjectGitDiff(id, 'binary.bin');
  expect(binary).toMatchObject({ binary: true, baseText: null, currentText: null });
  const large = await readProjectGitDiff(id, 'large.txt');
  expect(large).toMatchObject({ tooLarge: true, baseText: null, currentText: null });

  await git(root, 'add', 'added.ts');
  const afterAdd = await readProjectGitSnapshot(id);
  expect(afterAdd.changes.find(change => change.path === 'added.ts')).toMatchObject({ status: 'A', additions: 1 });
});

it('reports a clean repository and a non-repository without inventing changes', async () => {
  const clean = await committedProject();
  expect(await readProjectGitSnapshot(clean.id)).toMatchObject({ state: 'ready', changes: [], truncated: false });

  const plainRoot = path.join(approved, 'plain');
  await fs.mkdir(plainRoot);
  const plain = await addProject(plainRoot);
  expect(await readProjectGitSnapshot(plain.id)).toMatchObject({ state: 'not-repository', changes: [] });
});

it('compares committed branch history without changing the checkout or including local edits', async () => {
  const { root, id } = await committedProject();
  const original = (await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim();
  await git(root, 'branch', 'comparison-base');
  await git(root, 'switch', '-c', 'feature');
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 2;\n');
  await fs.writeFile(path.join(root, 'committed.ts'), 'export const committed = true;\n');
  await git(root, 'mv', 'old-name.ts', 'renamed.ts');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'feature work');
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 3;\n');
  await fs.writeFile(path.join(root, 'untracked.ts'), 'local only\n');

  const baseRef = 'refs/heads/comparison-base';
  const snapshot = await readProjectGitSnapshot(id, baseRef);
  expect(snapshot).toMatchObject({ state: 'ready', currentBranch: 'feature', comparison: { ref: baseRef, label: 'comparison-base' } });
  expect(snapshot.branches).toEqual(expect.arrayContaining([{ ref: baseRef, label: 'comparison-base' }]));
  expect(snapshot.changes.map(change => change.path).sort()).toEqual(['committed.ts', 'modified.ts', 'renamed.ts']);
  expect(snapshot.changes.find(change => change.path === 'modified.ts')).toMatchObject({ additions: 1, deletions: 1 });
  expect(snapshot.changes.find(change => change.path === 'renamed.ts')).toMatchObject({ status: 'R', previousPath: 'old-name.ts' });
  expect(await readProjectGitDiff(id, 'modified.ts', baseRef)).toMatchObject({
    baseText: 'export const value = 1;\n', currentText: 'export const value = 2;\n'
  });
  expect(await readProjectGitDiff(id, 'renamed.ts', baseRef)).toMatchObject({
    baseText: 'export const renamed = 1;\n', currentText: 'export const renamed = 1;\n'
  });
  expect(await readProjectGitSnapshot(id)).toMatchObject({ state: 'ready', currentBranch: 'feature' });
  expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe('feature');
  expect(original).not.toBe('feature');
  expect(await readProjectGitSnapshot(id, 'refs/heads/missing')).toMatchObject({ state: 'unavailable' });
});

it('uses the common ancestor for diverged branches and limits a nested project to its subtree', async () => {
  const root = path.join(approved, 'diverged');
  const nested = path.join(root, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'baseline\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'baseline\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  const project = await addProject(nested);
  await git(root, 'switch', '-c', 'feature');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'feature\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'feature\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'feature');
  await git(root, 'switch', '-c', 'base', 'HEAD~1');
  await fs.writeFile(path.join(nested, 'base-only.txt'), 'base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base only');
  await git(root, 'switch', 'feature');

  const snapshot = await readProjectGitSnapshot(project.id, 'refs/heads/base');
  expect(snapshot.state).toBe('ready');
  expect(snapshot.changes.map(change => change.path)).toEqual(['inside.txt']);
  expect(await readProjectGitDiff(project.id, 'inside.txt', 'refs/heads/base', snapshot.revision)).toMatchObject({
    baseText: 'baseline\n', currentText: 'feature\n'
  });
  await expect(readProjectGitDiff(project.id, 'inside.txt', 'refs/heads/base', '0'.repeat(64)))
    .rejects.toThrow('comparison changed');
});

it('ignores inherited Git repository and index redirects when inspecting an approved project', async () => {
  const { id } = await committedProject();
  const previousDir = process.env.GIT_DIR;
  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = path.join(directory, 'unapproved-git-dir');
  process.env.GIT_INDEX_FILE = path.join(directory, 'unapproved-index');
  try {
    expect(await readProjectGitSnapshot(id)).toMatchObject({ state: 'ready', changes: [] });
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }
});

it('keeps a nested Local Project scoped to its own subtree', async () => {
  const root = path.join(approved, 'monorepo');
  const nested = path.join(root, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside\n');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'inside\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  const project = await addProject(nested);
  await fs.writeFile(path.join(root, 'outside.txt'), 'changed outside\n');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'changed inside\n');

  const snapshot = await readProjectGitSnapshot(project.id);
  expect(snapshot.changes.map(change => change.path)).toEqual(['inside.txt']);
  const diff = await readProjectGitDiff(project.id, 'inside.txt');
  expect(diff.baseText).toBe('inside\n');
  expect(diff.currentText).toBe('changed inside\n');
});

it('treats Git metadata watches as debounced invalidation, including commit and push refs', async () => {
  vi.useFakeTimers();
  try {
    const { id } = await committedProject();
    const records: Array<{ nativePath: string; recursive: boolean; fire: () => void; close: ReturnType<typeof vi.fn> }> = [];
    const changed: string[] = [];
    const watches = new ProjectGitWatchSet(event => changed.push(event.projectId), (nativePath, listener, recursive = false) => {
      const emitter = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      emitter.close = vi.fn();
      records.push({ nativePath, recursive, fire: listener, close: emitter.close });
      return emitter as never;
    });
    await watches.sync(id);
    expect(records.some(record => path.basename(record.nativePath) === 'project' && record.recursive)).toBe(true);
    expect(records.some(record => path.basename(record.nativePath) === '.git')).toBe(true);
    const installed = records.length;
    await watches.sync(id);
    expect(records).toHaveLength(installed);
    expect(records.every(record => record.close.mock.calls.length === 0)).toBe(true);
    records[0]!.fire(); records[0]!.fire();
    vi.advanceTimersByTime(179);
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changed).toEqual([id]);
    watches.close();
    expect(records.every(record => record.close.mock.calls.length === 1)).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.runIf(process.platform === 'win32')('invalidates a collapsed nested file through the real recursive Windows watcher', async () => {
  const { root, id } = await committedProject();
  const nested = path.join(root, 'docs');
  const file = path.join(nested, 'HANDOFF.md');
  await fs.mkdir(nested);
  await fs.writeFile(file, 'first\n');
  let resolveChanged!: () => void;
  const changed = new Promise<void>(resolve => { resolveChanged = resolve; });
  const watches = new ProjectGitWatchSet(event => {
    if (event.projectId === id) resolveChanged();
  });
  try {
    await watches.sync(id);
    await fs.writeFile(file, 'first\nsecond\n');
    await Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Git watcher did not invalidate the nested file')), 3_000))
    ]);
  } finally {
    watches.close();
  }
});

it('resolves Git on Windows only from absolute PATH entries, never from the project folder', () => {
  const present = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'git.exe', '.\\git.exe', 'tools\\git.exe']);
  const isFile = (candidate: string): boolean => present.has(candidate);
  // Relative and drive-relative entries resolve against the working directory, which is the project.
  expect(gitExecutable('win32', '.;tools;\\tools;"C:\\Program Files\\Git\\cmd"', isFile)).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  expect(() => gitExecutable('win32', '.;tools', isFile)).toThrow('Git was not found on PATH');
  expect(gitExecutable('darwin', '', () => false)).toBe('git');
});

it('does not run the macOS git stub when the Command Line Tools are missing', () => {
  const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  const stubOnly = (candidate: string): boolean => candidate === '/usr/bin/git';
  expect(() => gitExecutable('darwin', finderPath, stubOnly, () => null)).toThrow('Command Line Tools');
  const withTools = (candidate: string): boolean => stubOnly(candidate) || candidate === '/Library/Developer/CommandLineTools/usr/bin/git';
  expect(gitExecutable('darwin', finderPath, withTools, () => '/Library/Developer/CommandLineTools')).toBe('git');
  // A Git ahead of the stub on PATH (Homebrew) needs no developer directory.
  const brew = (candidate: string): boolean => stubOnly(candidate) || candidate === '/opt/homebrew/bin/git';
  expect(gitExecutable('darwin', `/opt/homebrew/bin:${finderPath}`, brew, () => null)).toBe('git');
});

it('shows merge conflicts as conflicts, with a readable diff for every kind of conflict', async () => {
  // Conflicted files appeared as plain "Modified" (2.1.41 pass); both-added, modify/delete and
  // both-deleted conflicts have no HEAD or no working file, which a diff must survive.
  const root = path.join(approved, 'conflicts');
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  // Files Git writes during the merge keep their committed endings on Windows runners too.
  await git(root, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'both.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'ours-deletes.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'theirs-deletes.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'clean.txt'), 'base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base');
  await git(root, 'checkout', '-b', 'side');
  await fs.writeFile(path.join(root, 'both.txt'), 'side\n');
  await fs.writeFile(path.join(root, 'added.txt'), 'side added\n');
  await fs.writeFile(path.join(root, 'ours-deletes.txt'), 'side change\n');
  await fs.rm(path.join(root, 'theirs-deletes.txt'));
  await git(root, 'add', '-A'); await git(root, 'commit', '-m', 'side');
  await git(root, 'checkout', 'main');
  await fs.writeFile(path.join(root, 'both.txt'), 'main\n');
  await fs.writeFile(path.join(root, 'added.txt'), 'main added\n');
  await fs.rm(path.join(root, 'ours-deletes.txt'));
  await fs.writeFile(path.join(root, 'theirs-deletes.txt'), 'main change\n');
  await fs.writeFile(path.join(root, 'clean.txt'), 'main only\n');
  await git(root, 'add', '-A'); await git(root, 'commit', '-m', 'main');
  await expect(git(root, 'merge', 'side')).rejects.toThrow();
  const { id } = await addProject(root);

  const snapshot = await readProjectGitSnapshot(id);
  const byPath = Object.fromEntries(snapshot.changes.map(change => [change.path, change.status]));
  expect(byPath).toMatchObject({ 'both.txt': 'C', 'added.txt': 'C', 'ours-deletes.txt': 'C', 'theirs-deletes.txt': 'C' });
  await expect(commitProjectGit(id, 'Merge', ['clean.txt'])).rejects.toThrow('Finish the merge');
  const both = await readProjectGitDiff(id, 'both.txt', undefined, snapshot.revision);
  expect(both).toMatchObject({ status: 'C', baseText: 'main\n' });
  expect(both.currentText).toContain('<<<<<<<');
  // Both added: no HEAD version before the merge's own commit on main? main has it, side has it.
  expect((await readProjectGitDiff(id, 'added.txt', undefined, snapshot.revision)).currentText).toContain('>>>>>>>');
  // Deleted on main, changed on side: HEAD has no file, the working tree has theirs.
  expect(await readProjectGitDiff(id, 'ours-deletes.txt', undefined, snapshot.revision)).toMatchObject({ baseText: '', currentText: 'side change\n' });
  // Changed on main, deleted on side: HEAD has it, the working tree keeps ours.
  expect(await readProjectGitDiff(id, 'theirs-deletes.txt', undefined, snapshot.revision)).toMatchObject({ baseText: 'main change\n', currentText: 'main change\n' });
});

it('shows a file renamed differently on both sides as conflicts, even with no working file left', async () => {
  const root = path.join(approved, 'renames');
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  // Files Git writes during the merge keep their committed endings on Windows runners too.
  await git(root, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'moved.txt'), 'shared body\n'.repeat(20));
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base');
  await git(root, 'checkout', '-b', 'side'); await git(root, 'mv', 'moved.txt', 'side-name.txt'); await git(root, 'commit', '-m', 'side');
  await git(root, 'checkout', 'main'); await git(root, 'mv', 'moved.txt', 'main-name.txt'); await git(root, 'commit', '-m', 'main');
  await expect(git(root, 'merge', 'side')).rejects.toThrow();
  const { id } = await addProject(root);
  const snapshot = await readProjectGitSnapshot(id);
  const byPath = Object.fromEntries(snapshot.changes.map(change => [change.path, change.status]));
  expect(byPath['moved.txt']).toBe('C');
  // Deleted on both sides: no working file and no HEAD version, still a readable (empty) diff.
  expect(await readProjectGitDiff(id, 'moved.txt', undefined, snapshot.revision)).toMatchObject({ status: 'C', currentText: '' });
});

const lastSubject = async (root: string): Promise<string> =>
  (await exec('git', ['log', '-1', '--format=%s'], { cwd: root })).stdout.trim();
const headFiles = async (root: string): Promise<string[]> =>
  (await exec('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: root })).stdout.trim().split(/\r?\n/);

it('stages one of two changed files and commits only it, refusing an index Review did not show', async () => {
  const { root, id } = await committedProject();
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 2;\n');
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');
  // Brackets are pathspec glob syntax: staging this file must not also stage `a.ts`.
  await fs.writeFile(path.join(root, '[a].ts'), 'bracketed\n');
  await fs.writeFile(path.join(root, 'a.ts'), 'plain\n');

  await setProjectGitStaged(id, 'added.ts', true);
  await setProjectGitStaged(id, '[a].ts', true);
  let byPath = new Map((await readProjectGitSnapshot(id)).changes.map(change => [change.path, change]));
  expect(byPath.get('added.ts')).toMatchObject({ status: 'A', staged: 'all' });
  expect(byPath.get('[a].ts')).toMatchObject({ status: 'A', staged: 'all' });
  expect(byPath.get('a.ts')).toMatchObject({ status: 'U' });
  expect(byPath.get('a.ts')?.staged).toBeUndefined();
  expect(byPath.get('modified.ts')?.staged).toBeUndefined();

  await setProjectGitStaged(id, '[a].ts', false);
  await git(root, 'add', 'modified.ts');
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 3;\n');
  byPath = new Map((await readProjectGitSnapshot(id)).changes.map(change => [change.path, change]));
  expect(byPath.get('[a].ts')).toMatchObject({ status: 'U' });
  expect(byPath.get('modified.ts')).toMatchObject({ status: 'M', staged: 'partial' });
  // Something else staged modified.ts after Review was read: nothing is committed.
  await expect(commitProjectGit(id, 'Add file', ['added.ts'])).rejects.toThrow('The staged files changed');
  expect(await lastSubject(root)).toBe('baseline');

  await setProjectGitStaged(id, 'modified.ts', false);
  const commit = await commitProjectGit(id, 'Add file', ['added.ts']);
  expect(commit.oid).toBe((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());
  expect(await headFiles(root)).toEqual(['Add file', '', 'added.ts']);
  byPath = new Map((await readProjectGitSnapshot(id)).changes.map(change => [change.path, change]));
  expect(byPath.has('added.ts')).toBe(false);
  expect(byPath.get('modified.ts')).toMatchObject({ status: 'M' });
  await expect(commitProjectGit(id, 'Nothing', ['modified.ts'])).rejects.toThrow('Stage files to commit them.');
});

it('refuses to stage or commit in Read-only mode and says so in the snapshot', async () => {
  const { root, id } = await committedProject();
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');
  await git(root, 'add', 'added.ts');
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }], readOnly: true });

  expect(await readProjectGitSnapshot(id)).toMatchObject({ state: 'ready', readOnly: true });
  await expect(setProjectGitStaged(id, 'added.ts', false)).rejects.toThrow('Read-only mode is on');
  await expect(commitProjectGit(id, 'Add file', ['added.ts'])).rejects.toThrow('Read-only mode is on');
  expect(await lastSubject(root)).toBe('baseline');
  expect((await readProjectGitSnapshot(id)).changes).toMatchObject([{ path: 'added.ts', staged: 'all' }]);
});

it('unstages before the first commit and never commits a file staged outside the project', async () => {
  const root = path.join(approved, 'fresh');
  const nested = path.join(root, 'app');
  await fs.mkdir(nested, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'inside\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside\n');
  const { id } = await addProject(nested);

  await setProjectGitStaged(id, 'inside.txt', true);
  expect((await readProjectGitSnapshot(id)).changes).toMatchObject([{ path: 'inside.txt', status: 'A', staged: 'all' }]);
  await setProjectGitStaged(id, 'inside.txt', false);
  expect((await readProjectGitSnapshot(id)).changes).toMatchObject([{ path: 'inside.txt', status: 'U' }]);

  await setProjectGitStaged(id, 'inside.txt', true);
  await git(root, 'add', 'outside.txt');
  await expect(commitProjectGit(id, 'First', ['inside.txt'])).rejects.toThrow('Files outside this project are staged');
  await expect(exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })).rejects.toThrow();
  await git(root, 'rm', '--cached', '--quiet', 'outside.txt');
  await commitProjectGit(id, 'First', ['inside.txt']);
  expect(await headFiles(root)).toEqual(['First', '', 'app/inside.txt']);
});

it('commits from Review without running repository hooks or a configured signing program', async () => {
  const { root, id } = await committedProject();
  // Hooks and Git config are plain files an agent with file access can write; a Commit click must not run them.
  const marker = path.join(directory, 'ran.txt');
  const script = `#!/bin/sh\necho "$0" >> '${marker.replaceAll(path.sep, '/')}'\n`;
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change']) {
    await fs.writeFile(path.join(root, '.git', 'hooks', hook), script, { mode: 0o755 });
  }
  const signer = path.join(directory, 'signer.sh');
  await fs.writeFile(signer, script, { mode: 0o755 });
  await git(root, 'config', 'commit.gpgSign', 'true');
  await git(root, 'config', 'gpg.program', signer.replaceAll(path.sep, '/'));
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');

  await setProjectGitStaged(id, 'added.ts', true);
  await commitProjectGit(id, 'Add file', ['added.ts']);
  expect(await headFiles(root)).toEqual(['Add file', '', 'added.ts']);
  await expect(fs.readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses to stage a file that goes through a Git filter instead of running the filter', async () => {
  const { root, id } = await committedProject();
  // A clean filter is a command named in .git/config and chosen by .gitattributes: both files an agent can write.
  const marker = path.join(directory, 'filtered.txt');
  const filter = path.join(directory, 'filter.sh');
  await fs.writeFile(filter, `#!/bin/sh\necho ran >> '${marker.split(path.sep).join('/')}'\ncat\n`, { mode: 0o755 });
  await git(root, 'config', 'filter.demo.clean', `sh '${filter.split(path.sep).join('/')}'`);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.dat filter=demo\n');
  await fs.writeFile(path.join(root, 'data.dat'), 'payload\n');

  await expect(setProjectGitStaged(id, 'data.dat', true)).rejects.toThrow('Git filter');
  await expect(fs.readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readProjectGitSnapshot(id)).changes.find(change => change.path === 'data.dat')).toMatchObject({ status: 'U' });
  // A file the filter does not apply to still stages.
  await setProjectGitStaged(id, '.gitattributes', true);
  expect((await readProjectGitSnapshot(id)).changes.find(change => change.path === '.gitattributes')).toMatchObject({ staged: 'all' });
});
