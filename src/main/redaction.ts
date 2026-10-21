import { API_KEY_SHAPE, redactSecretShapes } from '../shared/secret-shapes.js';

/**
 * Recognizable API credentials in authored text, including keys pasted into browser form/code
 * arguments rather than configured as plugin secrets. Do not treat arbitrary long identifiers,
 * hashes or image bytes as credentials: those must survive tool results and exact recordings.
 */
export function redactCredentialText(text: string): string {
  return text.replace(API_KEY_SHAPE, '[redacted]');
}

/**
 * For text handed to another process rather than kept: everything `redactCredentialText` masks,
 * plus the credential shapes that turn up in chat and tool text (vendor-prefixed tokens, bearer
 * and basic auth headers, JWTs, URL passwords, private keys, MCP endpoint paths). The shapes live
 * in `src/shared/secret-shapes.ts`, which the composer's check before sending reads too.
 *
 * It is a list of known shapes, not a promise: a password or an unlabelled secret in prose passes
 * through. It is kept apart from `redactCredentialText` because that one guards exact recordings.
 * Like it, this never treats a bare hash or other long identifier as a credential.
 */
export function redactSecretText(text: string): string {
  return redactSecretShapes(text);
}
