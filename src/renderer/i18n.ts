import zhCN from './locales/zh-CN.json';
import es from './locales/es.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import tr from './locales/tr.json';
import fr from './locales/fr.json';
import ptPT from './locales/pt-PT.json';
import ptBR from './locales/pt-BR.json';
import de from './locales/de.json';
import ru from './locales/ru.json';
import vi from './locales/vi.json';

export type Language = 'en' | 'es' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'tr' | 'vi' | 'fr' | 'pt-PT' | 'pt-BR' | 'de' | 'ru';
const STORAGE_KEY = 'cos.ui.language';
type Catalog = Readonly<Record<string, string>>;
const catalogs: Readonly<Record<Exclude<Language, 'en'>, Catalog>> = { es, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, tr, vi, fr, 'pt-PT': ptPT, 'pt-BR': ptBR, de, ru };
const sourceKeys = new Set(Object.values(catalogs).flatMap(catalog => Object.keys(catalog)));

function parseLanguage(value: string | null | undefined): Language {
  return value === 'es' || value === 'zh-CN' || value === 'zh-TW' || value === 'ja' || value === 'ko' || value === 'tr' || value === 'vi' || value === 'fr' || value === 'pt-PT' || value === 'pt-BR' || value === 'de' || value === 'ru' ? value : 'en';
}

/**
 * The first of the system's preferred languages that the app speaks, else English. Only a first start
 * uses it: once someone picks a language, the saved choice wins. Before this, a German Windows opened
 * Setup in English with nothing on screen saying the app speaks German.
 */
export function systemLanguage(preferred: readonly string[]): Language {
  for (const raw of preferred) {
    const tag = String(raw).toLowerCase();
    const [base] = tag.split('-');
    if (base === 'zh') return /-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-TW' : 'zh-CN';
    if (base === 'pt') return /^pt-pt\b/.test(tag) ? 'pt-PT' : 'pt-BR';
    if (base === 'en' || base === 'es' || base === 'ja' || base === 'ko' || base === 'tr' || base === 'vi' || base === 'fr' || base === 'de' || base === 'ru') return base;
  }
  return 'en';
}

function systemPreferred(): readonly string[] {
  try { return window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language]; }
  catch { return []; }
}

let language: Language = 'en';
try {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  language = saved === null ? systemLanguage(systemPreferred()) : parseLanguage(saved);
} catch { /* Storage may be unavailable in a restricted renderer; follow the system as on a first start. */
  language = systemLanguage(systemPreferred());
}

export function currentLanguage(): Language { return language; }

const FORMAT_KEY = 'cos.ui.formatLocale';
/** Appearance's fixed number and date formats, beside the app language and the system region. */
export const FORMAT_LOCALES = ['en-US', 'en-GB', 'de-DE', 'de-CH', 'fr-FR', 'es-ES', 'es-MX', 'it-IT', 'nl-NL', 'pl-PL',
  'pt-BR', 'pt-PT', 'ru-RU', 'sv-SE', 'tr-TR', 'vi-VN', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'] as const;
export type FormatChoice = 'app' | 'system' | typeof FORMAT_LOCALES[number];
function parseFormatChoice(value: string | null | undefined): FormatChoice {
  return value === 'system' || (FORMAT_LOCALES as readonly string[]).includes(value ?? '') ? value as FormatChoice : 'app';
}
let formatChoice: FormatChoice = 'app';
try { formatChoice = parseFormatChoice(window.localStorage.getItem(FORMAT_KEY)); }
catch { /* Without storage, numbers and dates follow the app language. */ }
let systemLocale: string | null = null;

/**
 * The locale numbers, dates and times are written in: the app language unless Appearance picks the
 * system region or a fixed format. Labels stay in the app language, and so do words that stand
 * alone, such as a weekday or month heading, a "5h" age or an "and" list.
 */
export function formatLocale(): string {
  return formatChoice === 'app' ? language : formatChoice === 'system' ? systemLocale ?? language : formatChoice;
}

const languageListeners = new Set<() => void>();
/** Runs after each language change, for copy that leaves this document (#855). */
export function onLanguageChange(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => { languageListeners.delete(listener); };
}

function fill(text: string, args: readonly unknown[]): string {
  return text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const catalog = language === 'en' ? undefined : catalogs[language];
  const key = catalog && Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const translated = catalog && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return fill(translated, args);
}

const pluralRules = new Map<Language, Intl.PluralRules>();
function pluralOf(locale: Language, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, rules = new Intl.PluralRules(locale));
  return Number.isFinite(count) ? rules.select(count) : 'other';
}

/** The forms besides "other" a language words a count in, each kept in its catalog as `"<other>|<form>"`. */
export function pluralForms(locale: Language): Intl.LDMLPluralRule[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories.filter(form => form !== 'other');
}

