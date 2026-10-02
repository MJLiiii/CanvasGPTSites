// Specs for src/auth/credentials.ts and src/auth/owner-secret-provider.ts. Carries over the fail-closed cases of
// upstream tests/test_http_transport.py (no credential without an authenticated caller, the Canvas URL is server-pinned).
import { describe, expect, it } from 'vitest';
import { createCredentialProvider } from '../../src/auth/credentials';
import {
  NOT_AUTHORIZED_PUBLIC_MESSAGE,
  NOT_CONFIGURED_PUBLIC_MESSAGE,
  callerIdFor,
  createOwnerSecretProvider,
  matchOwner,
} from '../../src/auth/owner-secret-provider';
import { sha256Hex } from '../../src/core/hash';
import { createLogger } from '../../src/core/logging';
import { parseConfig, parseSecrets } from '../../src/env';
import type { Config, CredentialProvider, Env, Identity, Secrets } from '../../src/types';

const TOKEN = `7~${'Qw8'.repeat(16)}`;
const OTHER_TOKEN = `7~${'Zx1'.repeat(16)}`;
const OWNER_EMAIL = 'owner@example.edu';
const OWNER_ID = 'user-0f9a77';

const BASE_ENV: Env = {
  CANVAS_API_URL: 'https://canvas.example.edu',
  CANVAS_API_TOKEN: TOKEN,
  OWNER_EMAIL,
};

function identity(overrides: Partial<Identity> = {}): Identity {
  const merged = { userId: OWNER_ID as string | null, email: OWNER_EMAIL as string | null, fullName: 'Olive Owner', ...overrides };
  return {
    key: merged.userId !== null ? `id:${merged.userId}` : `email:${merged.email}`,
    userId: merged.userId,
    email: merged.email,
    fullName: merged.fullName,
    source: 'sites-gateway',
  };
}

interface Built {
  provider: CredentialProvider;
  config: Config;
  secrets: Secrets;
  logLines: string[];
}

function build(env: Env = {}): Built {
  const merged = { ...BASE_ENV, ...env };
  const config = parseConfig(merged);
  const secrets = parseSecrets(merged);
  const logLines: string[] = [];
  const log = createLogger({ level: 'debug', redactPii: true, sink: (line) => logLines.push(line) });
  return { provider: createCredentialProvider(config, secrets, { log }), config, secrets, logLines };
}

describe('owner mode: authorize', () => {
  it('is the provider for AUTH_MODE=owner, which is the default', () => {
    expect(build().provider.mode).toBe('owner');
    expect(build({ AUTH_MODE: 'owner' }).provider.mode).toBe('owner');
  });

  it('authorizes the configured owner', () => {
    expect(build().provider.authorize(identity())).toEqual({ ok: true });
  });

  it('authorizes the owner when OWNER_EMAIL was configured in another case', () => {
    expect(build({ OWNER_EMAIL: 'Owner@Example.EDU' }).provider.authorize(identity())).toEqual({ ok: true });
  });

  it.each([
    ['no identity', null],
    ['another email', identity({ email: 'visitor@example.org' })],
    ['an identity without an email', identity({ email: null })],
    ['a prefix of the owner email', identity({ email: 'owner@example.ed' })],
    ['the owner email with a suffix', identity({ email: 'owner@example.edu.evil.example' })],
    ['an email that differs only in case (identity emails arrive lowercased)', identity({ email: 'OWNER@example.edu' })],
    ['an empty email', identity({ email: '' })],
  ])('refuses %s with status 403', (_label, who) => {
    const result = build().provider.authorize(who);
    expect(result).toEqual({ ok: false, status: 403, publicMessage: NOT_AUTHORIZED_PUBLIC_MESSAGE });
  });

  it('refuses everyone when OWNER_EMAIL is not configured', () => {
    const { provider } = build({ OWNER_EMAIL: '' });
    expect(provider.authorize(identity()).ok).toBe(false);
    expect(provider.authorize(identity({ email: '' })).ok).toBe(false);
    expect(provider.authorize(identity({ email: null })).ok).toBe(false);
    expect(provider.authorize(null).ok).toBe(false);
  });

  it('never answers with a 401', () => {
    const results = [build().provider.authorize(null), build().provider.authorize(identity({ email: 'x@y.example' }))];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    }
  });

  it('gives every refusal the same fixed message, which names nothing from the configuration', () => {
    const messages = new Set<string>();
    for (const env of [{}, { OWNER_EMAIL: '' }, { OWNER_USER_ID_SHA256: sha256Hex('someone-else') }]) {
      for (const who of [null, identity({ email: 'visitor@example.org' }), identity({ email: null })]) {
        const result = build(env).provider.authorize(who);
        if (!result.ok) messages.add(result.publicMessage);
      }
    }
    expect([...messages]).toEqual([NOT_AUTHORIZED_PUBLIC_MESSAGE]);
    expect(NOT_AUTHORIZED_PUBLIC_MESSAGE).not.toContain(OWNER_EMAIL);
    expect(NOT_AUTHORIZED_PUBLIC_MESSAGE).not.toMatch(/OWNER_|CANVAS_|canvas\.example/);
  });
});

