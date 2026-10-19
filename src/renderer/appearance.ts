import { APPEARANCE_PRESETS, defaultAppearance, mixColor, paletteTokens, parseThemeCode, presetColors, sameColors, themeCode,
  type AppearanceColors, type AppearanceSettings, type AppearanceTheme } from '../shared/appearance.js';
import type { UiPrefs } from '../shared/types.js';
import { $, run, toast } from './dom.js';
import { t } from './i18n.js';

const FONT_FAMILIES = {
  system: '', sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif', mono: '"Cascadia Mono", Consolas, monospace'
};
const appearanceListeners = new Set<() => void>();
/** Canvas/terminal renderers must refresh after the CSS palette has been applied. */
export function onAppearanceChanged(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => { appearanceListeners.delete(listener); };
}
function tokens(element: HTMLElement, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
}

export function applyAppearance(theme: AppearanceTheme, settings?: AppearanceSettings): void {
  const value = settings ?? defaultAppearance(), palette = value[theme], root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.translucentSidebar = String(value.translucentSidebar);
  tokens(root, paletteTokens(palette.background, palette.accent, palette.contrast));
  root.style.setProperty('--text-scale', String(value.fontSize / 14));
  if (value.font === 'system') root.style.removeProperty('--ui-font');
  else root.style.setProperty('--ui-font', FONT_FAMILIES[value.font]);
  root.style.setProperty('--sidebar-color', palette.sidebar);
  // Glass is composed inside the window: a colored backdrop and translucent layer.
  // No native transparent window, desktop capture, or platform permission is needed.
  const sidebarBackground = value.translucentSidebar ? mixColor(palette.sidebar, palette.background, .13) : palette.sidebar;
  for (const element of document.querySelectorAll<HTMLElement>('.sidebar, .app-topbar, .appearance-preview-sidebar, .connection-popover')) {
    tokens(element, paletteTokens(sidebarBackground, palette.accent, palette.contrast));
  }
  for (const listener of appearanceListeners) listener();
}

/** Only the in-progress form edit is local; the existing Settings queue owns persistence. */
export function initAppearance(save: (patch: { theme?: AppearanceTheme; appearance?: AppearanceSettings }) => void): { apply(ui: UiPrefs): void } {
  const panel = $('appearancePanel');
  let theme: AppearanceTheme = 'dark';
  let current = defaultAppearance();
  let editing = false;
  const colorKeys = ['accent', 'background', 'sidebar'] as const;
  function paint(): void {
    applyAppearance(theme, current);
    $<HTMLSelectElement>('appearanceTheme').value = theme;
    $<HTMLSelectElement>('appearanceFont').value = current.font;
    $<HTMLSelectElement>('appearanceSidebarLayout').value = current.sidebarLayout;
    $<HTMLInputElement>('appearanceSize').value = String(current.fontSize);
    $('appearanceSizeValue').textContent = `${current.fontSize} px`;
    $<HTMLInputElement>('appearanceContrast').value = String(current[theme].contrast);
    $('appearanceContrastValue').textContent = String(current[theme].contrast);
    $<HTMLInputElement>('appearanceTranslucent').checked = current.translucentSidebar;
    for (const key of colorKeys) {
      const color = current[theme][key];
      panel.querySelector<HTMLInputElement>(`[data-color="${key}"]`)!.value = color;
      const hex = panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!;
      if (document.activeElement !== hex) hex.value = color.toUpperCase();
    }
    for (const preset of APPEARANCE_PRESETS) {
      const button = panel.querySelector<HTMLButtonElement>(`[data-preset="${preset}"]`)!, colors = presetColors(preset);
      button.setAttribute('aria-pressed', String(sameColors(current, colors)));
      // The swatch shows the preset in the theme being edited, not the live page colors.
      const swatch = button.querySelector<HTMLElement>('.appearance-preset-swatch')!;
      for (const key of colorKeys) swatch.style.setProperty(`--preset-${key}`, colors[theme][key]);
    }
  }
  function useColors(colors: AppearanceColors): void {
    editing = false;
    current = { ...current, light: colors.light, dark: colors.dark, translucentSidebar: colors.translucentSidebar };
    paint(); save({ appearance: current });
  }
  function update(control: HTMLInputElement | HTMLSelectElement): boolean {
    if (control.dataset.color || control.dataset.hex) {
      const key = (control.dataset.color ?? control.dataset.hex) as typeof colorKeys[number];
      const value = control.value.trim();
      if (!/^#[\da-fA-F]{6}$/.test(value)) {
        control.setAttribute('aria-invalid', 'true');
        return false;
      }
      control.removeAttribute('aria-invalid');
      current = { ...current, [theme]: { ...current[theme], [key]: value.toLowerCase() } };
      // Keep the hex text in sync with native picker gestures too.
      if (control.dataset.color) panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!.value = value.toUpperCase();
    } else if (control.id === 'appearanceSize') current = { ...current, fontSize: Number(control.value) };
    else if (control.id === 'appearanceContrast') current = { ...current, [theme]: { ...current[theme], contrast: Number(control.value) } };
    else if (control.id === 'appearanceFont') current = { ...current, font: control.value as AppearanceSettings['font'] };
    else if (control.id === 'appearanceSidebarLayout') current = { ...current, sidebarLayout: control.value as AppearanceSettings['sidebarLayout'] };
    else if (control.id === 'appearanceTranslucent') current = { ...current, translucentSidebar: (control as HTMLInputElement).checked };
    else return false;
    paint();
    return true;
  }
  panel.addEventListener('input', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || !control.id.startsWith('appearance')) return;
    editing = true;
    update(control);
  });
  panel.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id.startsWith('appearance')) return;
    editing = false;
    if (control.id === 'appearanceTheme') {
      theme = control.value as AppearanceTheme;
      paint(); save({ theme });
    } else if (update(control)) save({ appearance: current });
    else {
      // Incomplete hex input never becomes CSS or durable config. Restore the last valid value.
      control.removeAttribute('aria-invalid');
      if (control.dataset.hex) control.value = current[theme][control.dataset.hex as typeof colorKeys[number]].toUpperCase();
    }
  });
  $('appearanceReset').addEventListener('click', () => {
    // Colors and typography only: the sidebar keeps the layout the person chose.
    editing = false; current = { ...defaultAppearance(), sidebarLayout: current.sidebarLayout }; paint(); save({ appearance: current });
  });
  for (const preset of APPEARANCE_PRESETS) {
    panel.querySelector(`[data-preset="${preset}"]`)!.addEventListener('click', () => useColors(presetColors(preset)));
  }
  $('appearanceCodeCopy').addEventListener('click', async () => {
    if (await run(window.api.writeClipboard(themeCode(current)))) toast(t('Theme code copied'));
  });
  const dialog = $<HTMLDialogElement>('themeCodeDialog'), input = $<HTMLTextAreaElement>('themeCodeInput'), error = $('themeCodeError');
  const showError = (shown: boolean) => {
    error.hidden = !shown;
    if (shown) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  };
  $('appearanceCodePaste').addEventListener('click', () => {
    input.value = ''; showError(false); dialog.showModal(); input.focus();
  });
  input.addEventListener('input', () => showError(false));
  $('themeCodeCancel').addEventListener('click', () => dialog.close());
  $('themeCodeForm').addEventListener('submit', event => {
    event.preventDefault();
    const colors = parseThemeCode(input.value);
    if (!colors) { showError(true); input.focus(); return; }
    dialog.close(); useColors(colors);
  });
  return { apply(ui) {
    if (editing) return;
    theme = ui.theme; current = ui.appearance ?? defaultAppearance(); paint();
  } };
}
