import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig, updateConfig } from '../src/main/config.js';
import {
  chooseWorkspaceProfile, onWorkspaceProfilesChange, removeWorkspaceProfile, saveWorkspaceProfile, switchWorkspaceProfile,
  workspaceProfileMenu, workspaceProfileQuestion
} from '../src/main/workspace-profiles.js';
import type { Config } from '../src/shared/types.js';
import type { WorkspaceProfile } from '../src/shared/workspace-profiles.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const keepAwake = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../src/main/keep-awake.js', async original => ({ ...(await original<object>()), refreshKeepAwake: keepAwake.refresh }));

let dir: string;
beforeAll(async () => { dir = await makeTempDir('clf-workspace-profiles-'); initConfigPath(dir); });
afterAll(async () => { await removeTempDir(dir); });

const overnight: WorkspaceProfile = { id: 'p-overnight', name: 'Overnight', settings: { turnNotifications: false, keepAwake: 'screen', backgroundPlacement: 'window' } };
const review: WorkspaceProfile = { id: 'p-review', name: 'Review', settings: { turnNotifications: true, keepAwake: 'off', backgroundPlacement: 'group' } };

/** A Review-like day: notifications on, keep-awake off, background tabs in a group. */
function reviewDay(profiles: WorkspaceProfile[] = []): Config {
  const config = defaultConfig('win32');
  return { ...config, ui: { ...config.ui, turnNotifications: true, keepAwake: false, keepScreenAwake: false, backgroundPlacement: 'group' }, workspaceProfiles: profiles };
}

describe('workspace profiles in the config file', () => {
  it('starts with none on a fresh install and in conservative recovery', async () => {
    expect(defaultConfig().workspaceProfiles).toBeUndefined();
    await fs.writeFile(path.join(dir, 'config.json'), '{ not json', 'utf8');
    const recovered = await loadConfig();
    expect(recovered.readOnly).toBe(true);
    expect(recovered.workspaceProfiles).toBeUndefined();
  });

  it('keeps only the settings a profile may hold, so a stored profile cannot carry Desktop or folders', async () => {
    const config = defaultConfig('win32');
    const desktopOff = { ...config, capabilities: { ...config.capabilities, screen: false, control: false } };
    const tampered = { ...overnight, capabilities: { screen: true, control: true }, roots: [{ name: 'home', path: 'C:\\Users\\you' }], readOnly: false,
      settings: { ...overnight.settings, keepScreenAwake: true, minimizeToTray: false } };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...desktopOff, workspaceProfiles: [tampered] }), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    expect(loaded.workspaceProfiles).toEqual([overnight]);
    const switched = switchWorkspaceProfile(loaded, overnight.id);
    expect(switched.capabilities).toEqual(loaded.capabilities);
    expect(switched.capabilities.screen).toBe(false);
    expect(switched.capabilities.control).toBe(false);
    expect(switched.roots).toEqual(loaded.roots);
    expect(switched.readOnly).toBe(loaded.readOnly);
    expect(switched.ui.minimizeToTray).toBe(loaded.ui.minimizeToTray);
  });

  it('drops a damaged profile, or one repeating an id or a name in any case, alone, keeping the others and every other setting', async () => {
    const config = reviewDay();
    const damaged = { id: 'p-bad', name: 'Bad', settings: { turnNotifications: 'yes', keepAwake: 'always', backgroundPlacement: 'window' } };
    const many = Array.from({ length: 10 }, (_, index) => ({ ...review, id: `p-${index}`, name: `Profile ${index}` }));
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, roots: [], workspaceProfiles: [overnight, damaged, { ...overnight, name: 'Copy' }, { ...review, id: 'p-shouting', name: 'OVERNIGHT' }, ...many] }), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.readOnly).toBe(false);
    expect(loaded.workspaceProfiles?.map(profile => profile.id)).toEqual(['p-overnight', 'p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6']);
    expect(loaded.ui.backgroundPlacement).toBe('group');
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...config, workspaceProfiles: 'Overnight' }), 'utf8');
    const notAList = await loadConfig();
    expect(notAList.readOnly).toBe(false);
    expect(notAList.workspaceProfiles).toBeUndefined();
    expect(notAList.ui.turnNotifications).toBe(true);
  });
});

