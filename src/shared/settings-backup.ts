/** One setting a settings backup would change, as the import preview lists it. */
export interface SettingsBackupChange {
  /** The setting's place in the config, such as `ui.theme` or `capabilities.write`. */
  path: string;
  /** JSON of the current and the imported value, shortened; null when the value is not set. */
  before: string | null;
  after: string | null;
  /** A capability, read-only, command rule, worker access or local API change: listed apart. */
  permission: boolean;
}

export type SettingsBackupExport = { done: 'saved'; name: string } | { done: 'cancelled' };

export type SettingsBackupPreview =
  | { done: 'cancelled' }
  | { done: 'preview'; token: string; name: string; changes: SettingsBackupChange[] };