describe('owner mode: OWNER_USER_ID_SHA256', () => {
  const env = { OWNER_USER_ID_SHA256: sha256Hex(OWNER_ID) };

  it('authorizes when the email and the id both match', () => {
    const { provider, logLines } = build(env);
    expect(provider.authorize(identity())).toEqual({ ok: true });
    expect(logLines).toEqual([]);
  });

  it('accepts the hash in upper case', () => {
    expect(build({ OWNER_USER_ID_SHA256: sha256Hex(OWNER_ID).toUpperCase() }).provider.authorize(identity()).ok).toBe(true);
  });

  it('refuses the right email with the wrong id', () => {
    expect(build(env).provider.authorize(identity({ userId: 'user-other' })).ok).toBe(false);
  });

  it('refuses the right id with the wrong email', () => {
    expect(build(env).provider.authorize(identity({ email: 'visitor@example.org' })).ok).toBe(false);
  });

  it('passes on the email when the request carried no id, and says so in the log once', () => {
    const { provider, logLines } = build(env);
    expect(provider.authorize(identity({ userId: null }))).toEqual({ ok: true });
    expect(provider.authorize(identity({ userId: null }))).toEqual({ ok: true });
    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0] as string) as Record<string, unknown>;
    expect(line.level).toBe('security');
    expect(line.event).toBe('owner_id_header_absent');
    expect(logLines[0]).not.toContain(OWNER_EMAIL);
  });

  it('does not enforce an id when no hash is configured', () => {
    expect(build().provider.authorize(identity({ userId: 'anything' })).ok).toBe(true);
  });

  it('reports through matchOwner whether the match rests on the email alone', () => {
    const { config } = build(env);
    expect(matchOwner(config, identity())).toEqual({ ok: true, idHeaderAbsent: false });
    expect(matchOwner(config, identity({ userId: null }))).toEqual({ ok: true, idHeaderAbsent: true });
    expect(matchOwner(config, identity({ userId: 'nope' }))).toEqual({ ok: false, idHeaderAbsent: false });
    expect(matchOwner(config, null)).toEqual({ ok: false, idHeaderAbsent: false });
  });
});

