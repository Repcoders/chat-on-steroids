import { describe, expect, it } from 'vitest';
import { dictationPieces, hasDictationCommands } from '../src/shared/dictation-commands.js';

describe('spoken commands in dictated text', () => {
  it('splits text and edits in order, with the punctuation Windows adds after a command', () => {
    expect(dictationPieces('Hello new line world. Scratch that.', 'en-US')).toEqual([
      { text: 'Hello' }, { command: 'newLine' }, { text: 'world.' }, { command: 'scratch' }
    ]);
    expect(dictationPieces('First point. New paragraph. Second point', 'en-GB')).toEqual([
      { text: 'First point.' }, { command: 'newParagraph' }, { text: 'Second point' }
    ]);
  });

  it('matches whole words only', () => {
    expect(dictationPieces('The newlines renew linear plans', 'en-US')).toEqual([{ text: 'The newlines renew linear plans' }]);
  });

  it('takes "send" only as a phrase of its own, since it is an ordinary word in a sentence', () => {
    expect(dictationPieces('Send.', 'en-US')).toEqual([{ command: 'send' }]);
    expect(dictationPieces('send it', 'en-US')).toEqual([{ command: 'send' }]);
    expect(dictationPieces('Please send the file', 'en-US')).toEqual([{ text: 'Please send the file' }]);
  });

  it('uses the phrases of the speech language Windows dictates in', () => {
    expect(dictationPieces('Hallo neue Zeile Welt das löschen', 'de-DE')).toEqual([
      { text: 'Hallo' }, { command: 'newLine' }, { text: 'Welt' }, { command: 'scratch' }
    ]);
    expect(dictationPieces('Senden.', 'de-DE')).toEqual([{ command: 'send' }]);
    expect(dictationPieces('Hola, nueva línea mundo', 'es-ES')).toEqual([{ text: 'Hola,' }, { command: 'newLine' }, { text: 'mundo' }]);
    expect(dictationPieces('Bonjour à la ligne Nouveau paragraphe', 'fr-FR')).toEqual([
      { text: 'Bonjour' }, { command: 'newLine' }, { command: 'newParagraph' }
    ]);
    expect(dictationPieces('Enviar', 'pt-BR')).toEqual([{ command: 'send' }]);
    // English phrases are words like any other in German dictation.
    expect(dictationPieces('new line', 'de-DE')).toEqual([{ text: 'new line' }]);
  });

  it('leaves a language without phrases, or an unknown one, as plain text', () => {
    expect(hasDictationCommands('en-US')).toBe(true);
    expect(hasDictationCommands('ja-JP')).toBe(false);
    expect(hasDictationCommands(undefined)).toBe(false);
    expect(hasDictationCommands('constructor')).toBe(false);
    expect(dictationPieces('send', 'ja-JP')).toEqual([{ text: 'send' }]);
    expect(dictationPieces('new line', undefined)).toEqual([{ text: 'new line' }]);
  });
});
