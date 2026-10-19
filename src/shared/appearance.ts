/** Saved appearance is presentation only. Theme remains the existing ui.theme choice. */
export const APPEARANCE_FONTS = ['system', 'sans', 'serif', 'mono'] as const;
/** 'projects' is the project tree; 'inbox' is one list of chats, active ones first. */
export const SIDEBAR_LAYOUTS = ['projects', 'inbox'] as const;
export type AppearanceTheme = 'light' | 'dark';
export interface AppearancePalette {
  background: string;
  sidebar: string;
  accent: string;
  contrast: number;
}
export interface AppearanceSettings {
  light: AppearancePalette;
  dark: AppearancePalette;
  font: typeof APPEARANCE_FONTS[number];
  fontSize: number;
  translucentSidebar: boolean;
  sidebarLayout: typeof SIDEBAR_LAYOUTS[number];
}
export function defaultAppearance(): AppearanceSettings {
  return {
    light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
    dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
    font: 'system', fontSize: 14, translucentSidebar: true, sidebarLayout: 'projects'
  };
}

/** What a preset or a theme code sets: the Colors section. Font, text size and layout stay. */
export type AppearanceColors = Pick<AppearanceSettings, 'light' | 'dark' | 'translucentSidebar'>;
export const APPEARANCE_PRESETS = ['default', 'near-black', 'slate', 'forest', 'sand'] as const;
export type AppearancePreset = typeof APPEARANCE_PRESETS[number];
export function presetColors(preset: AppearancePreset): AppearanceColors {
  if (preset === 'near-black') return {
    light: { background: '#fafafa', sidebar: '#f4f4f5', accent: '#18181b', contrast: 50 },
    dark: { background: '#09090b', sidebar: '#0c0c0e', accent: '#e4e4e7', contrast: 55 }, translucentSidebar: false
  };
  if (preset === 'slate') return {
    light: { background: '#f8fafc', sidebar: '#e2e8f0', accent: '#0369a1', contrast: 45 },
    dark: { background: '#0f172a', sidebar: '#131c31', accent: '#7dd3fc', contrast: 60 }, translucentSidebar: true
  };
  if (preset === 'forest') return {
    light: { background: '#f3f6f1', sidebar: '#e1e9dd', accent: '#2f6b45', contrast: 45 },
    dark: { background: '#0f1712', sidebar: '#141f18', accent: '#86d7a0', contrast: 60 }, translucentSidebar: true
  };
  if (preset === 'sand') return {
    light: { background: '#f7f3ee', sidebar: '#ebe3d7', accent: '#9a5b2c', contrast: 45 },
    dark: { background: '#1a1714', sidebar: '#221d19', accent: '#e8b07f', contrast: 60 }, translucentSidebar: true
  };
  const { light, dark, translucentSidebar } = defaultAppearance();
  return { light, dark, translucentSidebar };
}
export function sameColors(a: AppearanceColors, b: AppearanceColors): boolean {
  const palette = (x: AppearancePalette, y: AppearancePalette) =>
    x.background === y.background && x.sidebar === y.sidebar && x.accent === y.accent && x.contrast === y.contrast;
  return palette(a.light, b.light) && palette(a.dark, b.dark) && a.translucentSidebar === b.translucentSidebar;
}

/** A theme code is one line of JSON, so it can be pasted into any chat or issue and read back. */
export function themeCode(settings: AppearanceColors): string {
  const palette = ({ background, sidebar, accent, contrast }: AppearancePalette) => ({ background, sidebar, accent, contrast });
  return JSON.stringify({ cosTheme: 1, light: palette(settings.light), dark: palette(settings.dark), translucentSidebar: settings.translucentSidebar });
}
/** Only six-digit colors and whole contrast values come back: never CSS, fonts or other fields. */
export function parseThemeCode(text: string): AppearanceColors | null {
  if (text.length > 2000) return null;
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return null; }
  const record = (input: unknown) => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const color = (input: unknown) => typeof input === 'string' && /^#[\da-fA-F]{6}$/.test(input) ? input.toLowerCase() : null;
  const palette = (input: unknown): AppearancePalette | null => {
    const fields = record(input);
    if (!fields) return null;
    const background = color(fields.background), sidebar = color(fields.sidebar), accent = color(fields.accent), contrast = fields.contrast;
    if (!background || !sidebar || !accent || !Number.isInteger(contrast) || (contrast as number) < 0 || (contrast as number) > 100) return null;
    return { background, sidebar, accent, contrast: contrast as number };
  };
  const code = record(value);
  if (code?.cosTheme !== 1 || typeof code.translucentSidebar !== 'boolean') return null;
  const light = palette(code.light), dark = palette(code.dark);
  return light && dark ? { light, dark, translucentSidebar: code.translucentSidebar } : null;
}

