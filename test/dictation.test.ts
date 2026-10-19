import { describe, expect, it } from 'vitest';
import { isDictationLanguageTag, parseDictationEvent, parseDictationLanguages } from '../src/shared/dictation.js';

describe('opt-in Windows dictation IPC contract', () => {
  it('accepts only the expected status, final and interim speech events', () => {
    expect(parseDictationEvent('{"type":"status","status":"listening"}')).toEqual({
      type: 'status', status: 'listening'
    });
    expect(parseDictationEvent('{"type":"partial","text":"Hola"}')).toEqual({
      type: 'partial', text: 'Hola'
    });
    expect(parseDictationEvent('{"type":"final","text":"  Hola, mundo  "}')).toEqual({
      type: 'final', text: 'Hola, mundo'
    });
    expect(parseDictationEvent('{"type":"status","status":"recording secret"}')).toBeNull();
    expect(parseDictationEvent('{"type":"start","text":"ignore"}')).toBeNull();
  });

  it('says which Windows engine is listening, and nothing else', () => {
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"modern"}')).toEqual({
      type: 'status', status: 'listening', engine: 'modern'
    });
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"legacy"}')).toEqual({
      type: 'status', status: 'listening', engine: 'legacy'
    });
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"cloud"}')).toEqual({
      type: 'status', status: 'listening'
    });
    expect(parseDictationEvent('{"type":"status","status":"stopped","engine":"legacy"}')).toEqual({
      type: 'status', status: 'stopped'
    });
  });

  it('rejects malformed messages and bounds transcript/error length', () => {
    expect(parseDictationEvent('not json')).toBeNull();
    expect(parseDictationEvent('null')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":12}')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":"  "}')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":"hi\\u0000there"}')).toEqual({
      type: 'final', text: 'hithere'
    });
    expect(parseDictationEvent(JSON.stringify({ type: 'final', text: 'x'.repeat(17_000) }))).toBeNull();
    const event = parseDictationEvent(JSON.stringify({ type: 'error', message: 'oops'.repeat(100) }));
    expect(event?.type).toBe('error');
    expect(event && 'message' in event ? event.message.length : 0).toBe(240);
  });

  it('lists each installed speech language once, by name, and only well-formed tags', () => {
    expect(parseDictationLanguages(JSON.stringify([
      { tag: 'en-US', name: 'English (United States)' },
      { tag: 'de-DE', name: 'Deutsch (Deutschland)' },
      { tag: 'EN-us', name: 'English (legacy)' },
      { tag: "de'; Remove-Item x", name: 'Bad' },
      { tag: 'zh-Hant-TW', name: '' },
      { tag: 7, name: 'Number' },
      null
    ]))).toEqual([
      { tag: 'de-DE', name: 'Deutsch (Deutschland)' },
      { tag: 'en-US', name: 'English (United States)' },
      { tag: 'zh-Hant-TW', name: 'zh-Hant-TW' }
    ]);
    expect(parseDictationLanguages('not json')).toEqual([]);
    expect(parseDictationLanguages('{"tag":"en-US"}')).toEqual([]);
    expect(parseDictationLanguages(JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ tag: `x${String.fromCharCode(97 + i % 26)}-${100 + i}`, name: `L${i}` }))))).toHaveLength(64);
    expect(['en', 'de-DE', 'zh-Hant-TW', 'es-419'].every(isDictationLanguageTag)).toBe(true);
    expect(['', 'e', 'de_DE', "de'", 'de-DE-x-very-long-part', 12].some(isDictationLanguageTag)).toBe(false);
  });
});
