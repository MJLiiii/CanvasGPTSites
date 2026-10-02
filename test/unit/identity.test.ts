// Specs for src/http/identity.ts. Upstream has no gateway identity; the nearest upstream cases are the header
// handling tests of tests/test_http_transport.py (blank header, case-insensitive names, client-supplied values ignored).
import { describe, expect, it } from 'vitest';
import {
  BYPASS_TOKEN_HEADER,
  USER_EMAIL_HEADER,
  USER_FULL_NAME_ENCODING_HEADER,
  USER_FULL_NAME_HEADER,
  USER_ID_HEADER,
  resolveIdentity,
} from '../../src/http/identity';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

/**
 * A Headers stand-in for values the Node Headers class refuses to hold (code
 * points above U+00FF, CR, LF). A runtime may still deliver such bytes.
 */
function looseHeaders(values: Record<string, string>): Headers {
  const map = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    has: (name: string) => map.has(name.toLowerCase()),
    get: (name: string) => map.get(name.toLowerCase()) ?? null,
  } as unknown as Headers;
}

describe('resolveIdentity: well-formed gateway headers', () => {
  it('reads the id, the email and the full name', () => {
    const { identity, rejected } = resolveIdentity(
      headers({
        'oai-authenticated-user-id': 'user-0f9a77',
        'oai-authenticated-user-email': 'owner@example.edu',
        'oai-authenticated-user-full-name': 'Olive Owner',
      }),
    );
    expect(rejected).toBeUndefined();
    expect(identity).toEqual({
      key: 'id:user-0f9a77',
      userId: 'user-0f9a77',
      email: 'owner@example.edu',
      fullName: 'Olive Owner',
      source: 'sites-gateway',
    });
  });

  it('uses the header names the gateway documents', () => {
    expect(USER_ID_HEADER).toBe('oai-authenticated-user-id');
    expect(USER_EMAIL_HEADER).toBe('oai-authenticated-user-email');
    expect(USER_FULL_NAME_HEADER).toBe('oai-authenticated-user-full-name');
    expect(USER_FULL_NAME_ENCODING_HEADER).toBe('oai-authenticated-user-full-name-encoding');
    expect(BYPASS_TOKEN_HEADER).toBe('oai-sites-authorization');
  });

  it('keys the identity by the id when the id header is present', () => {
    const { identity } = resolveIdentity(headers({ [USER_ID_HEADER]: 'abc123', [USER_EMAIL_HEADER]: 'a@b.example' }));
    expect(identity?.key).toBe('id:abc123');
  });

  it('keys the identity by the email when there is no id header (ChatGPT Work may omit it)', () => {
    const { identity, rejected } = resolveIdentity(headers({ [USER_EMAIL_HEADER]: 'a@b.example' }));
    expect(rejected).toBeUndefined();
    expect(identity).toMatchObject({ key: 'email:a@b.example', userId: null, email: 'a@b.example' });
  });

  it('accepts an id without an email', () => {
    const { identity } = resolveIdentity(headers({ [USER_ID_HEADER]: 'abc123' }));
    expect(identity).toMatchObject({ key: 'id:abc123', userId: 'abc123', email: null });
  });

  it('lowercases the email and leaves the id exactly as sent', () => {
    const { identity } = resolveIdentity(headers({ [USER_ID_HEADER]: 'User-ABC', [USER_EMAIL_HEADER]: 'Owner@Example.EDU' }));
    expect(identity?.email).toBe('owner@example.edu');
    expect(identity?.userId).toBe('User-ABC');
    expect(identity?.key).toBe('id:User-ABC');
  });

  it('finds the headers whatever the case of their names', () => {
    const { identity } = resolveIdentity(
      headers({ 'OAI-Authenticated-User-Id': 'abc', 'Oai-Authenticated-User-Email': 'a@b.example' }),
    );
    expect(identity?.key).toBe('id:abc');
    expect(identity?.email).toBe('a@b.example');
  });

  it('ignores underscore variants of the header names', () => {
    const { identity, rejected } = resolveIdentity(
      headers({ oai_authenticated_user_email: 'owner@example.edu', oai_authenticated_user_id: 'abc' }),
    );
    expect(identity).toBeNull();
    expect(rejected).toBeUndefined();
  });

  it('ignores every other header that claims to name a user or carry a credential', () => {
    const { identity } = resolveIdentity(
      headers({
        'x-canvas-token': '7~abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
        'x-canvas-url': 'https://evil.example/api/v1',
        'x-mcp-access-key': 'key',
        'x-ms-client-principal-id': 'oid',
        'x-forwarded-email': 'owner@example.edu',
        authorization: 'Bearer owner@example.edu',
      }),
    );
    expect(identity).toBeNull();
  });
});

