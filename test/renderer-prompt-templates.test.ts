import { afterEach, beforeEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createPromptTemplates, nextTemplateField, templateFields, templateName } from '../src/renderer/prompt-templates.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window });
});
afterEach(() => dom.window.close());

const names = (text: string) => templateFields(text).map(field => field.name);

it('reads each {{name}} of a draft as a field, but not braces in code', () => {
  const text = 'Review {{file}} for {{ audience }}.\n`{{inline}}` stays code.\n```\n{{fenced}}\n```\nThen {{last one}}.';
  expect(names(text)).toEqual(['file', 'audience', 'last one']);
  const [file] = templateFields(text);
  expect(text.slice(file!.start, file!.end)).toBe('{{file}}');
  expect(names('{{}} {{ }} {{a\nb}} {{x{y}} {{ok}}')).toEqual(['ok']);
  expect(names('An escaped \\` tick is not code: {{field}}')).toEqual(['field']);
});

it('reads code spans and fences the way Markdown does', () => {
  // A double-backtick span may hold a single backtick; only a run of the same length closes it.
  expect(names('``{{inside}} ` still code`` then {{outside}}')).toEqual(['outside']);
  // A run with no partner of its length is a literal backtick, and a span ends at a blank line.
  expect(names('Review ` and {{file}}')).toEqual(['file']);
  expect(names('Review `` and {{file}} ` here')).toEqual(['file']);
  expect(names('One `tick\n\n{{field}} and `{{code}}`')).toEqual(['field']);
  // A backslash escapes only an opening backtick; inside a span it is literal, so `code\` closes.
  expect(names('`code\\` {{field}} `')).toEqual(['field']);
  expect(names('\\\\`{{code}}` {{field}}')).toEqual(['field']);
  expect(names('\\`{{escaped}}` {{field}}')).toEqual(['escaped', 'field']);
  // A fence closes only on the same character, at least as long, with nothing after it.
  expect(names('~~~\n```\n{{literal}}\n~~~\n{{actual}}')).toEqual(['actual']);
  expect(names('````\n```\n{{literal}}\n````\n{{actual}}')).toEqual(['actual']);
  expect(names('```\n```js\n{{literal}}\n```\n{{actual}}')).toEqual(['actual']);
});

it('reads a pasted page of braces in one pass', () => {
  const text = `\`\`\`\n${'{{x}} '.repeat(20_000)}\n\`\`\`\n${'{{y}} '.repeat(20_000)}${' ` '.repeat(20_000)}`;
  const started = performance.now();
  expect(templateFields(text)).toHaveLength(20_000);
  expect(performance.now() - started).toBeLessThan(1_000);
});

it('steps forward and back through the fields and stops after the last one', () => {
  const text = 'Write {{topic}} for {{audience}} in {{tone}}.';
  const at = (name: string) => text.indexOf(`{{${name}}}`);
  expect(nextTemplateField(text, 0, 0)).toMatchObject({ name: 'topic', start: at('topic') });
  // From a selected field, the next one; typing over it leaves the caret before the next.
  expect(nextTemplateField(text, at('topic'), at('topic') + 9)).toMatchObject({ name: 'audience' });
  expect(nextTemplateField('Write essays for {{audience}}', 12, 12)).toMatchObject({ name: 'audience' });
  expect(nextTemplateField(text, at('tone'), at('tone') + 8)).toBeNull();
  expect(nextTemplateField(text, at('tone'), at('tone') + 8, true)).toMatchObject({ name: 'audience' });
  expect(nextTemplateField(text, at('topic'), at('topic') + 9, true)).toBeNull();
  expect(nextTemplateField('No fields here', 0, 0)).toBeNull();
});

it('names a template after its first line', () => {
  expect(templateName('\n\n  Weekly   report for {{team}}  \nBody')).toBe('Weekly report for {{team}}');
  const long = templateName(`${'word '.repeat(30)}\nBody`);
  expect(long).toHaveLength(60);
  expect(long.endsWith('…')).toBe(true);
});

it('saves the newest first, replaces a template of the same name and keeps them across a reload', () => {
  const templates = createPromptTemplates();
  expect(templates.save('  \n')).toEqual({ error: 'empty' });
  expect(templates.save('x'.repeat(10_001))).toEqual({ error: 'long' });
  expect(templates.save('Bug report\nSteps: {{steps}}')).toEqual({ saved: { name: 'Bug report', text: 'Bug report\nSteps: {{steps}}' }, stored: true });
  templates.save('Review {{file}}');
  templates.save('Bug report\nSteps: {{steps}}\nExpected: {{expected}}');
  expect(templates.list().map(row => row.name)).toEqual(['Bug report', 'Review {{file}}']);
  const reloaded = createPromptTemplates();
  expect(reloaded.list()[0]!.text).toBe('Bug report\nSteps: {{steps}}\nExpected: {{expected}}');
  reloaded.remove('Bug report');
  expect(createPromptTemplates().list().map(row => row.name)).toEqual(['Review {{file}}']);
});

it('says when a template could not be stored and lasts only in this window', () => {
  const templates = createPromptTemplates();
  expect(templates.save('Stored {{x}}')).toMatchObject({ stored: true });
  dom.window.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  expect(templates.save('Not stored {{x}}')).toMatchObject({ saved: { name: 'Not stored {{x}}' }, stored: false });
  expect(templates.list().map(row => row.name)).toEqual(['Not stored {{x}}', 'Stored {{x}}']);
});

it('stores no more than it reads back, so 50 long templates of quotes survive a reload', () => {
  const templates = createPromptTemplates();
  // Each serializes to about 20,000 characters: 50 of them would pass the stored bound.
  for (let index = 0; index < 50; index++) templates.save(`Quotes ${index}\n${'"'.repeat(9_980)}`);
  expect(templates.list()[0]!.name).toBe('Quotes 49');
  const reloaded = createPromptTemplates().list();
  expect(reloaded.length).toBeGreaterThan(40);
  expect(reloaded.map(row => row.name)).toEqual(templates.list().map(row => row.name));
  expect(reloaded[0]!.name).toBe('Quotes 49');
});

it('keeps at most 50 templates and ignores a corrupt or oversized store', () => {
  const templates = createPromptTemplates();
  for (let index = 0; index < 52; index++) templates.save(`Template ${index}`);
  expect(templates.list()).toHaveLength(50);
  expect(templates.list().at(-1)!.name).toBe('Template 2');
  dom.window.localStorage.setItem('chat-on-steroids.prompt-templates', '{not json');
  expect(createPromptTemplates().list()).toEqual([]);
  dom.window.localStorage.setItem('chat-on-steroids.prompt-templates', JSON.stringify([{ name: 'Fine', text: 'Fine' }, { name: 3, text: 'x' }, { name: 'Empty', text: ' ' }]));
  expect(createPromptTemplates().list()).toEqual([{ name: 'Fine', text: 'Fine' }]);
});
