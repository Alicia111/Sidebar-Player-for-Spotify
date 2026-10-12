import { createHash, randomBytes } from 'node:crypto';

// 64 random bytes encode to 86 base64url chars, inside RFC 7636's 43–128 range.
const VERIFIER_BYTE_LENGTH = 64;
const STATE_BYTE_LENGTH = 16;

export function createCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTE_LENGTH).toString('base64url');
}

export function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function createState(): string {
  return randomBytes(STATE_BYTE_LENGTH).toString('base64url');
}
