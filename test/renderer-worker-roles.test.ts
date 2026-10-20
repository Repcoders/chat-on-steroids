import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../src/shared/types.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('edits sub-agent roles from the observed catalog and saves only named, distinct rows', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const models = [
    { id: 'sol', label: 'GPT-6', efforts: ['medium', 'high'] },
    { id: 'pro', label: 'GPT-6 Pro', efforts: ['pro'] }
  ];
  Object.assign(dom.window, { api: { getChatModels: async () => ({ ok: true, data: { state: 'ready', observedAt: 2, models } }), requestChatModels: vi.fn() } });
  const { initChatModels, applyChatModels } = await import('../src/renderer/chat-models.js');
  const { applyWorkerRoles, initWorkerRoles, workerRolesValue } = await import('../src/renderer/worker-roles.js');
  const config = { multiAgent: { roles: [{ name: 'Reviewer', model: 'pro', reasoning: 'pro' }, { name: 'Old', model: 'retired', reasoning: 'high' }] }, goal: {} } as unknown as Config;
  initChatModels(); applyChatModels(config);
  await new Promise(resolve => setTimeout(resolve, 0));
  const save = vi.fn();
  initWorkerRoles(save); applyWorkerRoles(config);
  const doc = dom.window.document;
  const rows = () => [...doc.querySelectorAll<HTMLElement>('#workerRoles .worker-role')];
  const selects = (row: HTMLElement) => [...row.querySelectorAll('select')];
  expect(rows()).toHaveLength(2);
  expect(selects(rows()[0]!).map(select => select.value)).toEqual(['pro', 'pro']);
  // A saved model this account no longer offers stays visible as unverified, not swapped.
  expect(selects(rows()[1]!)[0]!.selectedOptions[0]!.textContent).toBe('retired · not verified');
  expect(workerRolesValue()).toEqual(config.multiAgent.roles);

  (doc.getElementById('addWorkerRole') as HTMLButtonElement).click();
  const added = rows()[2]!;
  const name = added.querySelector<HTMLInputElement>('.worker-role-name')!;
  expect(doc.activeElement).toBe(name);
  // A new row starts on an observed model; until it has a name it is not saved.
  expect(selects(added).map(select => select.value)).toEqual(['sol', 'high']);
  expect(workerRolesValue()).toHaveLength(2);
  name.value = ' reviewer ';
  name.dispatchEvent(new dom.window.Event('change'));
  expect(save).toHaveBeenCalledTimes(1);
  expect(workerRolesValue().map(role => role.name)).toEqual(['Reviewer', 'Old']);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  name.value = 'Scout';
  expect(workerRolesValue()).toEqual([...config.multiAgent.roles!, { name: 'Scout', model: 'sol', reasoning: 'high' }]);
  expect(name.hasAttribute('aria-invalid')).toBe(false);

  // The echo of this save repaints nothing, so the row being written survives.
  name.blur();
  applyWorkerRoles({ ...config, multiAgent: { roles: workerRolesValue() } } as unknown as Config);
  expect(rows()[2]).toBe(added);
  added.querySelector<HTMLButtonElement>('button')!.click();
  expect(save).toHaveBeenCalledTimes(2);
  expect(rows()).toHaveLength(2);
});