describe('saving, removing and switching', () => {
  it('saves the current settings under a name, and the same name saves over its profile', () => {
    const saved = saveWorkspaceProfile(reviewDay(), '  Review  ');
    expect(saved.workspaceProfiles).toEqual([{ id: expect.any(String), name: 'Review', settings: review.settings }]);
    const later = { ...saved, ui: { ...saved.ui, turnNotifications: false } };
    const again = saveWorkspaceProfile(later, 'review');
    expect(again.workspaceProfiles).toEqual([{ id: saved.workspaceProfiles![0]!.id, name: 'review', settings: { ...review.settings, turnNotifications: false } }]);
    expect(() => saveWorkspaceProfile(reviewDay(), '   ')).toThrow();
  });

  it('holds at most eight profiles', () => {
    const full = reviewDay(Array.from({ length: 8 }, (_, index) => ({ ...review, id: `p-${index}`, name: `Profile ${index}` })));
    expect(() => saveWorkspaceProfile(full, 'Ninth')).toThrow('Workspace profile limit reached');
    expect(saveWorkspaceProfile(full, 'Profile 3').workspaceProfiles).toHaveLength(8);
  });

  it('removes one profile and refuses one that is not there', () => {
    expect(removeWorkspaceProfile(reviewDay([overnight, review]), overnight.id).workspaceProfiles).toEqual([review]);
    expect(() => removeWorkspaceProfile(reviewDay([review]), overnight.id)).toThrow('Workspace profile not found');
  });

  it('switches only the profile settings: keep-awake with the screen, notifications and background tabs', () => {
    const before = reviewDay([overnight, review]);
    const after = switchWorkspaceProfile(before, overnight.id);
    expect(after.ui).toEqual({ ...before.ui, turnNotifications: false, keepAwake: true, keepScreenAwake: true, backgroundPlacement: 'window' });
    expect({ ...after, ui: before.ui }).toEqual(before);
    expect(switchWorkspaceProfile(after, review.id).ui).toEqual(before.ui);
    expect(() => switchWorkspaceProfile(before, 'p-missing')).toThrow('Workspace profile not found');
  });
});

