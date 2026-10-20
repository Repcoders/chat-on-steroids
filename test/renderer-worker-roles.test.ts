import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';
import type { WorkerRole } from '../src/shared/worker-roles.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function settings(roles: WorkerRole[]) {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'sol', label: 'GPT-6', efforts: ['medium', 'high'] },
    { id: 'pro', label: 'GPT-6 Pro', efforts: ['pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', observedAt: 2, models } }), requestChatModels: vi.fn() } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  const worker = await import('../src/renderer/worker-roles.js');
  const config = { multiAgent: { defaultModel: 'sol', defaultReasoning: 'medium', roles }, goal: {} } as unknown as Config;
  initChatModels(); applyChatModels(config);
  await new Promise(resolve => setTimeout(resolve, 0));
  const save = vi.fn();
  worker.initWorkerRoles(save); worker.applyWorkerRoles(config);
  const doc = dom.window.document;
  const rows = () => [...doc.querySelectorAll<HTMLElement>('#workerRoles .worker-role')];
  const selects = (row: HTMLElement) => [...row.querySelectorAll('select')];
  const withRoles = (next: WorkerRole[]) => ({ ...config, multiAgent: { ...config.multiAgent, roles: next } }) as unknown as Config;
  return { ...worker, save, doc, rows, selects, withRoles };
}

it('edits sub-agent roles from the observed catalog and saves only named, distinct rows', async () => {
  const roles: WorkerRole[] = [{ name: 'Reviewer', model: 'pro', reasoning: 'pro' }, { name: 'Old', model: 'retired', reasoning: 'high' }];
  const { applyWorkerRoles, workerRolesValue, save, doc, rows, selects, withRoles } = await settings(roles);
  expect(rows()).toHaveLength(2);
  expect(selects(rows()[0]!).map(select => select.value)).toEqual(['pro', 'pro']);
  // A saved model this account no longer offers stays visible as unverified, not swapped.
  expect(selects(rows()[1]!)[0]!.selectedOptions[0]!.textContent).toBe('retired · not verified');
  expect(workerRolesValue()).toEqual(roles);

  (doc.getElementById('addWorkerRole') as HTMLButtonElement).click();
  const added = rows()[2]!;
  const name = added.querySelector<HTMLInputElement>('.worker-role-name')!;
  expect(doc.activeElement).toBe(name);
  // A new row starts from the default sub-agent pair; until it has a name it is not saved.
  expect(selects(added).map(select => select.value)).toEqual(['sol', 'medium']);
  expect(workerRolesValue()).toHaveLength(2);
  name.value = ' reviewer ';
  name.dispatchEvent(new dom.window.Event('change'));
  expect(save).toHaveBeenCalledTimes(1);
  expect(workerRolesValue().map(role => role.name)).toEqual(['Reviewer', 'Old']);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  name.value = 'Scout';
  expect(workerRolesValue()).toEqual([...roles, { name: 'Scout', model: 'sol', reasoning: 'medium' }]);
  expect(name.hasAttribute('aria-invalid')).toBe(false);

  // The echo of this save repaints nothing, so the row being written survives.
  name.blur();
  applyWorkerRoles(withRoles(workerRolesValue()));
  expect(rows()[2]).toBe(added);
  added.querySelector<HTMLButtonElement>('button')!.click();
  expect(save).toHaveBeenCalledTimes(2);
  expect(rows()).toHaveLength(2);
});

// Review finding: an empty half of a saved role was repainted onto the preferred model, and the
// next unrelated save pinned the role to it.
it('keeps an empty model or reasoning in a saved role as the sub-agent default', async () => {
  const roles: WorkerRole[] = [{ name: 'Scout', model: '', reasoning: '' }, { name: 'Reviewer', model: 'sol', reasoning: '' }];
  const { workerRolesValue, rows, selects } = await settings(roles);
  expect(rows().map(row => selects(row).map(select => select.value))).toEqual([['', ''], ['sol', '']]);
  expect(selects(rows()[0]!).map(select => select.selectedOptions[0]!.textContent)).toEqual(['Sub-agent default', 'Sub-agent default']);
  expect(workerRolesValue()).toEqual(roles);
});

// Review finding: clearing a saved role's name dropped it from the next save with nothing on screen.
it('marks a saved role whose name was cleared, but not a new row that has no name yet', async () => {
  const { workerRolesValue, doc, rows } = await settings([{ name: 'Reviewer', model: 'pro', reasoning: 'pro' }]);
  const saved = rows()[0]!.querySelector<HTMLInputElement>('.worker-role-name')!;
  saved.value = ' ';
  (doc.getElementById('addWorkerRole') as HTMLButtonElement).click();
  const fresh = rows()[1]!.querySelector<HTMLInputElement>('.worker-role-name')!;
  expect(workerRolesValue()).toEqual([]);
  expect(saved.getAttribute('aria-invalid')).toBe('true');
  expect(saved.title).toBe('A role needs a name to be saved');
  expect(fresh.hasAttribute('aria-invalid')).toBe(false);
});

// Review finding: focus inside the list kept a newer saved list out even when nothing was edited.
it('repaints focused rows that were not edited, and keeps rows that were', async () => {
  const roles: WorkerRole[] = [{ name: 'Reviewer', model: 'pro', reasoning: 'pro' }];
  const { applyWorkerRoles, doc, rows, withRoles } = await settings(roles);
  const name = () => rows()[0]!.querySelector<HTMLInputElement>('.worker-role-name')!;
  name().focus();
  applyWorkerRoles(withRoles([{ name: 'Critic', model: 'pro', reasoning: 'pro' }]));
  expect(name().value).toBe('Critic');
  name().focus();
  name().value = 'Critic, edited';
  expect(doc.activeElement).toBe(name());
  applyWorkerRoles(withRoles([{ name: 'Elsewhere', model: 'sol', reasoning: 'high' }]));
  expect(name().value).toBe('Critic, edited');
});
