import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/types.js';
import type { WorkspaceProfile } from '../src/shared/workspace-profiles.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

const overnight: WorkspaceProfile = { id: 'p-overnight', name: 'Overnight', settings: { turnNotifications: false, keepAwake: 'computer', backgroundPlacement: 'window' } };
const review: WorkspaceProfile = { id: 'p-review', name: 'Review', settings: { turnNotifications: true, keepAwake: 'off', backgroundPlacement: 'group' } };
const withProfiles = (workspaceProfiles: WorkspaceProfile[]) => ({ config: { workspaceProfiles } }) as unknown as AppState;

it('lists the saved profiles with their settings, and saves and deletes them after the form’s own saves', async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  const w = dom.window;
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLDialogElement'] as const) vi.stubGlobal(key, w[key]);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { initWorkspaceProfiles } = await import('../src/renderer/workspace-profiles.js');

  const order: string[] = [];
  let pending = (): void => undefined;
  const settled = vi.fn(() => new Promise<void>(resolve => { pending = () => { order.push('form saved'); resolve(); }; }));
  const saveWorkspaceProfile = vi.fn(async (name: string) => { order.push(`save ${name}`); return { ok: true as const, data: withProfiles([overnight, review]) }; });
  const removeWorkspaceProfile = vi.fn(async (id: string) => { order.push(`remove ${id}`); return { ok: true as const, data: withProfiles([review]) }; });
  const applied: AppState[] = [];
  const paint = initWorkspaceProfiles({ api: { saveWorkspaceProfile, removeWorkspaceProfile }, settled, apply: next => { applied.push(next); paint(next); } });

  const document = w.document;
  const rows = () => [...document.querySelectorAll('#workspaceProfileList .workspace-profile-row')]
    .map(row => `${row.querySelector('b')!.textContent} | ${row.querySelector('em')!.textContent}`);
  paint(withProfiles([overnight]));
  expect(rows()).toEqual([
    'Overnight | Notify when a chat finishes: Off · Keep awake while a chat works: The computer · Background tabs open in: Their own minimized window'
  ]);
  expect(document.querySelector('#workspaceProfileList button')!.getAttribute('aria-label')).toBe('Delete profile: Overnight');

  (document.getElementById('workspaceProfileAdd') as HTMLButtonElement).click();
  const dialog = document.getElementById('workspaceProfileDialog') as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  const name = document.getElementById('workspaceProfileName') as HTMLInputElement;
  name.value = '   ';
  document.getElementById('workspaceProfileForm')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  expect(settled).not.toHaveBeenCalled();
  name.value = ' Review ';
  document.getElementById('workspaceProfileForm')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
  expect(saveWorkspaceProfile).not.toHaveBeenCalled();
  expect((document.getElementById('workspaceProfileAdd') as HTMLButtonElement).disabled).toBe(true);
  pending();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(order).toEqual(['form saved', 'save Review']);
  expect(name.value).toBe('');
  expect(rows().map(row => row.split(' | ')[0])).toEqual(['Overnight', 'Review']);
  expect((document.getElementById('workspaceProfileAdd') as HTMLButtonElement).disabled).toBe(false);

  settled.mockImplementation(async () => undefined);
  (document.querySelector('[data-remove-workspace-profile="p-overnight"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(removeWorkspaceProfile).toHaveBeenCalledWith('p-overnight'));
  await vi.waitFor(() => expect(rows().map(row => row.split(' | ')[0])).toEqual(['Review']));
  expect(applied).toHaveLength(2);
});

it('keeps the dialog open with the name when the save is refused', async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  const w = dom.window;
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLDialogElement'] as const) vi.stubGlobal(key, w[key]);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { initWorkspaceProfiles } = await import('../src/renderer/workspace-profiles.js');
  const saveWorkspaceProfile = vi.fn(async () => ({ ok: false as const, error: 'Workspace profile limit reached' }));
  const paint = initWorkspaceProfiles({ api: { saveWorkspaceProfile, removeWorkspaceProfile: vi.fn() }, settled: async () => undefined, apply: vi.fn() });
  paint(withProfiles([]));
  const document = w.document;
  (document.getElementById('workspaceProfileAdd') as HTMLButtonElement).click();
  (document.getElementById('workspaceProfileName') as HTMLInputElement).value = 'Ninth';
  document.getElementById('workspaceProfileForm')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(saveWorkspaceProfile).toHaveBeenCalledWith('Ninth'));
  await vi.waitFor(() => expect((document.getElementById('workspaceProfileAdd') as HTMLButtonElement).disabled).toBe(false));
  expect((document.getElementById('workspaceProfileDialog') as HTMLDialogElement).open).toBe(true);
  expect((document.getElementById('workspaceProfileName') as HTMLInputElement).value).toBe('Ninth');
});