describe('resolveIdentity: no identity', () => {
  it('returns no identity and no rejection when neither header is present', () => {
    expect(resolveIdentity(headers({ 'content-type': 'application/json' }))).toEqual({ identity: null });
  });

  it('does not treat a full name alone as an identity', () => {
    expect(resolveIdentity(headers({ [USER_FULL_NAME_HEADER]: 'Olive Owner' })).identity).toBeNull();
  });
});

describe('resolveIdentity: malformed values fail closed', () => {
  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['a leading space the transport did not trim', ' owner@example.edu'],
    ['a comma', 'attacker@evil.example,owner@example.edu'],
    ['a comma and a space, as Headers.get joins duplicates', 'attacker@evil.example, owner@example.edu'],
    ['an inner space', 'owner@example.edu extra'],
    ['a tab', 'owner@example.edu\textra'],
    ['a control character', 'owner@example.edu\u0001'],
    ['DEL', 'owner\u007f@example.edu'],
    ['a non-ASCII letter', 'ownér@example.edu'],
    ['a full-width at sign', 'owner＠example.edu'],
    ['a zero-width space', 'owner\u200b@example.edu'],
    ['a Kelvin sign that lowercases to k', 'owner@Kexample.edu'],
  ])('rejects an email with %s', (_label, value) => {
    const { identity, rejected } = resolveIdentity(looseHeaders({ [USER_ID_HEADER]: 'abc', [USER_EMAIL_HEADER]: value }));
    expect(identity).toBeNull();
    expect(rejected).toBe('email_invalid');
  });

  it.each([
    ['empty', ''],
    ['a comma', 'forged,real'],
    ['a comma and a space', 'forged, real'],
    ['an inner space', 'abc def'],
    ['a control character', 'abc\u0002'],
    ['a non-ASCII character', 'abç'],
  ])('rejects a user id with %s', (_label, value) => {
    const { identity, rejected } = resolveIdentity(
      looseHeaders({ [USER_ID_HEADER]: value, [USER_EMAIL_HEADER]: 'owner@example.edu' }),
    );
    expect(identity).toBeNull();
    expect(rejected).toBe('user_id_invalid');
  });

  it('rejects a duplicated email header: the appended value joins the forged one', () => {
    const duplicated = new Headers();
    duplicated.append(USER_EMAIL_HEADER, 'owner@example.edu');
    duplicated.append(USER_EMAIL_HEADER, 'visitor@example.org');
    expect(duplicated.get(USER_EMAIL_HEADER)).toBe('owner@example.edu, visitor@example.org');
    expect(resolveIdentity(duplicated)).toEqual({ identity: null, rejected: 'email_invalid' });
  });

  it('rejects a duplicated header even when both copies are the owner', () => {
    const duplicated = new Headers();
    duplicated.append(USER_EMAIL_HEADER, 'owner@example.edu');
    duplicated.append(USER_EMAIL_HEADER, 'owner@example.edu');
    expect(resolveIdentity(duplicated).identity).toBeNull();
  });

  it('rejects a duplicated id header', () => {
    const duplicated = new Headers({ [USER_EMAIL_HEADER]: 'owner@example.edu' });
    duplicated.append(USER_ID_HEADER, 'forged');
    duplicated.append(USER_ID_HEADER, 'real');
    expect(resolveIdentity(duplicated)).toEqual({ identity: null, rejected: 'user_id_invalid' });
  });

  it('rejects the whole identity when only one of the two values is malformed', () => {
    const badEmail = resolveIdentity(headers({ [USER_ID_HEADER]: 'abc', [USER_EMAIL_HEADER]: 'a@b.example, c@d.example' }));
    expect(badEmail.identity).toBeNull();
    const badId = resolveIdentity(headers({ [USER_ID_HEADER]: 'a, b', [USER_EMAIL_HEADER]: 'owner@example.edu' }));
    expect(badId.identity).toBeNull();
  });

  it('rejects a value longer than any real identifier', () => {
    const long = `${'a'.repeat(400)}@example.edu`;
    expect(resolveIdentity(headers({ [USER_EMAIL_HEADER]: long })).rejected).toBe('email_invalid');
    expect(resolveIdentity(headers({ [USER_ID_HEADER]: 'x'.repeat(400) })).rejected).toBe('user_id_invalid');
  });

  it('never puts a header value in the rejection reason', () => {
    const { rejected } = resolveIdentity(headers({ [USER_EMAIL_HEADER]: 'secret person@example.edu' }));
    expect(rejected).toBe('email_invalid');
    expect(JSON.stringify(resolveIdentity(headers({ [USER_ID_HEADER]: 'a b' })))).not.toContain('a b');
  });

  it('survives a header value a real Headers object would refuse', () => {
    const stub = looseHeaders({ [USER_EMAIL_HEADER]: 'owner@example.edu\r\nx: y' });
    expect(resolveIdentity(stub)).toEqual({ identity: null, rejected: 'email_invalid' });
  });
});