describe('the tray', () => {
  it('asks with each change from the current value to the profile’s, and says permissions stay', () => {
    const question = workspaceProfileQuestion(overnight, reviewDay().ui);
    expect(question.message).toBe('Switch to “Overnight”?');
    expect(question.detail!.split('\n')).toEqual([
      'Notify when a chat finishes: On → Off',
      'Keep awake while a chat works: Off → The computer and screen',
      'Background tabs open in: A tab group in your browser window → Their own minimized window',
      '',
      'Permissions, folders and Desktop stay as they are.'
    ]);
    expect(question.buttons).toEqual(['Switch', 'Cancel']);
    expect(question).toMatchObject({ defaultId: 0, cancelId: 1 });
    expect(workspaceProfileQuestion(review, reviewDay().ui).detail!.split('\n')[0]).toBe('Nothing changes: these settings are already in place.');
    // The interface language reaches the question through the published tray texts.
    const german = workspaceProfileQuestion(overnight, reviewDay().ui, text => ({ 'Switch to “{0}”?': 'Zu „{0}“ wechseln?', 'On': 'An', 'Off': 'Aus' } as Record<string, string>)[text] ?? text);
    expect(german.message).toBe('Zu „Overnight“ wechseln?');
    expect(german.detail).toContain('Notify when a chat finishes: An → Aus');
  });

  it('lists the profiles in a submenu, with none without a profile', () => {
    expect(workspaceProfileMenu(undefined, () => undefined)).toEqual([]);
    expect(workspaceProfileMenu([], () => undefined)).toEqual([]);
    const choose = vi.fn();
    const [menu] = workspaceProfileMenu([overnight, { ...review, name: 'Review & ship' }], choose);
    expect(menu!.label).toBe('Workspace profiles');
    const items = menu!.submenu as Array<{ label: string; click: () => void }>;
    expect(items.map(item => item.label)).toEqual(['Overnight', 'Review && ship']);
    items[1]!.click();
    expect(choose).toHaveBeenCalledWith(review.id);
  });

  beforeEach(async () => { await saveConfig(reviewDay([overnight, review])); });

  it('switches after Switch, leaves everything after Cancel, and tells the window and tray', async () => {
    const changed = vi.fn();
    const stop = onWorkspaceProfilesChange(changed);
    try {
      expect(await chooseWorkspaceProfile(overnight.id, async () => ({ response: 1 }))).toBe(false);
      expect(getConfig().ui.keepAwake).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      const asked: string[] = [];
      expect(await chooseWorkspaceProfile(overnight.id, async options => { asked.push(options.message); return { response: 0 }; })).toBe(true);
      expect(asked).toEqual(['Switch to “Overnight”?']);
      expect(getConfig().ui).toMatchObject({ turnNotifications: false, keepAwake: true, keepScreenAwake: true, backgroundPlacement: 'window' });
      expect((await loadConfig()).ui).toMatchObject({ turnNotifications: false, keepAwake: true, keepScreenAwake: true, backgroundPlacement: 'window' });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });

  it('ignores a second pick while the question is open, and a profile removed meanwhile switches nothing', async () => {
    let answer: (value: { response: number }) => void = () => undefined;
    const first = chooseWorkspaceProfile(overnight.id, () => new Promise(resolve => { answer = resolve; }));
    expect(await chooseWorkspaceProfile(review.id, async () => ({ response: 0 }))).toBe(false);
    await saveConfig(removeWorkspaceProfile(getConfig(), overnight.id));
    answer({ response: 0 });
    expect(await first).toBe(false);
    expect(getConfig().ui).toMatchObject({ turnNotifications: true, keepAwake: false, backgroundPlacement: 'group' });
    expect(await chooseWorkspaceProfile('p-missing', async () => ({ response: 0 }))).toBe(false);
  });

  it('switches nothing when the profile was saved over while the question was open', async () => {
    let answer: (value: { response: number }) => void = () => undefined;
    const switching = chooseWorkspaceProfile(overnight.id, () => new Promise(resolve => { answer = resolve; }));
    // Saved again from Settings under the same name: same id, other settings than the question showed.
    const resaved = { ...getConfig(), ui: { ...getConfig().ui, turnNotifications: true, keepAwake: false, keepScreenAwake: false, backgroundPlacement: 'group' as const } };
    await saveConfig(saveWorkspaceProfile(resaved, 'Overnight'));
    answer({ response: 0 });
    expect(await switching).toBe(false);
    expect(getConfig().ui).toMatchObject({ turnNotifications: true, keepAwake: false, backgroundPlacement: 'group' });
  });

  it('refreshes keep-awake from what was committed, also after a Settings save that went first', async () => {
    keepAwake.refresh.mockClear();
    // Keep-awake is off and Review keeps it off, but a Settings save turning it on is already queued.
    let release = (): void => undefined;
    const settingsSave = updateConfig(async config => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ...config, ui: { ...config.ui, keepAwake: true } };
    });
    const switching = chooseWorkspaceProfile(review.id, async () => ({ response: 0 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await settingsSave;
    expect(await switching).toBe(true);
    expect(getConfig().ui.keepAwake).toBe(false);
    expect(keepAwake.refresh).toHaveBeenCalledTimes(1);
    keepAwake.refresh.mockClear();
    expect(await chooseWorkspaceProfile(review.id, async () => ({ response: 0 }))).toBe(true);
    expect(keepAwake.refresh).not.toHaveBeenCalled();
  });
});
