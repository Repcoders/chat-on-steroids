import { describe, expect, it } from 'vitest';
import { wordDiff } from '../src/renderer/word-diff.js';

describe('word diff of two answers', () => {
  it('marks the words that changed on each side and keeps the rest', () => {
    const { before, after } = wordDiff('The login check reads the wrong field.', 'The login check reads the email field.');
    expect(before).toEqual([{ kind: 'same', text: 'The login check reads the ' }, { kind: 'removed', text: 'wrong' }, { kind: 'same', text: ' field.' }]);
    expect(after).toEqual([{ kind: 'same', text: 'The login check reads the ' }, { kind: 'added', text: 'email' }, { kind: 'same', text: ' field.' }]);
  });

  it('marks a reworded phrase as one change, not word by word', () => {
    const { before, after } = wordDiff('Restart the app now please.', 'Restart the service after the update please.');
    expect(before.filter(piece => piece.kind === 'removed').map(piece => piece.text)).toEqual(['app now']);
    expect(after.filter(piece => piece.kind === 'added').map(piece => piece.text)).toEqual(['service after the update']);
  });

  it('marks an added phrase without the spaces around it', () => {
    const { after } = wordDiff('Sign-in fails because the check is wrong.', 'Sign-in fails for new accounts because the check is wrong.');
    expect(after).toEqual([{ kind: 'same', text: 'Sign-in fails ' }, { kind: 'added', text: 'for new accounts' }, { kind: 'same', text: ' because the check is wrong.' }]);
  });

  it('keeps paragraphs apart: a change in each paragraph is two changes', () => {
    const { after } = wordDiff('One red.\n\nTwo red.', 'One blue.\n\nTwo blue.');
    expect(after.filter(piece => piece.kind === 'added').map(piece => piece.text)).toEqual(['blue', 'blue']);
  });

  it('compares Chinese and Japanese character by character', () => {
    const { before, after } = wordDiff('今天天气很好。', '今天天气不好。');
    expect(before).toEqual([{ kind: 'same', text: '今天天气' }, { kind: 'removed', text: '很' }, { kind: 'same', text: '好。' }]);
    expect(after).toEqual([{ kind: 'same', text: '今天天气' }, { kind: 'added', text: '不' }, { kind: 'same', text: '好。' }]);
  });

  it('gives each side back whole, so nothing is lost', () => {
    const a = 'Ein Satz mit Umlauten: Grüße, und 😀 Emoji.', b = 'Ein anderer Satz: Grüße 😀 und mehr.';
    const { before, after } = wordDiff(a, b);
    expect(before.map(piece => piece.text).join('')).toBe(a);
    expect(after.map(piece => piece.text).join('')).toBe(b);
    expect(before.some(piece => piece.kind === 'added') || after.some(piece => piece.kind === 'removed')).toBe(false);
  });
});
