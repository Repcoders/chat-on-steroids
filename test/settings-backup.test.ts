import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { INVALID_SETTINGS_BACKUP, settingsBackup, settingsBackupRequest, settingsChanges } from '../src/main/settings-backup.js';
import type { Config } from '../src/shared/types.js';

const TUNNEL = 'tunnel_0123456789abcdef0123456789abcdef';

function configured(): Config {
  const config = defaultConfig('win32');
  return {
    ...config,
    roots: [{ name: 'project', path: 'C:\\Users\\you\\project' }],
    connectorSuffix: 'Beta',
    setupProfiles: [{ id: 'work', name: 'Profile Alpha', tunnelId: TUNNEL, desktopTunnelId: '', pluginsTunnelId: '' }],
    tunnel: { ...config.tunnel, tunnelId: TUNNEL, binaryPath: 'C:\\Tools\\tunnel-client.exe' },
    ui: { ...config.ui, theme: 'light', language: 'de', lastSeenVersion: '2.1.40', browserPreferences: { overwrite: true, durations: false } }
  };
}

describe('settings backup', () => {
  it('leaves tunnel IDs, setup profiles, folders, the connector name and install state out of the file', () => {
    const text = settingsBackup(configured(), '2.1.42', new Date('2026-10-20T12:00:00Z'));
    for (const value of [TUNNEL, 'tunnel-client', 'C:\\\\Users', '"connectorSuffix"', 'Profile Alpha', 'setupProfiles', '"roots"', 'lastSeenVersion', 'browserPreferences', '"language"', 'browserBridgePort']) {
      expect(text).not.toContain(value);
    }
    const file = JSON.parse(text);
    expect(file).toMatchObject({ format: 'chat-on-steroids-settings', version: 1, appVersion: '2.1.42', exportedAt: '2026-10-20T12:00:00.000Z' });
    expect(Object.keys(file.settings).sort()).toEqual(['capabilities', 'commandAllowlist', 'compaction', 'controlApi', 'goal', 'mcp', 'multiAgent', 'readOnly', 'sessions', 'ui']);
    expect(file.settings.ui.theme).toBe('light');
  });

  it('builds a save request that keeps the tunnel and install state and lists permission changes first', () => {
    const source = configured();
    const text = settingsBackup({ ...source, readOnly: true, capabilities: { ...source.capabilities, command: false },
      ui: { ...source.ui, theme: 'dark', language: 'ja', autoRefreshPluginsAsked: true } }, '2.1.42');
    const current = { ...configured(), tunnel: { ...source.tunnel, tunnelId: '' } };
    const { base, patch } = settingsBackupRequest(text, current);
    expect(patch.tunnel).toEqual(current.tunnel);
    expect(patch).not.toHaveProperty('roots');
    expect(patch).not.toHaveProperty('connectorSuffix');
    expect(patch.ui).toMatchObject({ theme: 'dark', language: 'de', lastSeenVersion: '2.1.40' });
    expect(patch.ui).not.toHaveProperty('autoRefreshPluginsAsked');
    expect(settingsChanges(base, patch)).toEqual([
      { path: 'capabilities.command', before: 'true', after: 'false', permission: true },
      { path: 'readOnly', before: 'false', after: 'true', permission: true },
      { path: 'ui.theme', before: '"light"', after: '"dark"', permission: false }
    ]);
  });

  it('keeps a setting the file does not name', () => {
    const current = configured();
    const file = JSON.parse(settingsBackup(current, '2.1.42'));
    delete file.settings.goal;
    delete file.settings.ui.followUp;
    file.settings.ui.theme = 'dark';
    const { base, patch } = settingsBackupRequest(JSON.stringify(file), { ...current, ui: { ...current.ui, followUp: 'queue' } });
    expect(patch.goal).toEqual(current.goal);
    expect(settingsChanges(base, patch).map(change => change.path)).toEqual(['ui.theme']);
  });

  it('merges nested settings field by field and lists where Goal sends the chat as a permission', () => {
    const current = configured();
    current.goal = { ...current.goal, provider: { kind: 'openrouter', baseUrl: 'https://models.example/v1' } };
    const text = JSON.stringify({ format: 'chat-on-steroids-settings', version: 1,
      settings: { goal: { backend: 'api', provider: { kind: 'custom' } }, ui: { browserBridgePort: 47123 } } });
    const { base, patch } = settingsBackupRequest(text, current);
    expect(patch.goal).toMatchObject({ backend: 'api', provider: { kind: 'custom', baseUrl: 'https://models.example/v1' } });
    expect(patch.ui).toEqual(current.ui);
    expect(settingsChanges(base, patch)).toEqual([
      { path: 'goal.backend', before: '"chatgpt"', after: '"api"', permission: true },
      { path: 'goal.provider.kind', before: '"openrouter"', after: '"custom"', permission: true }
    ]);
  });

  it('shows a permission change in full, however long, so two endpoints never read the same', () => {
    const current = configured();
    const prefix = `https://models.example/${'a'.repeat(160)}`;
    current.goal = { ...current.goal, provider: { kind: 'custom', baseUrl: `${prefix}/one` } };
    const text = JSON.stringify({ format: 'chat-on-steroids-settings', version: 1,
      settings: { goal: { provider: { baseUrl: `${prefix}/two` } }, compaction: { handoffPrompt: 'b'.repeat(200) } } });
    const { base, patch } = settingsBackupRequest(text, current);
    const [endpoint, other] = settingsChanges(base, patch);
    expect(endpoint).toEqual({ path: 'goal.provider.baseUrl', before: `"${prefix}/one"`, after: `"${prefix}/two"`, permission: true });
    expect(other).toMatchObject({ path: 'compaction.handoffPrompt', permission: false });
    expect(other?.after).toHaveLength(120);
  });

  it('refuses a file that is not a settings backup, or one from a newer version', () => {
    const current = configured();
    const valid = JSON.parse(settingsBackup(current, '2.1.42'));
    for (const text of ['not json', '[]', JSON.stringify({ ...valid, format: 'other' }), JSON.stringify({ ...valid, settings: [] }),
      JSON.stringify({ ...valid, version: 0 }), `{"format":"chat-on-steroids-settings","version":1,"settings":{},"pad":"${'x'.repeat(1_000_001)}"}`]) {
      expect(() => settingsBackupRequest(text, current), text.slice(0, 40)).toThrow(INVALID_SETTINGS_BACKUP);
    }
    expect(() => settingsBackupRequest(JSON.stringify({ ...valid, version: 2 }), current)).toThrow(/newer version/);
    // A byte-order mark from an editor is not damage.
    expect(() => settingsBackupRequest(`\uFEFF${JSON.stringify(valid)}`, current)).not.toThrow();
  });
});
