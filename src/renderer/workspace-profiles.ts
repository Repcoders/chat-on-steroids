import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { profileSummary } from '../shared/workspace-profiles.js';
import type { AppApi } from '../preload/index.js';
import type { AppState } from '../shared/types.js';

/**
 * Settings › General › Workspace profiles: save the current notification, keep-awake and
 * background tab settings under a name, or delete one. The tray menu switches between them.
 */
export function initWorkspaceProfiles(options: {
  api: Pick<AppApi, 'saveWorkspaceProfile' | 'removeWorkspaceProfile'>;
  /** Settles once the settings form's own saves are in, so a profile saves what the form shows. */
  settled: () => Promise<unknown>;
  apply: (state: AppState) => void;
}): (state: AppState) => void {
  const dialog = $<HTMLDialogElement>('workspaceProfileDialog');
  const nameInput = $<HTMLInputElement>('workspaceProfileName');
  let busy = false;
  let latest: AppState | null = null;

  const paint = (next: AppState): void => {
    latest = next;
    const profiles = next.config.workspaceProfiles ?? [];
    const list = $('workspaceProfileList');
    const signature = JSON.stringify(profiles);
    if (list.dataset.profiles !== signature) {
      list.replaceChildren(...profiles.map(profile => {
        const row = el('div', 'setting workspace-profile-row');
        const text = el('span', 'setting-text');
        const name = document.createElement('b');
        name.textContent = profile.name;
        name.translate = false;
        const summary = document.createElement('em');
        ui(summary, 'textContent', () => profileSummary(profile.settings).map(line => `${t(line.label)}: ${t(line.value)}`).join(' · '));
        text.append(name, summary);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn';
        remove.dataset.removeWorkspaceProfile = profile.id;
        ui(remove, 'title', () => t('Delete profile: {0}', [profile.name]));
        ui(remove, 'aria-label', () => t('Delete profile: {0}', [profile.name]));
        remove.append(icon('i-trash'));
        remove.addEventListener('click', () => void change(() => options.api.removeWorkspaceProfile(profile.id)));
        row.append(text, remove);
        return row;
      }));
      list.dataset.profiles = signature;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('#workspaceProfileAdd, #workspaceProfileList button, #workspaceProfileForm button')) button.disabled = busy;
  };

  const change = async (request: () => ReturnType<AppApi['saveWorkspaceProfile']>): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    if (latest) paint(latest);
    try {
      await options.settled();
      const next = await run(request());
      if (next) options.apply(next);
      return next !== null;
    } finally {
      busy = false;
      if (latest) paint(latest);
    }
  };

  $('workspaceProfileAdd').addEventListener('click', () => {
    dialog.showModal();
    nameInput.focus();
  });
  $('workspaceProfileCancel').addEventListener('click', () => dialog.close());
  $('workspaceProfileForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    void change(() => options.api.saveWorkspaceProfile(name)).then(saved => {
      if (!saved) return;
      nameInput.value = '';
      dialog.close();
    });
  });
  return paint;
}
