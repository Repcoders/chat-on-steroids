import { t } from './i18n.js';
import { $, el, run, toast } from './dom.js';
import type { AppState } from '../shared/types.js';
import type { SettingsBackupChange } from '../shared/settings-backup.js';

/**
 * General › Backup: export the settings to one file, and import one after a preview of every
 * setting it changes. Permission changes are listed apart, and nothing applies before Apply.
 */
export function initSettingsBackup(apply: (state: AppState) => void): void {
  const exportButton = $<HTMLButtonElement>('exportSettings');
  const importButton = $<HTMLButtonElement>('importSettings');
  exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    try {
      const result = await run(window.api.exportSettings());
      if (result?.done === 'saved') toast(t('Settings saved as {0}. Keys, tunnel IDs, setup profiles and folders are not in it.', [result.name]));
    } finally { exportButton.disabled = false; }
  });
  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    try {
      const preview = await run(window.api.previewSettingsImport());
      if (preview?.done === 'preview') showPreview(preview.token, preview.name, preview.changes, apply);
    } finally { importButton.disabled = false; }
  });
}

function changeList(changes: SettingsBackupChange[]): HTMLElement {
  const list = el('ul', 'settings-import-list');
  for (const change of changes) {
    const row = el('li');
    const name = el('code', '', change.path); name.setAttribute('translate', 'no');
    const values = el('span', 'settings-import-values');
    values.append(el('span', '', change.before ?? (() => t('not set'))), el('span', 'settings-import-arrow', '→'),
      el('span', '', change.after ?? (() => t('not set'))));
    values.setAttribute('translate', 'no');
    row.append(name, values);
    list.append(row);
  }
  return list;
}

function showPreview(token: string, name: string, changes: SettingsBackupChange[], apply: (state: AppState) => void): void {
  document.querySelector('#settingsImportDialog')?.remove();
  const dialog = document.createElement('dialog'); dialog.id = 'settingsImportDialog'; dialog.className = 'plugin-dialog settings-import-dialog';
  const head = el('div', 'plugin-dialog-head'); const title = el('h2', '', () => t('Import settings')); title.id = 'settingsImportTitle';
  dialog.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement; close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  head.append(title, close);
  const body = el('div', 'plugin-dialog-body');
  const permissions = changes.filter(change => change.permission);
  const others = changes.filter(change => !change.permission);
  if (!changes.length) body.append(el('p', '', () => t('{0} holds the settings you have now. Nothing would change.', [name])));
  else body.append(el('p', '', () => t('Applying {0} changes these settings. Settings the file does not list keep their values.', [name])));
  if (permissions.length) {
    const section = el('section', 'settings-import-permissions');
    section.append(el('h3', '', () => t('Permissions')), el('p', 'muted', () => t('These change what ChatGPT and other tools may do on this computer.')), changeList(permissions));
    body.append(section);
  }
  if (others.length) body.append(el('h3', '', () => t('Other settings')), changeList(others));
  const actions = el('div', 'pet-delete-actions');
  const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement; cancel.type = 'button';
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel);
  if (changes.length) {
    const confirm = el('button', 'btn btn-solid', () => t('Apply')) as HTMLButtonElement; confirm.type = 'button';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      const next = await run(window.api.applySettingsImport(token));
      if (next) {
        apply(next);
        toast(t('Settings imported from {0}.', [name]));
        dialog.close();
      } else confirm.disabled = false;
    });
    actions.append(confirm);
  }
  body.append(actions); dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); cancel.focus();
}
