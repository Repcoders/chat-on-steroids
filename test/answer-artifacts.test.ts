import { expect, it } from 'vitest';
import { answerArtifacts } from '../src/shared/answer-artifacts.js';

it('lists an answer\'s code blocks, tables and display formulas in the order written', () => {
  const answer = [
    'Install it first:',
    '',
    '```bash',
    'npm install marked',
    '```',
    '',
    'The area is',
    '\\[',
    'A = \\pi r^2',
    '\\]',
    '',
    '| Size | Area |',
    '| --- | --- |',
    '| 1 | 3.14 |',
    '',
    '1. Then run:',
    '   ```ts',
    '   lex(text);',
    '   ```',
    '',
    '$$E = mc^2$$'
  ].join('\r\n');
  expect(answerArtifacts(answer)).toEqual([
    { kind: 'code', language: 'bash', text: 'npm install marked' },
    { kind: 'formula', text: 'A = \\pi r^2' },
    { kind: 'table', text: '| Size | Area |\n| --- | --- |\n| 1 | 3.14 |' },
    { kind: 'code', language: 'ts', text: 'lex(text);' },
    { kind: 'formula', text: 'E = mc^2' }
  ]);
});

it('leaves out formulas inside code, inline brackets and empty blocks', () => {
  const answer = [
    'Index it as `\\[0\\]` or a\\[0\\], inline \\(x\\) stays prose.',
    '',
    '````md',
    '\\[ not a formula \\]',
    '```',
    '$$ still code $$',
    '````',
    '',
    '```',
    '   ',
    '```',
    '',
    '\\[ unclosed'
  ].join('\n');
  expect(answerArtifacts(answer)).toEqual([
    { kind: 'code', language: 'md', text: '\\[ not a formula \\]\n```\n$$ still code $$' }
  ]);
});
