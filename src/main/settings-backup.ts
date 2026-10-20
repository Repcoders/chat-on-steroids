import type { Config } from '../shared/types.js';
import type { SettingsBackupChange } from '../shared/settings-backup.js';

/**
 * Settings backup and restore: one JSON file with the preferences the Settings form saves.
 *
 * A backup never carries `tunnel` (tunnel IDs and the tunnel program's path), `setupProfiles`,
 * `roots` (approved folder paths) or `connectorSuffix` (this computer's name in ChatGPT). Keys are
 * not in the config at all: they stay in `secrets.bin`. An import builds a normal `settings:save`
 * request against the current config, so the same validation and three-way merge apply it.
 */
export const SETTINGS_BACKUP_FORMAT = 'chat-on-steroids-settings';
export const SETTINGS_BACKUP_VERSION = 1;
export const MAX_SETTINGS_BACKUP_BYTES = 1_000_000;
export const INVALID_SETTINGS_BACKUP = 'This file is not a valid Chat On Steroids settings backup.';

const SECTIONS = ['capabilities', 'readOnly', 'commandAllowlist', 'ui', 'sessions', 'compaction', 'multiAgent', 'goal', 'mcp', 'controlApi'] as const;
/** `ui` entries about this install rather than a choice: left out of a backup and never imported. */
const LOCAL_UI_KEYS = ['lastSeenVersion', 'language', 'browserPreferences', 'cosBrowserTrayHint', 'autoRefreshPluginsAsked'] as const;
const PERMISSION_PATHS = [/^capabilities\./, /^readOnly$/, /^commandAllowlist\./, /^controlApi\./, /^mcp\.persistentUrls$/,
  /^multiAgent\.(enabled|allowUnattributedCalls|strictChatAllowlist)$/];

export class SettingsBackupError extends Error {}

type Snapshot = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function withoutLocalUi(ui: Config['ui']): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...ui };
  for (const key of LOCAL_UI_KEYS) delete copy[key];
  return copy;
}

/** The backup file's text for `config`. */
export function settingsBackup(config: Config, appVersion: string, now = new Date()): string {
  const settings = Object.fromEntries(SECTIONS.map(section => [section, section === 'ui' ? withoutLocalUi(config.ui) : config[section]]));
  return `${JSON.stringify({ format: SETTINGS_BACKUP_FORMAT, version: SETTINGS_BACKUP_VERSION, appVersion,
    exportedAt: now.toISOString(), settings }, null, 2)}\n`;
}

/**
 * The unvalidated `{base, patch}` of a `settings:save` that applies the backup in `text` over
 * `current`. Sections merge per key, so a setting the file does not name keeps its value; the
 * tunnel and the install's own `ui` entries always come from `current`.
 */
export function settingsBackupRequest(text: string, current: Config): { base: Snapshot; patch: Snapshot } {
  if (text.length > MAX_SETTINGS_BACKUP_BYTES) throw new SettingsBackupError(INVALID_SETTINGS_BACKUP);
  let file: unknown;
  try { file = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new SettingsBackupError(INVALID_SETTINGS_BACKUP); }
  if (!isRecord(file) || file.format !== SETTINGS_BACKUP_FORMAT || typeof file.version !== 'number' || !isRecord(file.settings)) {
    throw new SettingsBackupError(INVALID_SETTINGS_BACKUP);
  }
  if (file.version > SETTINGS_BACKUP_VERSION) {
    throw new SettingsBackupError('This settings backup is from a newer version of Chat On Steroids. Update the app, then import it again.');
  }
  if (file.version !== SETTINGS_BACKUP_VERSION) throw new SettingsBackupError(INVALID_SETTINGS_BACKUP);
  const base: Snapshot = { tunnel: current.tunnel, ...Object.fromEntries(SECTIONS.map(section => [section, current[section]])) };
  const patch: Snapshot = { ...base };
  for (const section of SECTIONS) {
    if (!Object.hasOwn(file.settings, section)) continue;
    const value = file.settings[section];
    patch[section] = isRecord(base[section]) && isRecord(value) ? { ...base[section], ...value } : value;
  }
  if (isRecord(patch.ui)) {
    const ui: Record<string, unknown> = { ...patch.ui };
    for (const key of LOCAL_UI_KEYS) {
      if (current.ui[key] === undefined) delete ui[key];
      else ui[key] = current.ui[key];
    }
    patch.ui = ui;
  }
  return { base, patch };
}

const shown = (value: unknown): string | null => {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};

/** Every setting the validated `patch` changes against `base`, permission changes first. */
export function settingsChanges(base: unknown, patch: unknown): SettingsBackupChange[] {
  const changes: SettingsBackupChange[] = [];
  const walk = (before: unknown, after: unknown, path: string): void => {
    if (isRecord(before) && isRecord(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!path && key === 'tunnel') continue;
        walk(before[key], after[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({ path, before: shown(before), after: shown(after), permission: PERMISSION_PATHS.some(rule => rule.test(path)) });
  };
  walk(base, patch, '');
  return [...changes.filter(change => change.permission), ...changes.filter(change => !change.permission)];
}
