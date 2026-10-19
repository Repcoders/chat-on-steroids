import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Project scripts: named one-line commands a project's menu runs in a new workspace terminal.
 * The dialog saves the list through the main process; running one opens a terminal bound to the
 * script's own project and types the command, as a person would.
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {};
    loadAddon(): void {} open(): void {} focus(): void {} dispose(): void {} write(): void {} writeln(): void {}
    onData(): void {} attachCustomKeyEventHandler(): void {} hasSelection(): boolean { return false; } getSelection(): string { return ''; }
  }
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: (run: () => void) => setTimeout(run, 0), ResizeObserver: class { observe(): void {} disconnect(): void {} }
  });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const project = { id: '00000000-0000-4000-8000-000000000001', name: 'app', path: 'C:\\Users\\you\\app', createdAt: 1 };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const rows = () => [...document.querySelectorAll<HTMLElement>('#projectScriptsList .project-script-row')];
const type = (row: HTMLElement, name: string, command: string) => {
  row.querySelector<HTMLInputElement>('.project-script-name')!.value = name;
  row.querySelector<HTMLInputElement>('.project-script-command')!.value = command;
};
const submit = async () => { $('projectScriptsForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await flush(); };

it('saves trimmed scripts, drops rows left empty and hands the saved project over', async () => {
  const { initProjectScriptsDialog } = await import('../src/renderer/project-scripts-dialog.js');
  const saved = { ...project, scripts: [{ name: 'dev', command: 'npm run dev' }, { name: 'test', command: 'npm test' }] };
  const setProjectScripts = vi.fn(async () => ({ ok: true as const, data: saved }));
  const onSaved = vi.fn();
  initProjectScriptsDialog({ setProjectScripts } as any, onSaved).open({ ...project, scripts: [{ name: 'dev', command: 'npm run dev' }] });
  expect($<HTMLDialogElement>('projectScriptsDialog').open).toBe(true);
  expect(rows()).toHaveLength(1);
  $('projectScriptsAdd').click(); $('projectScriptsAdd').click();
  type(rows()[1]!, ' test ', ' npm test ');
  await submit();
  expect(setProjectScripts).toHaveBeenCalledWith(project.id, saved.scripts);
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect($<HTMLDialogElement>('projectScriptsDialog').open).toBe(false);
});

it('asks for both a name and a command, and keeps the main process explanation inline', async () => {
  const { initProjectScriptsDialog } = await import('../src/renderer/project-scripts-dialog.js');
  const setProjectScripts = vi.fn(async () => ({ ok: false as const, error: 'Project not found' }));
  const onSaved = vi.fn();
  initProjectScriptsDialog({ setProjectScripts } as any, onSaved).open(project);
  type(rows()[0]!, '', 'npm run dev');
  await submit();
  expect(setProjectScripts).not.toHaveBeenCalled();
  expect($('projectScriptsError').hidden).toBe(false);
  type(rows()[0]!, 'dev', 'npm run dev');
  await submit();
  expect(setProjectScripts).toHaveBeenCalledOnce();
  expect($('projectScriptsError').textContent).toBe('Project not found');
  expect($<HTMLDialogElement>('projectScriptsDialog').open).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
});

it("runs a script in a new terminal of the script's own project and types its command once", async () => {
  const terminalCreate = vi.fn(async () => ({ ok: true as const, data: { shell: 'pwsh', cwd: project.path } }));
  const terminalWrite = vi.fn(async () => ({ ok: true as const, data: true }));
  Object.assign(dom.window, { api: { terminalCreate, terminalWrite, terminalResize: vi.fn(), terminalClose: vi.fn(), terminalAck: vi.fn(), onTerminalEvent: () => () => {} } });
  const { createWorkspaceTerminal } = await import('../src/renderer/workspace-terminal.js');
  const terminal = createWorkspaceTerminal(vi.fn(), $('app') ?? document.body);
  terminal.update({ ...project, id: '00000000-0000-4000-8000-000000000002', name: 'selected' });
  const id = terminal.run(project, { name: 'dev', command: 'npm run dev' });
  await flush();
  expect(terminalCreate).toHaveBeenCalledWith(id, project.id, 80, 24);
  expect(terminalWrite).toHaveBeenCalledOnce();
  expect(terminalWrite).toHaveBeenCalledWith(id, 'npm run dev\r');
  expect(terminal.tabs()).toEqual([{ id, title: 'app · dev', exited: false }]);
});
