import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDemoFolder, removeDemoFolder, type DemoFolder } from '../src/main/demo-folder.js';
import { DEMO_AFTER, DEMO_BEFORE } from '../src/shared/demo-folder.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string | null = null;
afterEach(async () => { if (dir) await removeTempDir(dir); dir = null; });

/** Runs the command the chat is asked to run, in the demo folder, through this platform's shell. */
function runCheck(demo: DemoFolder): Promise<{ code: number; out: string }> {
  const [file, args] = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', demo.run]]
    : ['/bin/sh', ['-c', demo.run]];
  return new Promise(resolve => execFile(file, args, { cwd: demo.folder }, (error, stdout) => {
    resolve({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, out: stdout.trim() });
  }));
}

it('makes Setup’s demo folder with a file to edit and a check that passes only after the edit', async () => {
  dir = await makeTempDir();
  const demo = await createDemoFolder(dir);
  expect(path.basename(demo.folder)).toBe('demo');
  expect(path.basename(path.dirname(demo.folder))).toMatch(/^cos-demo-/);
  // POSIX runs the script through sh, so a temp folder mounted noexec still works.
  expect(demo.run).toBe(process.platform === 'win32' ? '.\\check.cmd' : 'sh ./check.sh');
  const text = path.join(demo.folder, 'demo.txt');
  expect(await fs.readFile(text, 'utf8')).toBe(`Chat On Steroids demo\n${DEMO_BEFORE}\n`);

  const before = await runCheck(demo);
  expect(before.code).toBe(1);
  expect(before.out).toMatch(/^FAIL: /);
  await fs.writeFile(text, `Chat On Steroids demo\n${DEMO_AFTER}\n`);
  expect(await runCheck(demo)).toEqual({ code: 0, out: `PASS: demo.txt says "${DEMO_AFTER}".` });
  // Windows line endings, as an editor there may save them.
  await fs.writeFile(text, `Chat On Steroids demo\r\n${DEMO_AFTER}\r\n`);
  expect((await runCheck(demo)).code).toBe(0);

  // A second demo never reuses or overwrites the first one.
  const again = await createDemoFolder(dir);
  expect(again.folder).not.toBe(demo.folder);
  expect(await fs.readFile(text, 'utf8')).toContain(DEMO_AFTER);
  await removeDemoFolder(again.parent);
  await expect(fs.stat(again.parent)).rejects.toThrow();
});

it('fails the demo check unless the old line was replaced by the new one as a whole line', async () => {
  dir = await makeTempDir();
  const demo = await createDemoFolder(dir);
  const text = path.join(demo.folder, 'demo.txt');
  for (const edited of [
    `Chat On Steroids demo\n${DEMO_BEFORE}\n${DEMO_AFTER}\n`,
    `Chat On Steroids demo\n${DEMO_AFTER} soon\n`,
    'Chat On Steroids demo\n'
  ]) {
    await fs.writeFile(text, edited);
    const result = await runCheck(demo);
    expect(result.code, edited).toBe(1);
    expect(result.out, edited).toMatch(/^FAIL: /);
  }
});
