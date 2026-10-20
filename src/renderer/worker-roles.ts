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
  // Empty is a real choice here: that half follows the default sub-agent setting.
  untrack.set(row, trackModelPair(model.id, effort.id, role.model, role.reasoning, () => t('Sub-agent default')));
  for (const control of [name, model, effort]) control.addEventListener('change', () => save());
  remove.addEventListener('click', () => { drop(row); paintAdd(); save(); });
  paintAdd();
  return name;
}

export function initWorkerRoles(onSave: () => void): void {
  save = onSave;
  // A new role starts from the default sub-agent pair, the closest thing to what it will change.
  $('addWorkerRole').addEventListener('click', () => {
    const name = addRow({
      name: '', model: $<HTMLSelectElement>('workerModel').value, reasoning: $<HTMLSelectElement>('workerReasoning').value as WorkerRole['reasoning']
    });
    // Not yet named is a draft, not a mistake; it stops being one once a name is typed.
    name.dataset.draft = 'true';
    name.addEventListener('input', () => { if (name.value.trim()) delete name.dataset.draft; });
    name.focus();
  });
  paintAdd();
}

/** Repaints from config unless the rows already show it or the person has edited them. */
export function applyWorkerRoles(config: Config): void {
  const roles = config.multiAgent.roles ?? [];
  const key = JSON.stringify(roles);
  const list = $('workerRoles');
  // Focus alone does not protect the rows: unedited ones still take a newer saved list. A row
  // added and not yet named is an edit too.
  const edited = JSON.stringify(rowValues().roles) !== painted || !!list.querySelector('.worker-role-name[data-draft]');
  if (key === painted || (list.contains(document.activeElement) && edited)) return;
  painted = key;
  for (const row of [...list.children]) drop(row);
  for (const role of roles) addRow(role);
  paintAdd();
}

/**
 * The roles the rows describe, for the settings save. A row without a name is still being
 * written and a repeated name would make the lookup ambiguous, so neither is saved.
 */
function rowValues(): { roles: WorkerRole[]; repeated: Set<HTMLInputElement> } {
  const roles: WorkerRole[] = [];
  const repeated = new Set<HTMLInputElement>();
  const names = new Set<string>();
  for (const row of $('workerRoles').children) {
    const name = row.querySelector<HTMLInputElement>('.worker-role-name')!;
    const [model, effort] = [...row.querySelectorAll('select')];
    const value = name.value.trim();
    if (names.has(value.toLowerCase())) repeated.add(name);
    if (!value || repeated.has(name)) continue;
    names.add(value.toLowerCase());
    roles.push({ name: value, model: model!.value, reasoning: effort!.value as WorkerRole['reasoning'] });
  }
  return { roles, repeated };
}

export function workerRolesValue(): WorkerRole[] {
  const { roles, repeated } = rowValues();
  for (const name of $('workerRoles').querySelectorAll<HTMLInputElement>('.worker-role-name')) {
    if (repeated.has(name)) {
      name.setAttribute('aria-invalid', 'true');
      ui(name, 'title', () => t('Another role already has this name'));
    } else if (!name.value.trim() && !name.dataset.draft) {
      name.setAttribute('aria-invalid', 'true');
      ui(name, 'title', () => t('A role needs a name to be saved'));
    } else {
      name.removeAttribute('aria-invalid');
      ui(name, 'title', () => '');
    }
  }
  // What this save proposes is what the rows show; its echo from main repaints nothing.
  painted = JSON.stringify(roles);
  return roles;
}