describe('resolveIdentity: percent-decoding', () => {
  it('never percent-decodes the email, even when the encoding header says so', () => {
    const { identity } = resolveIdentity(
      headers({
        [USER_EMAIL_HEADER]: 'owner%40example.edu',
        [USER_FULL_NAME_ENCODING_HEADER]: 'percent-encoded-utf-8',
      }),
    );
    // Kept verbatim: it can never equal a configured owner address.
    expect(identity?.email).toBe('owner%40example.edu');
    expect(identity?.key).toBe('email:owner%40example.edu');
  });

  it('never percent-decodes the id', () => {
    const { identity } = resolveIdentity(
      headers({ [USER_ID_HEADER]: 'abc%2Cdef', [USER_FULL_NAME_ENCODING_HEADER]: 'percent-encoded-utf-8' }),
    );
    expect(identity?.userId).toBe('abc%2Cdef');
  });

  it('decodes the full name when the encoding header says percent-encoded-utf-8', () => {
    const { identity } = resolveIdentity(
      headers({
        [USER_ID_HEADER]: 'abc',
        [USER_FULL_NAME_HEADER]: 'Zo%C3%AB%20M%C3%BCller',
        [USER_FULL_NAME_ENCODING_HEADER]: 'percent-encoded-utf-8',
      }),
    );
    expect(identity?.fullName).toBe('Zoë Müller');
  });

  it('accepts the encoding name in any case', () => {
    const { identity } = resolveIdentity(
      headers({
        [USER_ID_HEADER]: 'abc',
        [USER_FULL_NAME_HEADER]: 'A%20B',
        [USER_FULL_NAME_ENCODING_HEADER]: 'Percent-Encoded-UTF-8',
      }),
    );
    expect(identity?.fullName).toBe('A B');
  });

  it.each([
    ['no encoding header', undefined],
    ['another encoding', 'base64'],
    ['a duplicated encoding header', 'percent-encoded-utf-8, percent-encoded-utf-8'],
  ])('leaves the full name as sent with %s', (_label, encoding) => {
    const values: Record<string, string> = { [USER_ID_HEADER]: 'abc', [USER_FULL_NAME_HEADER]: 'A%20B' };
    if (encoding !== undefined) values[USER_FULL_NAME_ENCODING_HEADER] = encoding;
    expect(resolveIdentity(headers(values)).identity?.fullName).toBe('A%20B');
  });

  it('drops a full name that does not decode, and keeps the identity', () => {
    const { identity, rejected } = resolveIdentity(
      headers({
        [USER_ID_HEADER]: 'abc',
        [USER_EMAIL_HEADER]: 'owner@example.edu',
        [USER_FULL_NAME_HEADER]: '%E0%A4%A',
        [USER_FULL_NAME_ENCODING_HEADER]: 'percent-encoded-utf-8',
      }),
    );
    expect(rejected).toBeUndefined();
    expect(identity?.fullName).toBeNull();
    expect(identity?.key).toBe('id:abc');
  });

  it('removes control characters a decoded name may carry and bounds its length', () => {
    const { identity } = resolveIdentity(
      headers({
        [USER_ID_HEADER]: 'abc',
        [USER_FULL_NAME_HEADER]: `Olive%0D%0AOwner%00${'x'.repeat(400)}`,
        [USER_FULL_NAME_ENCODING_HEADER]: 'percent-encoded-utf-8',
      }),
    );
    expect(identity?.fullName).not.toMatch(/[\u0000-\u001f]/);
    expect(identity?.fullName?.startsWith('Olive  Owner')).toBe(true);
    expect(identity?.fullName?.length).toBe(200);
  });

  it('treats an empty full name as absent', () => {
    expect(resolveIdentity(headers({ [USER_ID_HEADER]: 'abc', [USER_FULL_NAME_HEADER]: '' })).identity?.fullName).toBeNull();
  });
});

describe('resolveIdentity: the bypass token', () => {
  it('treats a request carrying oai-sites-authorization as identity-less, whatever else it carries', () => {
    const { identity, rejected } = resolveIdentity(
      headers({
        'oai-sites-authorization': 'bypass-token-value',
        [USER_ID_HEADER]: 'user-0f9a77',
        [USER_EMAIL_HEADER]: 'owner@example.edu',
      }),
    );
    expect(identity).toBeNull();
    expect(rejected).toBe('bypass_token_present');
  });

  it('does so for an empty bypass header and for any case of its name', () => {
    expect(resolveIdentity(headers({ 'OAI-Sites-Authorization': '', [USER_EMAIL_HEADER]: 'owner@example.edu' }))).toEqual({
      identity: null,
      rejected: 'bypass_token_present',
    });
  });
});

describe('resolveIdentity: the only input is the headers', () => {
  it('takes one argument, so a body or _meta can never supply an identity', () => {
    expect(resolveIdentity.length).toBe(1);
  });
});
