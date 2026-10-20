import type { UiPrefs } from './types.js';

/**
 * Workspace profiles: named sets of everyday settings, switched together from the tray menu.
 *
 * A profile holds only the settings listed here. Permissions, folders, Desktop and the tunnel
 * are never part of one, so switching a profile cannot widen what ChatGPT may do on this
 * computer. They are separate from Setup profiles (`config.setupProfiles`), which switch tunnels.
 */
export interface WorkspaceProfileSettings {
  turnNotifications: boolean;
  keepAwake: 'off' | 'computer' | 'screen';
  backgroundPlacement: 'window' | 'group';
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  settings: WorkspaceProfileSettings;
}

export const WORKSPACE_PROFILE_LIMIT = 8;

type Prefs = Pick<UiPrefs, 'turnNotifications' | 'keepAwake' | 'keepScreenAwake' | 'backgroundPlacement'>;

/** The profile settings as they are now, read with each setting's own missing-value rule. */
export function currentProfileSettings(ui: Prefs): WorkspaceProfileSettings {
  return {
    turnNotifications: ui.turnNotifications !== false,
    keepAwake: ui.keepAwake === false ? 'off' : ui.keepScreenAwake === true ? 'screen' : 'computer',
    backgroundPlacement: ui.backgroundPlacement === 'group' ? 'group' : 'window'
  };
}

/** The settings with a profile's values in place. Nothing else in them changes. */
export function withProfileSettings<T extends Prefs>(ui: T, settings: WorkspaceProfileSettings): T {
  return {
    ...ui,
    turnNotifications: settings.turnNotifications,
    keepAwake: settings.keepAwake !== 'off',
    keepScreenAwake: settings.keepAwake === 'screen',
    backgroundPlacement: settings.backgroundPlacement
  };
}

/** Each setting's name and its values, as the Settings page writes them (catalog keys). */
const LABELS = {
  turnNotifications: 'Notify when a chat finishes',
  keepAwake: 'Keep awake while a chat works',
  backgroundPlacement: 'Background tabs open in'
} as const;

const VALUES = {
  on: 'On', off: 'Off', computer: 'The computer', screen: 'The computer and screen',
  window: 'Their own minimized window', group: 'A tab group in your browser window'
} as const;

export type ProfileText = typeof LABELS[keyof typeof LABELS] | typeof VALUES[keyof typeof VALUES];

function valueText(key: keyof WorkspaceProfileSettings, settings: WorkspaceProfileSettings): ProfileText {
  if (key === 'turnNotifications') return settings.turnNotifications ? VALUES.on : VALUES.off;
  return VALUES[settings[key]];
}

const KEYS = Object.keys(LABELS) as Array<keyof WorkspaceProfileSettings>;

/** A profile's settings, one line each: what Settings › Workspace profiles lists. */
export function profileSummary(settings: WorkspaceProfileSettings): Array<{ label: ProfileText; value: ProfileText }> {
  return KEYS.map(key => ({ label: LABELS[key], value: valueText(key, settings) }));
}

/** What switching to a profile would change, from the current value to the profile's. */
export function profileChanges(
  current: WorkspaceProfileSettings,
  next: WorkspaceProfileSettings
): Array<{ label: ProfileText; from: ProfileText; to: ProfileText }> {
  return KEYS.filter(key => current[key] !== next[key])
    .map(key => ({ label: LABELS[key], from: valueText(key, current), to: valueText(key, next) }));
}
