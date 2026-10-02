// Throwaway review test: shows why two existing tests pass for a reason other than the one they name.
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../../src/core/hash';
import { identityTag } from '../../src/core/logging';
import { parseConfig } from '../../src/env';

describe('review', () => {
  it('credentials.test.ts "withholds a credential in diagnostics mode even if secrets were handed in": the config already has errors', () => {
    // Exactly the config that test builds (its BASE_ENV plus the two overrides).
    const config = parseConfig({
      CANVAS_API_URL: 'https://canvas.example.edu',
      CANVAS_API_TOKEN: '',
      OWNER_EMAIL: 'owner@example.edu',
      DIAGNOSTICS_ENABLED: 'true',
    });
    console.log('REVIEW diagnosticsEnabled:', config.diagnosticsEnabled, 'errors:', JSON.stringify(config.errors.map((e) => e.code)));
    expect(config.errors.length).toBeGreaterThan(0); // resolve() refuses on this line alone
  });

  it('owner-gate.test.ts "does not use an unsalted hash of the identity as the tag": a tag keyed with a public constant passes the same check', () => {
    const tag = identityTag('id:user-222', 'k'); // HMAC with the fixed, public key "k"
    console.log('REVIEW tag with constant key:', tag, '== hmac("k", "identity-tag|id:user-222")[:12]:', hmacSha256Hex('k', 'identity-tag|id:user-222').slice(0, 12));
    for (const guess of ['id:user-222', 'user-222', 'visitor@example.org', 'email:visitor@example.org']) {
      expect(sha256Hex(guess).startsWith(tag)).toBe(false); // the test's only assertion
    }
  });
});