/**
 * A count and what it counts, in the language's own plural form: "1 line", "2 lines"; Russian
 * "1 строка", "2 строки", "5 строк". `one` and `other` are the English forms; a catalog keeps
 * `other`'s translation under `other` and each further form under `"<other>|<form>"`. `count` picks
 * the form and is `{0}` unless `args` says otherwise, so a formatted or second number can be shown.
 */
export function tn(one: string, other: string, count: number, args: readonly unknown[] = [count]): string {
  const form = pluralOf(language, count);
  if (language === 'en') return fill(form === 'one' ? one : other, args);
  const catalog = catalogs[language];
  const translated = form !== 'other' && Object.hasOwn(catalog, `${other}|${form}`) ? catalog[`${other}|${form}`]!
    : Object.hasOwn(catalog, other) ? catalog[other]! : form === 'one' ? one : other;
  return fill(translated, args);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint' | 'data-empty';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();

function read(node: Node, property: Property): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}
function write(node: Node, property: Property, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

/** Bind the existing node, never reconstruct controls, drafts, icons or chat history. */
export function ui<T extends Node>(node: T, property: Property, value: () => string): T {
  let properties = bindings.get(node);
  if (!properties) {
    bindings.set(node, properties = new Map());
  }
  const last = value();
  properties.set(property, { read: value, last });
  write(node, property, last);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

export function setLanguage(next: Language): void {
  language = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The current window can still change language. */ }
  document.documentElement.lang = next;
  syncLanguageControls();
  for (const listener of languageListeners) {
    try { listener(); } catch { /* One listener cannot block the repaint below. */ }
  }
  repaint();
}

/** Appearance › Number and date format; labels keep the app language. */
export function setFormatChoice(next: FormatChoice): void {
  formatChoice = next;
  try { window.localStorage.setItem(FORMAT_KEY, next); } catch { /* The current window still changes format. */ }
  syncFormatControl();
  repaint();
}

/** The operating system's region locale, as the main process reads it; anything else is ignored. */
export function setSystemLocale(tag: unknown): void {
  let next: string | null = null;
  try { next = typeof tag === 'string' && tag ? Intl.getCanonicalLocales(tag)[0] ?? null : null; } catch { /* Not a locale. */ }
  if (next === systemLocale) return;
  systemLocale = next;
  repaint();
}

function repaint(): void {
  // The document owns the live labels, including hidden settings and collapsed
  // history. Do not index every label ever created: sweeping WeakRefs during
  // rendering keeps their detached DOM trees alive until the job ends and makes
  // each repaint revisit accumulated history. Bindings alone do not retain nodes.
  const walker = document.createTreeWalker(document.body, 1 | 4 /* elements + text */);
  do {
    const node = walker.currentNode;
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  } while (walker.nextNode());
}

/** Setup and settings project the same saved preference. */
function syncLanguageControls(): void {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select) select.value = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
}

const FORMAT_SAMPLE = new Date(2026, 9, 20, 15, 30);
/** "1,234.5 · 10/20/26, 3:30 PM": what a format choice writes. */
function formatExample(locale: string): string {
  return `${new Intl.NumberFormat(locale).format(1234.5)} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(FORMAT_SAMPLE)}`;
}
function localeName(locale: string): string {
  try { return new Intl.DisplayNames(language, { type: 'language' }).of(locale) ?? locale; } catch { return locale; }
}
function syncFormatControl(): void {
  const select = document.getElementById('uiFormatLocale') as HTMLSelectElement | null;
  if (select) select.value = formatChoice;
}
function initFormatControl(): void {
  const select = document.getElementById('uiFormatLocale') as HTMLSelectElement | null;
  if (!select) return;
  const option = (value: FormatChoice, label: () => string): void => {
    const node = document.createElement('option');
    node.value = value;
    select.append(ui(node, 'textContent', label));
  };
  option('app', () => `${t('Same as language')} · ${formatExample(language)}`);
  option('system', () => systemLocale ? `${t('System region')} · ${formatExample(systemLocale)}` : t('System region'));
  for (const locale of FORMAT_LOCALES) option(locale, () => `${localeName(locale)} · ${formatExample(locale)}`);
  syncFormatControl();
  select.addEventListener('change', () => setFormatChoice(parseFormatChoice(select.value)));
}

/** Run once on the static shell, before any user/provider content is inserted. */
export function initLanguage(): void {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (sourceKeys.has(key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    if (node.closest('[translate="no"]')) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && sourceKeys.has(source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  syncLanguageControls();
  select.addEventListener('change', () => setLanguage(parseLanguage(select.value)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.addEventListener('click', () => setLanguage(parseLanguage(button.dataset.language)));
  }
  initFormatControl();
}
