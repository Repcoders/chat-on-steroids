import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Runs just before every Git process Review starts, so a test can stage a file in the gap between
// Review's checks and its commit, as an agent's own `git add` could.
const beforeGit = vi.hoisted(() => ({ run: null as ((args: readonly string[]) => void) | null }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      beforeGit.run?.(args);
      return actual.spawn(command, args, options);
    }) as typeof actual.spawn
  };
});

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const { commitProjectGit } = await import('../src/main/project-git.js');
const { addProject } = await import('../src/main/projects.js');
const { validateNewRoot } = await import('../src/main/sandbox.js');

const exec = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-git-race-'));
  await fs.mkdir(path.join(directory, 'approved'));
  const approved = await validateNewRoot(path.join(directory, 'approved'), []);
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  beforeGit.run = null;
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('commits the index Review checked, even when another file is staged before the commit is written', async () => {
  const root = path.join(directory, 'approved', 'repo');
  const nested = path.join(root, 'app');
  await fs.mkdir(nested, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'inside\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside\n');
  await fs.writeFile(path.join(nested, 'late.txt'), 'late\n');
  git('add', 'app/inside.txt');
  const { id } = await addProject(nested);

  // Every check has run by the time Git is asked to make the commit object.
  beforeGit.run = args => {
    if (!args.includes('commit') && !args.includes('commit-tree')) return;
    beforeGit.run = null;
    git('add', 'outside.txt', 'app/late.txt');
  };
  await commitProjectGit(id, 'Inside only', ['inside.txt']);
  expect((await exec('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: root })).stdout.trim().split(/\r?\n/))
    .toEqual(['Inside only', '', 'app/inside.txt']);
  // The files staged meanwhile stay staged for the next commit.
  expect((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/))
    .toEqual(['app/late.txt', 'outside.txt']);
});
