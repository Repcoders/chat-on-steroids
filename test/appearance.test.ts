import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { appearanceSchema } from '../src/main/appearance-schema.js';
import { APPEARANCE_PRESETS, defaultAppearance, luminance, mergeAppearance, paletteTokens, contrastRatio, parseThemeCode,
  presetColors, readableInk, themeCode, type AppearanceSettings } from '../src/shared/appearance.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from '../src/main/window-layout.js';

describe('custom appearance', () => {
  it('accepts arbitrary RGB colors, including identical accent and background, and bounds other preferences', () => {
    const appearance = defaultAppearance();
    appearance.dark = { background: '#51a20F', sidebar: '#fE0193', accent: '#51a20F', contrast: 0 };
    expect(appearanceSchema.parse(appearance)).toEqual(appearance);
    for (const bad of ['red', '#fff', '#12345678', 'url(https://example.com)', '#abcdef;display:none']) {
      expect(appearanceSchema.safeParse({ ...appearance, dark: { ...appearance.dark, sidebar: bad } }).success).toBe(false);
    }
    for (const fontSize of [11, 19, 14.5, Infinity]) expect(appearanceSchema.safeParse({ ...appearance, fontSize }).success).toBe(false);
    expect(appearanceSchema.safeParse({ ...appearance, font: 'remote-font' }).success).toBe(false);
  });

  it('retains readable text and buttons across light, dark and vivid custom backgrounds', () => {
    for (const background of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#fea5cf']) {
      for (const contrast of [0, 45, 100]) {
        const tokens = paletteTokens(background, background, contrast);
        expect(contrastRatio(tokens['--ink']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--soft']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--faint']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--blue']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--on-accent']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(tokens['--accent-fill']).toBe(background);
      }
    }
  });

  it('merges stale windows per color and per theme without overwriting concurrent edits', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    live.dark.sidebar = '#ff0066'; live.light.background = '#f1f2f3'; live.font = 'serif';
    wanted.dark.accent = '#7600ff'; wanted.fontSize = 18;
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.dark).toEqual({ ...live.dark, accent: '#7600ff' });
    expect(merged.light).toEqual(live.light);
    expect(merged.font).toBe('serif'); expect(merged.fontSize).toBe(18);
    expect(mergeAppearance(live, undefined, undefined)).toBe(live);
    expect(base).toEqual(defaultAppearance());
  });

  it('opens on the Projects sidebar for saves without a layout or with a retired one, and merges the layout per field', () => {
    const old: Record<string, unknown> = { ...defaultAppearance() };
    delete old.sidebarLayout;
    expect(appearanceSchema.parse(old).sidebarLayout).toBe('projects');
    // 'status' was a concept variant that never shipped; it reads as the default tree.
    for (const bad of ['status', 'classic', 1, null]) expect(appearanceSchema.parse({ ...old, sidebarLayout: bad }).sidebarLayout).toBe('projects');
    expect(appearanceSchema.parse({ ...old, sidebarLayout: 'inbox' }).sidebarLayout).toBe('inbox');
    const base = defaultAppearance(), live = { ...defaultAppearance(), sidebarLayout: 'inbox' as const };
    // A stale window saving its font keeps the layout another window chose.
    expect(mergeAppearance(live, base, { ...base, font: 'mono' })).toMatchObject({ sidebarLayout: 'inbox', font: 'mono' });
    expect(mergeAppearance(base, base, live)!.sidebarLayout).toBe('inbox');
  });

  it('uses the custom sidebar for native caption contrast and the custom page for reload backing', () => {
    const appearance = defaultAppearance();
    appearance.dark.sidebar = '#ffffff'; appearance.dark.background = '#391c56'; appearance.translucentSidebar = false;
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#ffffff') });
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#391c56');
  });

  it('offers presets, including a near-black one, that are valid saved colors in both themes', () => {
    expect(presetColors('default')).toEqual({ light: defaultAppearance().light, dark: defaultAppearance().dark, translucentSidebar: true });
    for (const preset of APPEARANCE_PRESETS) {
      expect(appearanceSchema.parse({ ...defaultAppearance(), ...presetColors(preset) })).toMatchObject(presetColors(preset));
    }
    const { dark } = presetColors('near-black');
    expect(luminance(dark.background)).toBeLessThan(.005);
    expect(luminance(dark.sidebar)).toBeLessThan(.005);
  });

  it('round-trips a theme code and refuses anything that is not one', () => {
    const colors = presetColors('forest');
    const settings: AppearanceSettings = { ...defaultAppearance(), ...colors, font: 'mono', fontSize: 18, sidebarLayout: 'inbox' };
    const code = themeCode(settings);
    expect(code).not.toContain('\n');
    expect(JSON.parse(code)).toEqual({ cosTheme: 1, ...colors });
    expect(parseThemeCode(`  ${code}\n`)).toEqual(colors);
    const upper = JSON.stringify({ cosTheme: 1, ...colors, dark: { ...colors.dark, accent: '#ABCDEF' } });
    expect(parseThemeCode(upper)!.dark.accent).toBe('#abcdef');
    const wrong = (patch: Record<string, unknown>) => JSON.stringify({ cosTheme: 1, ...colors, ...patch });
    for (const bad of ['', 'not json', '[]', 'null', JSON.stringify(colors), wrong({ cosTheme: 2 }), wrong({ translucentSidebar: 'yes' }),
      wrong({ dark: { ...colors.dark, sidebar: 'url(https://example.com)' } }), wrong({ light: { ...colors.light, accent: '#fff' } }),
      wrong({ dark: { ...colors.dark, contrast: 101 } }), wrong({ light: { ...colors.light, contrast: 4.5 } }), wrong({ dark: undefined }),
      code + ' '.repeat(2000)]) {
      expect(parseThemeCode(bad), bad.slice(0, 80)).toBeNull();
    }
  });
});

