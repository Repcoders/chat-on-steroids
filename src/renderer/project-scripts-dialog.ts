import type { AppApi } from '../preload/index.js';
import { PROJECT_SCRIPT_LIMITS, type LocalProject, type ProjectScript } from '../shared/projects.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * Editing a project's scripts: named one-line commands its menu runs in a new workspace terminal.
 * Rows left entirely empty are dropped; the main process checks the rest again before saving.
 */
export function initProjectScriptsDialog(
  api: Pick<AppApi, 'setProjectScripts'>,
  onSaved: (project: LocalProject) => void
): { open(project: LocalProject): void } {
  const dialog = document.getElementById('projectScriptsDialog') as HTMLDialogElement;
  const form = document.getElementById('projectScriptsForm') as HTMLFormElement;
  const title = document.getElementById('projectScriptsTitle')!;
  const list = document.getElementById('projectScriptsList')!;
  const add = document.getElementById('projectScriptsAdd') as HTMLButtonElement;
  const error = document.getElementById('projectScriptsError')!;
  const submit = document.getElementById('projectScriptsSubmit') as HTMLButtonElement;
  // Each open() starts a new session; a save's reply only closes or reports in the session that sent it.
  let projectId: string | null = null, busy = false, session = 0;

  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showError = (message: string | null) => { error.hidden = !message; error.textContent = message ?? ''; };
  const rows = () => [...list.querySelectorAll<HTMLElement>('.project-script-row')];
  const field = (className: string, label: () => string, value: string, max: number) => {
    const input = el('input', className) as HTMLInputElement;
    input.type = 'text'; input.value = value; input.maxLength = max; input.spellcheck = false; input.autocomplete = 'off';
    ui(input, 'placeholder', label); ui(input, 'aria-label', label);
    return input;
  };
  const addRow = (script: ProjectScript = { name: '', command: '' }): HTMLInputElement => {
    const row = el('div', 'project-script-row');
    const name = field('project-script-name', () => t('Name'), script.name, PROJECT_SCRIPT_LIMITS.name);
    const command = field('project-script-command', () => t('Command'), script.command, PROJECT_SCRIPT_LIMITS.command);
    const remove = el('button', 'btn btn-icon') as HTMLButtonElement;
    remove.type = 'button'; remove.append(icon('i-trash'));
    ui(remove, 'title', () => t('Remove script')); ui(remove, 'aria-label', () => t('Remove script'));
    remove.addEventListener('click', () => {
      row.remove();
      if (!rows().length) addRow();
      paintAdd();
    });
    row.append(name, command, remove); list.append(row); paintAdd();
    return name;
  };
  const paintAdd = () => { add.disabled = rows().length >= PROJECT_SCRIPT_LIMITS.count; };
  const setBusy = (next: boolean) => {
    busy = next; submit.disabled = next;
    submit.textContent = next ? t('Saving…') : t('Save');
    // Rows stay as sent until the reply, so the dialog never closes over edits it did not save.
    for (const control of list.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = next;
    if (next) add.disabled = true; else paintAdd();
  };

  add.addEventListener('click', () => addRow().focus());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !projectId) return;
    const scripts = rows().map(row => ({
      name: row.querySelector<HTMLInputElement>('.project-script-name')!.value.trim(),
      command: row.querySelector<HTMLInputElement>('.project-script-command')!.value.trim()
    })).filter(script => script.name || script.command);
    if (scripts.some(script => !script.name || !script.command)) { showError(t('Give every script a name and a command')); return; }
    showError(null);
    setBusy(true);
    const mine = session;
    try {
      const reply = await api.setProjectScripts(projectId, scripts);
      // Saved after the dialog was closed or reopened: the list still updates, the newer session stays.
      if (mine !== session) { if (reply.ok) onSaved(reply.data); return; }
      if (!reply.ok) { showError(reply.error); return; }
      close();
      onSaved(reply.data);
    } catch (failure) {
      if (mine === session) showError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mine === session) setBusy(false);
    }
  });
  for (const id of ['projectScriptsCancel', 'projectScriptsClose']) document.getElementById(id)!.addEventListener('click', () => close());

  return {
    open(project) {
      session++;
      projectId = project.id;
      title.textContent = t('Scripts for {0}', [project.name]);
      list.replaceChildren();
      for (const script of project.scripts ?? []) addRow(script);
      const first = rows().length ? null : addRow();
      showError(null);
      setBusy(false);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      (first ?? list.querySelector<HTMLInputElement>('input'))?.focus();
    }
  };
}
