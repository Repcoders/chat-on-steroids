import type { Config } from '../shared/types.js';
import { MAX_WORKER_ROLES, MAX_WORKER_ROLE_NAME_CHARS, type WorkerRole } from '../shared/worker-roles.js';
import { trackModelPair } from './chat-models.js';
import { $, el } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * Settings → ChatGPT models: the named sub-agent roles the agents tool selects with
 * `workers[].role`. Each row is a name plus a model/reasoning pair painted from the same
 * observed catalog as the default sub-agent pair, so a role offers only what the account has.
 */
let save: () => void = () => {};
let painted = '[]';
let rows = 0;
const untrack = new Map<Element, () => void>();

function paintAdd(): void {
  $<HTMLButtonElement>('addWorkerRole').disabled = $('workerRoles').children.length >= MAX_WORKER_ROLES;
}

function drop(row: Element): void {
  untrack.get(row)?.();
  untrack.delete(row);
  row.remove();
}

function addRow(role: WorkerRole): HTMLInputElement {
  const n = ++rows;
  const row = el('div', 'worker-role');
  const name = el('input', 'worker-role-name') as HTMLInputElement;
  name.type = 'text';
  name.maxLength = MAX_WORKER_ROLE_NAME_CHARS;
  name.value = role.name;
  ui(name, 'placeholder', () => t('Role name, e.g. Reviewer'));
  ui(name, 'aria-label', () => t('Role name'));
  const model = el('select') as HTMLSelectElement;
  model.id = `workerRoleModel${n}`;
  ui(model, 'aria-label', () => t('Role model'));
  const effort = el('select') as HTMLSelectElement;
  effort.id = `workerRoleReasoning${n}`;
  ui(effort, 'aria-label', () => t('Role reasoning'));
  const remove = el('button', 'btn', () => t('Remove'));
  remove.setAttribute('type', 'button');
  ui(remove, 'aria-label', () => t('Remove role {0}', [name.value.trim()]));
  row.append(name, model, effort, remove);
  // Painting looks the selects up by id, so the row is in the document first.
  $('workerRoles').append(row);
  untrack.set(row, trackModelPair(model.id, effort.id, role.model, role.reasoning));
  for (const control of [name, model, effort]) control.addEventListener('change', () => save());
  remove.addEventListener('click', () => { drop(row); paintAdd(); save(); });
  paintAdd();
  return name;
}

export function initWorkerRoles(onSave: () => void): void {
  save = onSave;
  $('addWorkerRole').addEventListener('click', () => addRow({ name: '', model: '', reasoning: '' }).focus());
  paintAdd();
}

/** Repaints from config unless the rows already show it or the person is editing them. */
export function applyWorkerRoles(config: Config): void {
  const roles = config.multiAgent.roles ?? [];
  const key = JSON.stringify(roles);
  const list = $('workerRoles');
  if (key === painted || list.contains(document.activeElement)) return;
  painted = key;
  for (const row of [...list.children]) drop(row);
  for (const role of roles) addRow(role);
  paintAdd();
}

/**
 * The roles the rows describe, for the settings save. A row without a name is still being
 * written and a repeated name would make the lookup ambiguous, so neither is saved.
 */
export function workerRolesValue(): WorkerRole[] {
  const roles: WorkerRole[] = [];
  const names = new Set<string>();
  for (const row of $('workerRoles').children) {
    const name = row.querySelector<HTMLInputElement>('.worker-role-name')!;
    const [model, effort] = [...row.querySelectorAll('select')];
    const value = name.value.trim();
    const repeated = names.has(value.toLowerCase());
    if (repeated) {
      name.setAttribute('aria-invalid', 'true');
      ui(name, 'title', () => t('Another role already has this name'));
    } else {
      name.removeAttribute('aria-invalid');
      ui(name, 'title', () => '');
    }
    if (!value || repeated) continue;
    names.add(value.toLowerCase());
    roles.push({ name: value, model: model!.value, reasoning: effort!.value as WorkerRole['reasoning'] });
  }
  // What this save proposes is what the rows show; its echo from main repaints nothing.
  painted = JSON.stringify(roles);
  return roles;
}
