import { expect, it } from 'vitest';
import { answerHtml, answerPlainText } from '../src/shared/answer-copy.js';
import { markdownVisibleText } from '../src/shared/markdown-text.js';

it('keeps bullets, numbers, task boxes, nesting and table columns in a plain-text copy', () => {
  const markdown = '## Steps\n\n3. first\n4. second\n   - nested `a`\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSee [the docs](https://example.com).';
  expect(answerPlainText(markdown)).toBe('Steps\n\n3. first\n4. second\n  - nested a\n\n- [x] done\n- [ ] todo\n\nA\tB\n1\t2\n\nSee the docs.');
  // Search and Find read the same words as before, without the layout.
  expect(markdownVisibleText('- one\n- two\n')).toBe('one\ntwo\n');
});

it('drops a writing block\'s fence but keeps its words, closed or still open', () => {
  expect(answerPlainText('Here it is:\n\n:::writing{title="Note"}\nDear team,\n\nThanks.\n:::\n\nDone.')).toBe('Here it is:\n\nDear team,\n\nThanks.\n\nDone.');
  expect(answerPlainText(':::writing{title="Note"}\nStill writing\nmore')).toBe('Still writing\nmore');
  expect(answerHtml(':::writing\nDear team,\n:::')).toBe('<p>Dear team,</p>');
});

it('pastes markup in an answer as its words, and links only to web and mail addresses', () => {
  const html = answerHtml('Hi <script>alert(1)</script> ![chart](https://example.com/c.png)\n[web](https://example.com/a?b=1&c=2) [file](file:///C:/x) [js](javascript:alert(1))');
  expect(html).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; chart<br><a href="https://example.com/a?b=1&amp;c=2">web</a> file js</p>');
  // A task box is a character, not a form field in the pasted document.
  expect(answerHtml('- [x] done\n- [ ] todo')).toBe('<ul>\n<li>☑ done</li>\n<li>☐ todo</li>\n</ul>');
});
