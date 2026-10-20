import path from 'node:path';
import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import { DEMO_AFTER, DEMO_BEFORE } from '../shared/demo-folder.js';

export interface DemoFolder {
  /** The new temporary folder holding `folder`; removing it removes the whole demo. */
  parent: string;
  /** The folder to share, canonical, with `demo.txt` and the check in it. */
  folder: string;
  /** How the chat's shell runs the check from inside `folder`. */
  run: string;
}

/**
 * Setup's Try a demo: one file to read and edit and a check to run, in a new temporary folder each
 * time, so nothing of the person's is ever overwritten. The check is a plain shell script (cmd on
 * Windows, sh elsewhere), since Node may not be installed.
 */
export async function createDemoFolder(tempDir: string, platform: NodeJS.Platform = process.platform): Promise<DemoFolder> {
  const parent = await fs.mkdtemp(path.join(tempDir, 'cos-demo-'));
  try {
    const folder = path.join(parent, 'demo');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'demo.txt'), `Chat On Steroids demo\n${DEMO_BEFORE}\n`);
    const pass = `PASS: demo.txt says "${DEMO_AFTER}".`;
    const fail = `FAIL: demo.txt does not say "${DEMO_AFTER}" yet.`;
    if (platform === 'win32') {
      await fs.writeFile(path.join(folder, 'check.cmd'), [
        '@echo off', 'cd /d "%~dp0"', `findstr /c:"${DEMO_AFTER}" demo.txt >nul`,
        `if errorlevel 1 (`, `  echo ${fail}`, '  exit /b 1', ')', `echo ${pass}`, ''
      ].join('\r\n'));
    } else {
      await fs.writeFile(path.join(folder, 'check.sh'), [
        '#!/bin/sh', 'cd "$(dirname "$0")" || exit 1',
        `if grep -q '${DEMO_AFTER}' demo.txt; then echo '${pass}'; else echo '${fail}'; exit 1; fi`, ''
      ].join('\n'), { mode: 0o755 });
    }
    return { parent, folder: await rawRealpathNative(folder), run: platform === 'win32' ? '.\\check.cmd' : './check.sh' };
  } catch (error) {
    await removeDemoFolder(parent);
    throw error;
  }
}

export async function removeDemoFolder(parent: string): Promise<void> {
  await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
}
