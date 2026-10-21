import { describe, expect, it } from 'vitest';
import { findSecretShapes, redactSecretShapes } from '../src/shared/secret-shapes.js';
import { redactSecretText } from '../src/main/redaction.js';

/**
 * The composer checks a draft for the credential shapes the control API already masks, and its
 * Redact masks exactly what the check named. Both read one list, so they cannot drift apart.
 */
describe('secret shapes in a draft', () => {
  const token = 'k'.repeat(43);
  const named: Array<[string, string]> = [
    [`sk-proj-${'a1'.repeat(12)}`, 'sk-…'],
    [`ghp_${'aB3'.repeat(12)}`, 'ghp_…'],
    [`github_pat_${'aB3'.repeat(16)}`, 'github_pat_…'],
    [`xoxb-${'1234567890-'.repeat(3)}abc`, 'xoxb-…'],
    [`AKIA${'Q'.repeat(16)}`, 'AKIA…'],
    [`AIza${'x'.repeat(35)}`, 'AIza…'],
    [`sk_live_${'a1'.repeat(12)}`, 'sk_live_…'],
    [`eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`, 'eyJ…'],
    [`Authorization: Bearer ${token}`, 'Authorization: Bearer …'],
    [`Bearer ${token}`, 'Bearer …'],
    ['postgres://admin:hunter2@db.internal:5432/app', 'postgres://…:…@'],
    [`https://tunnel.example/mcp/core/${token}`, '/mcp/core/…'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----']
  ];

  it.each(named)('names %s by its harmless start', (secret, shown) => {
    expect(findSecretShapes(`before ${secret} after`)).toEqual([shown]);
    expect(redactSecretShapes(`before ${secret} after`)).toBe(redactSecretText(`before ${secret} after`));
    expect(redactSecretShapes(`before ${secret} after`)).not.toContain(secret);
  });

  it('names each kind once, and nothing in a draft that was already masked', () => {
    const github = `ghp_${'aB3'.repeat(12)}`, other = `ghp_${'Zx9'.repeat(12)}`;
    expect(findSecretShapes(`${github} and ${other}, then AKIA${'Q'.repeat(16)}`)).toEqual(['ghp_…', 'AKIA…']);
    const masked = redactSecretShapes(`curl -H "Authorization: Bearer ${token}" ${github}`);
    expect(masked).toBe('curl -H "Authorization: Bearer [redacted]" [redacted]');
    expect(findSecretShapes(masked)).toEqual([]);
  });

  it('finds nothing in hashes, ids and ordinary prose', () => {
    for (const text of [
      '9fceb02d0ae598e95dc970b74767f19372d61af8',
      'Basic configuration is described in the implementation-details section',
      'The bearer of this note should read src/main/control-reads.ts',
      'https://example.test/docs/mcp/overview',
      'user@example.test'
    ]) expect(findSecretShapes(text)).toEqual([]);
  });
});
