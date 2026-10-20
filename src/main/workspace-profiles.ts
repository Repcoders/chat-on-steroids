import { randomUUID } from 'node:crypto';
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron';
import type { MainText } from '../shared/main-texts.js';
import type { Config } from '../shared/types.js';
import {
  WORKSPACE_PROFILE_LIMIT, currentProfileSettings, profileChanges, withProfileSettings, type WorkspaceProfile
} from '../shared/workspace-profiles.js';
import { getConfig, updateConfig } from './config.js';
import { refreshKeepAwake } from './keep-awake.js';
import { logInfo, logWarn } from './logger.js';
import { mainText } from './main-texts.js';

/** Saves the current settings under a name; the same name, in any case, takes the new settings. */
export function saveWorkspaceProfile(config: Config, name: string): Config {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Enter a profile name (1–80 characters)');
  const profiles = config.workspaceProfiles ?? [];
  const settings = currentProfileSettings(config.ui);
  const same = profiles.find(profile => profile.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (same) return { ...config, workspaceProfiles: profiles.map(profile => profile === same ? { ...profile, name: trimmed, settings } : profile) };
  if (profiles.length >= WORKSPACE_PROFILE_LIMIT) throw new Error('Workspace profile limit reached');
  return { ...config, workspaceProfiles: [...profiles, { id: randomUUID(), name: trimmed, settings }] };
}

export function removeWorkspaceProfile(config: Config, id: string): Config {
  if (!config.workspaceProfiles?.some(profile => profile.id === id)) throw new Error('Workspace profile not found');
  return { ...config, workspaceProfiles: config.workspaceProfiles.filter(profile => profile.id !== id) };
}

/** The profile's settings in place; permissions, folders, Desktop and the tunnel stay as they are. */
export function switchWorkspaceProfile(config: Config, id: string): Config {
  const profile = config.workspaceProfiles?.find(candidate => candidate.id === id);
  if (!profile) throw new Error('Workspace profile not found');
  return { ...config, ui: withProfileSettings(config.ui, profile.settings) };
}

/** The question asked before a switch: each setting that changes, from its value now to the profile's. */
export function workspaceProfileQuestion(
  profile: WorkspaceProfile,
  ui: Config['ui'],
  text: (source: MainText) => string = mainText
): MessageBoxOptions {
  const lines = profileChanges(currentProfileSettings(ui), profile.settings)
    .map(change => `${text(change.label)}: ${text(change.from)} → ${text(change.to)}`);
  return {
    type: 'question',
    message: text('Switch to “{0}”?').replace('{0}', () => profile.name),
    detail: [...(lines.length ? lines : [text('Nothing changes: these settings are already in place.')]), '',
      text('Permissions, folders and Desktop stay as they are.')].join('\n'),
    buttons: [text('Switch'), text('Cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };
}

/** The tray's Workspace profiles submenu; none without a saved profile. */
export function workspaceProfileMenu(
  profiles: readonly WorkspaceProfile[] | undefined,
  choose: (id: string) => void,
  text: (source: MainText) => string = mainText
): MenuItemConstructorOptions[] {
  if (!profiles?.length) return [];
  return [{
    label: text('Workspace profiles'),
    // Native menus read a single `&` as a mnemonic and hide it.
    submenu: profiles.map(profile => ({ label: profile.name.replaceAll('&', '&&'), click: () => choose(profile.id) }))
  }];
}

const listeners = new Set<() => void>();

/** The tray repaints its list, and the window its Settings values, after a save, removal or switch. */
export function onWorkspaceProfilesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function workspaceProfilesChanged(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* One surface cannot keep the others stale. */ }
  }
}

let asking = false;

/**
 * Asks with the summary, then switches. A second pick while the question is open is ignored, and a
 * profile removed or saved over meanwhile switches nothing: only the values the question showed apply.
 */
export async function chooseWorkspaceProfile(
  id: string,
  ask: (options: MessageBoxOptions) => Promise<{ response: number }>
): Promise<boolean> {
  const profile = getConfig().workspaceProfiles?.find(candidate => candidate.id === id);
  if (asking || !profile) return false;
  asking = true;
  try {
    const asked = profile.settings;
    if ((await ask(workspaceProfileQuestion(profile, getConfig().ui))).response !== 0) return false;
    await updateConfig(config => {
      const latest = config.workspaceProfiles?.find(candidate => candidate.id === id)?.settings;
      if (!latest || latest.turnNotifications !== asked.turnNotifications || latest.keepAwake !== asked.keepAwake ||
          latest.backgroundPlacement !== asked.backgroundPlacement) throw new Error('Workspace profile changed');
      return switchWorkspaceProfile(config, id);
    }, (next, previous) => {
      // The committed pair, not a read before the queue: a Settings save may commit in between.
      if (previous.ui.keepAwake !== next.ui.keepAwake || previous.ui.keepScreenAwake !== next.ui.keepScreenAwake) refreshKeepAwake();
    });
    logInfo('workspace profile switched');
    workspaceProfilesChanged();
    return true;
  } catch (error) {
    logWarn(`workspace profile: could not switch: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    asking = false;
  }
}