describe('owner mode: resolve', () => {
  it('releases the credential to the owner', async () => {
    const result = await build().provider.resolve(identity());
    expect(result).toEqual({
      ok: true,
      credential: {
        apiBaseUrl: 'https://canvas.example.edu/api/v1',
        origin: 'https://canvas.example.edu',
        token: TOKEN,
        callerId: callerIdFor(TOKEN),
        kind: 'owner-secret',
      },
    });
  });

  it('checks the caller itself: it does not rely on a gate having run first', async () => {
    const { provider } = build();
    for (const who of [null, identity({ email: 'visitor@example.org' }), identity({ email: null })]) {
      const result = await provider.resolve(who);
      expect(result).toEqual({ ok: false, reason: 'forbidden', publicMessage: NOT_AUTHORIZED_PUBLIC_MESSAGE });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it('applies the id hash in resolve as well', async () => {
    const { provider } = build({ OWNER_USER_ID_SHA256: sha256Hex(OWNER_ID) });
    expect((await provider.resolve(identity({ userId: 'user-other' }))).ok).toBe(false);
    expect((await provider.resolve(identity())).ok).toBe(true);
  });

  it('pins the Canvas URL to the configuration, whatever the caller is', async () => {
    const result = await build({ CANVAS_API_URL: 'https://school.instructure.com/api/v1/courses' }).provider.resolve(identity());
    expect(result.ok && result.credential.apiBaseUrl).toBe('https://school.instructure.com/api/v1');
    expect(result.ok && result.credential.origin).toBe('https://school.instructure.com');
  });

  it.each([
    ['no token', { CANVAS_API_TOKEN: '' }],
    ['a blank token', { CANVAS_API_TOKEN: '   ' }],
    ['a token that cannot be sent in a header', { CANVAS_API_TOKEN: 'abc def\nghi' }],
    ['no Canvas URL', { CANVAS_API_URL: '' }],
    ['an invalid Canvas URL', { CANVAS_API_URL: 'http://canvas.example.edu' }],
    ['an unreadable write allowlist', { ALLOWED_WRITE_TOOLS: 'no_such_tool' }],
    ['an unknown role', { CANVAS_ROLE: 'admin' }],
  ])('answers not_configured with %s, even for the owner', async (_label, env) => {
    const result = await build(env).provider.resolve(identity());
    expect(result).toEqual({ ok: false, reason: 'not_configured', publicMessage: NOT_CONFIGURED_PUBLIC_MESSAGE });
  });

  it('withholds a credential in diagnostics mode even if secrets were handed in', async () => {
    const config = parseConfig({ ...BASE_ENV, CANVAS_API_TOKEN: '', DIAGNOSTICS_ENABLED: 'true' });
    // Isolate the provider's diagnostics defense from config validation.
    config.errors = [];
    const provider = createOwnerSecretProvider(config, { canvasToken: TOKEN, confirmationSecret: null, pseudonymSalt: null });
    expect((await provider.resolve(identity())).ok).toBe(false);
  });

  it('answers forbidden, not not_configured, to a stranger on a misconfigured deployment', async () => {
    const result = await build({ CANVAS_API_TOKEN: '' }).provider.resolve(identity({ email: 'visitor@example.org' }));
    expect(result).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('keeps its public messages free of configuration details', () => {
    for (const message of [NOT_AUTHORIZED_PUBLIC_MESSAGE, NOT_CONFIGURED_PUBLIC_MESSAGE]) {
      expect(message).not.toMatch(/example\.edu|OWNER_|CANVAS_API|https?:/);
    }
  });
});

describe('callerId', () => {
  it('is 64 hex characters, stable for a token and different between tokens', async () => {
    const first = await build().provider.resolve(identity());
    const second = await build().provider.resolve(identity());
    const other = await build({ CANVAS_API_TOKEN: OTHER_TOKEN }).provider.resolve(identity());
    if (!first.ok || !second.ok || !other.ok) throw new Error('expected credentials');
    expect(first.credential.callerId).toMatch(/^[0-9a-f]{64}$/);
    expect(second.credential.callerId).toBe(first.credential.callerId);
    expect(other.credential.callerId).not.toBe(first.credential.callerId);
  });

  it('is not the token, a plain hash of it, or anything that contains it', () => {
    const callerId = callerIdFor(TOKEN);
    expect(callerId).not.toContain(TOKEN);
    expect(callerId).not.toBe(sha256Hex(TOKEN));
    expect(callerId).not.toContain(TOKEN.slice(2, 12));
  });

  it('needs no secret besides the token', async () => {
    const withSecrets = await build({ CONFIRMATION_SECRET: 'c'.repeat(40), PSEUDONYM_SALT: 'salt-salt-salt' }).provider.resolve(identity());
    const without = await build().provider.resolve(identity());
    expect(withSecrets.ok && without.ok && withSecrets.credential.callerId === without.credential.callerId).toBe(true);
  });
});

describe('provider object', () => {
  it('is frozen, so a tool or a backend cannot swap its methods', () => {
    const { provider } = build();
    expect(Object.isFrozen(provider)).toBe(true);
    expect(() => {
      (provider as { authorize: unknown }).authorize = () => ({ ok: true });
    }).toThrow(TypeError);
  });

  it('does not expose the token as a property', () => {
    const { provider } = build();
    expect(JSON.stringify(provider)).not.toContain(TOKEN);
    expect(Object.values(provider).some((value) => value === TOKEN)).toBe(false);
  });

  it('works without a logger', () => {
    const config = parseConfig({ ...BASE_ENV, OWNER_USER_ID_SHA256: sha256Hex(OWNER_ID) });
    const provider = createCredentialProvider(config, parseSecrets(BASE_ENV));
    expect(provider.authorize(identity({ userId: null }))).toEqual({ ok: true });
  });
});

describe('unsupported authentication modes', () => {
  it.each(['per_user', 'everyone'])('never releases a credential for AUTH_MODE=%s', async (mode) => {
    const { config, provider } = build({ AUTH_MODE: mode });
    expect(config.errors.some((error) => error.code === 'auth_mode_invalid')).toBe(true);
    const result = await provider.resolve(identity());
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
