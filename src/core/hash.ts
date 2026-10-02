/**
 * Synchronous hashing for the whole port.
 *
 * The anonymization scrubber is a synchronous recursive walk, WebCrypto digests
 * are async-only, and `node:crypto` depends on a compatibility flag the Sites
 * runtime may not set. A pure-JS implementation avoids all three problems.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

export function hmacSha256Hex(key: string | Uint8Array, input: string | Uint8Array): string {
  return bytesToHex(
    hmac(
      sha256,
      typeof key === 'string' ? utf8ToBytes(key) : key,
      typeof input === 'string' ? utf8ToBytes(input) : input,
    ),
  );
}

/** Length-independent comparison of two strings; false when lengths differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = utf8ToBytes(a);
  const y = utf8ToBytes(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
