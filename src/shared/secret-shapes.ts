/**
 * Credential shapes that can be recognized on sight. The main process masks them in text handed
 * to another process (`redactSecretText`); the composer checks a draft for them before it is sent.
 *
 * It is a list of known shapes, not a promise: a password or an unlabelled secret in prose passes
 * through. Never treat a bare hash or other long identifier as a credential: those must survive
 * tool results and exact recordings.
 */
interface SecretShape {
  readonly pattern: RegExp;
  /** What the match becomes; `$1` is the pattern's first group, kept in front of the mask. */
  readonly replacement: string;
  /** The harmless start of a match, to name it without repeating the secret. */
  readonly shown: (match: string) => string;
}

/** OpenAI-style API keys: also the only shape masked in exact recordings. */
export const API_KEY_SHAPE = /\bsk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g;

const start = (length: number) => (match: string) => `${match.slice(0, length)}…`;

const SECRET_SHAPES: readonly SecretShape[] = [
  { pattern: API_KEY_SHAPE, replacement: '[redacted]', shown: start(3) },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: '[redacted private key]',
    shown: match => match.slice(0, match.indexOf('KEY-----') + 8) },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replacement: '[redacted]',
    shown: match => start(match.startsWith('github_pat_') ? 11 : 4)(match) },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replacement: '[redacted]', shown: start(5) },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[redacted]', shown: start(4) },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: '[redacted]', shown: start(4) },
  { pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replacement: '[redacted]', shown: start(8) },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[redacted]', shown: start(3) },
  { pattern: /\b(Authorization:\s*(?:Basic|Bearer|Token))\s+[^\s"']+/gi, replacement: '$1 [redacted]',
    shown: match => `${match.replace(/\s+\S+$/, '')} …` },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, replacement: 'Bearer [redacted]', shown: () => 'Bearer …' },
  // A password inside a URL: scheme://user:secret@host.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replacement: '$1[redacted]@',
    shown: match => `${match.slice(0, match.indexOf('://') + 3)}…:…@` },
  // The secret path segment of one of this app's MCP endpoints.
  { pattern: /(\/mcp\/[a-z0-9-]+\/)[A-Za-z0-9_-]{20,}/g, replacement: '$1[redacted]',
    shown: match => `${match.slice(0, match.lastIndexOf('/') + 1)}…` }
];

/** Masks every shape in order, telling `found` about each match the mask changes. */
function maskShapes(text: string, found?: (shown: string) => void): string {
  let out = text;
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape.pattern, (match: string, ...rest: unknown[]) => {
      const masked = shape.replacement.replace('$1', () => String(rest[0]));
      // Already masked text, such as `Authorization: Bearer [redacted]`, is not found again.
      if (masked !== match) found?.(shape.shown(match));
      return masked;
    });
  }
  return out;
}

/** The text with every known credential shape masked. */
export function redactSecretShapes(text: string): string {
  return maskShapes(text);
}

/** How each distinct credential in the text starts (`ghp_…`), or nothing when it has none. */
export function findSecretShapes(text: string): string[] {
  const found = new Set<string>();
  maskShapes(text, shown => found.add(shown));
  return [...found];
}