describe('Appearance presets and theme codes in Settings', () => {
  let dom: JSDOM | null = null;
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); dom?.window.close(); dom = null; });

  async function settings(appearance: AppearanceSettings) {
    dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
    const w = dom.window;
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLDialogElement'] as const) vi.stubGlobal(key, key === 'window' ? w : w[key]);
    w.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
    w.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
    const writeClipboard = vi.fn(async (_text: string) => ({ ok: true as const, data: true }));
    Object.assign(w, { api: { writeClipboard } });
    const save = vi.fn();
    const { initAppearance } = await import('../src/renderer/appearance.js');
    initAppearance(save).apply({ theme: 'dark', appearance } as never);
    return { save, writeClipboard, doc: w.document };
  }
  const mine = (): AppearanceSettings => ({ ...defaultAppearance(), font: 'serif', fontSize: 17, sidebarLayout: 'inbox' });

  it('applies a preset to both palettes and keeps font, text size and sidebar layout', async () => {
    const { save, doc } = await settings(mine());
    const button = doc.querySelector<HTMLButtonElement>('[data-preset="near-black"]')!;
    expect(doc.querySelector('[data-preset="default"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    expect(save).toHaveBeenCalledWith({ appearance: { ...mine(), ...presetColors('near-black') } });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(doc.querySelector('[data-preset="default"]')!.getAttribute('aria-pressed')).toBe('false');
    expect((doc.getElementById('appearance-background-hex') as HTMLInputElement).value).toBe('#09090B');
    expect(doc.documentElement.style.getPropertyValue('--page')).toBe('#09090b');
  });

  it('copies the colors as a theme code and applies a pasted one, refusing a broken paste', async () => {
    const shared = { ...defaultAppearance(), ...presetColors('sand') };
    const first = await settings(shared);
    first.doc.getElementById('appearanceCodeCopy')!.click();
    await vi.waitFor(() => expect(first.writeClipboard).toHaveBeenCalledTimes(1));
    const code = first.writeClipboard.mock.calls[0]![0];
    expect(parseThemeCode(code)).toEqual(presetColors('sand'));
    vi.unstubAllGlobals(); vi.resetModules(); dom!.window.close();

    const { save, doc } = await settings(mine());
    const dialog = doc.getElementById('themeCodeDialog') as HTMLDialogElement, input = doc.getElementById('themeCodeInput') as HTMLTextAreaElement;
    const submit = () => doc.getElementById('themeCodeForm')!.dispatchEvent(new dom!.window.Event('submit', { cancelable: true }));
    doc.getElementById('appearanceCodePaste')!.click();
    expect(dialog.open).toBe(true);
    input.value = code.slice(0, -2);
    submit();
    expect(save).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(doc.getElementById('themeCodeError')!.hidden).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = code;
    submit();
    expect(save).toHaveBeenCalledWith({ appearance: { ...mine(), ...presetColors('sand') } });
    expect(dialog.open).toBe(false);
    expect(doc.querySelector('[data-preset="sand"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});
