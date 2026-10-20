import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDemoFolder, removeDemoFolder } from '../src/main/demo-folder.js';
import { DEMO_AFTER, DEMO_BEFORE } from '../src/shared/demo-folder.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string | null = null;
afterEach(async () => { if (dir) await removeTempDir(dir); dir = null; });

/** Runs the folder's check the way this platform's shell would, from another folder. */
function runCheck(folder: string): Promise<{ code: number; out: string }> {
  const [file, args] = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', path.join(folder, 'check.cmd')]]
    : ['/bin/sh', [path.join(folder, 'check.sh')]];
  return new Promise(resolve => execFile(file, args, { cwd: path.dirname(folder) }, (error, stdout) => {
    resolve({ code: error ? Number((error as NodeJS.ErrnoException & { code?: unknown }).code ?? 1) : 0, out: stdout.trim() });
  }));
}

it('makes Setup’s demo folder with a file to edit and a check that passes only after the edit', async () => {
  dir = await makeTempDir();
  const demo = await createDemoFolder(dir);
  expect(path.basename(demo.folder)).toBe('demo');
  expect(path.basename(path.dirname(demo.folder))).toMatch(/^cos-demo-/);
  expect(demo.run).toBe(process.platform === 'win32' ? '.\\check.cmd' : './check.sh');
  const text = path.join(demo.folder, 'demo.txt');
  expect(await fs.readFile(text, 'utf8')).toBe(`Chat On Steroids demo\n${DEMO_BEFORE}\n`);

  const before = await runCheck(demo.folder);
  expect(before.code).toBe(1);
  expect(before.out).toMatch(/^FAIL: /);
  await fs.writeFile(text, `Chat On Steroids demo\n${DEMO_AFTER}\n`);
  expect(await runCheck(demo.folder)).toEqual({ code: 0, out: `PASS: demo.txt says "${DEMO_AFTER}".` });

  // A second demo never reuses or overwrites the first one.
  const again = await createDemoFolder(dir);
  expect(again.folder).not.toBe(demo.folder);
  expect(await fs.readFile(text, 'utf8')).toContain(DEMO_AFTER);
  await removeDemoFolder(again.parent);
  await expect(fs.stat(again.parent)).rejects.toThrow();
});