/** Field-wise three-way merge, so an unrelated save cannot undo another window's colors. */
export function mergeAppearance(live: AppearanceSettings | undefined, base: AppearanceSettings | undefined,
  wanted: AppearanceSettings | undefined): AppearanceSettings | undefined {
  if (!wanted) return live;
  const current = live ?? defaultAppearance(), before = base ?? defaultAppearance();
  const pick = <T>(a: T, b: T, c: T): T => Object.is(b, c) ? a : c;
  const palette = (theme: AppearanceTheme): AppearancePalette => ({
    background: pick(current[theme].background, before[theme].background, wanted[theme].background),
    sidebar: pick(current[theme].sidebar, before[theme].sidebar, wanted[theme].sidebar),
    accent: pick(current[theme].accent, before[theme].accent, wanted[theme].accent),
    contrast: pick(current[theme].contrast, before[theme].contrast, wanted[theme].contrast)
  });
  return { light: palette('light'), dark: palette('dark'), font: pick(current.font, before.font, wanted.font),
    fontSize: pick(current.fontSize, before.fontSize, wanted.fontSize),
    translucentSidebar: pick(current.translucentSidebar, before.translucentSidebar, wanted.translucentSidebar),
    sidebarLayout: pick(current.sidebarLayout, before.sidebarLayout, wanted.sidebarLayout) };
}

function channels(hex: string): number[] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}
export function mixColor(a: string, b: string, amount: number): string {
  const right = channels(b);
  return '#' + channels(a).map((value, i) => Math.round(value + (right[i]! - value) * amount)
    .toString(16).padStart(2, '0')).join('');
}
export function luminance(color: string): number {
  const linear = channels(color).map(value => {
    const n = value / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function readableInk(background: string): string {
  return contrastRatio(background, '#ffffff') > contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}
function readableTint(color: string, background: string, ratio: number): string {
  const ink = readableInk(background);
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, ink, step / 20);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return ink;
}

/** One palette feeds existing semantic CSS tokens, including independently colored sidebars. */
export function paletteTokens(background: string, accent: string, contrast: number): Record<string, string> {
  const ink = readableInk(background), c = contrast / 100;
  const card = mixColor(background, ink, .025 + .06 * c);
  const hover = mixColor(background, ink, .055 + .07 * c);
  return {
    '--page': background, '--ink': ink, '--card': card, '--sunk': mixColor(background, ink, .018 + .025 * c),
    '--hover': hover, '--raise': hover, '--popover': mixColor(background, ink, .06 + .06 * c),
    '--soft': readableTint(mixColor(background, ink, .53 + .2 * c), card, 4.5),
    '--faint': readableTint(mixColor(background, ink, .43 + .2 * c), card, 4.5),
    '--line': mixColor(background, ink, .09 + .13 * c), '--edge': mixColor(background, ink, .12 + .15 * c),
    '--track': mixColor(background, ink, .18 + .14 * c),
    '--blue': readableTint(accent, background, 4.5), '--accent': readableTint(accent, background, 4.5),
    '--accent-fill': accent, '--on-accent': readableInk(accent),
    '--wash': mixColor(background, accent, .12), '--blue-line': mixColor(background, accent, .3),
    '--accent-wash': mixColor(background, accent, .12), '--accent-edge': mixColor(background, accent, .35),
    '--knob-off': ink, '--knob-on': readableInk(accent),
    '--green': readableTint('#258552', card, 4.5), '--green-wash': mixColor(background, '#258552', .12),
    '--green-line': mixColor(background, '#258552', .3),
    '--red': readableTint('#d44545', card, 4.5), '--red-wash': mixColor(background, '#d44545', .12),
    '--red-line': mixColor(background, '#d44545', .3)
  };
}
