// Ports the client-level cases of tests/security/test_path_segment_injection.py and adds the
// encoded dot-segment cases of security review finding 1: an identifier can neither
// retarget a request nor change the anonymization tier applied to its response.
import { describe, expect, it } from 'vitest';
import { isFailure } from '../../src/canvas/errors';
import { CanvasPathError, canvasPath } from '../../src/canvas/path';
import type { CanvasPath, RequestFailure } from '../../src/types';
import { FAKE_TOKEN, createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.com';
const API = `${ORIGIN}/api/v1`;

/** A path made without the builder, as a buggy or hostile caller would. */
function forged(path: string): CanvasPath {
  return path as CanvasPath;
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
  return value;
}

/** A fake that answers every path, so a retargeted request would succeed and be seen. */
function openCanvas() {
  const fake = createFakeCanvas({ origin: ORIGIN });
  const secret = { id: 456, user_id: 999, name: 'Victim Realname', body: 'private submission text' };
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    fake.route(method, /.*/, () => json(secret));
  }
  return { fake, ...createTestClient(fake) };
}

const HOSTILE_IDENTIFIERS = [
  '%2e%2e',
  '%2E%2E',
  '.%2E',
  '%2e.',
  'x/%2e%2e/assignments/5',
  'x/../assignments/5',
  '../assignments/5',
  '%2e%2e/%2e%2e/users/2',
  '..%2f..%2fusers%2f2',
  '..%5c..%5cusers',
  '..\\..\\users',
  '123/submissions/456?',
  '123/submissions/456#',
  '123%2Fsubmissions%2F456?',
  'x?include[]=user',
  'x#fragment',
  'x;param',
  '//evil.example/x',
  'https://evil.example/x',
  '@evil.example',
  'x/%2e%2e/%2e%2e/assignments/2/submissions/self/%2e%2e/456',
];

describe('identifiers built with canvasPath stay one path segment', () => {
  it.each(HOSTILE_IDENTIFIERS)('GET with the page slug %j cannot be retargeted', async (slug) => {
    const { fake, client } = openCanvas();

    await client.request('get', canvasPath`/courses/${1}/pages/${slug}`);

    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]!.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/api/v1/courses/1/pages/${encodeURIComponent(slug)}`);
    expect(url.pathname.split('/')).toHaveLength(7);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(fake.calls[0]!.url).toBe(`${API}/courses/1/pages/${encodeURIComponent(slug)}`);
  });

  // The exploit of finding 1: delete_page(page_url_or_id="%2e%2e/assignments/5").
  it.each(HOSTILE_IDENTIFIERS)('DELETE and PUT with the slug %j stay on the page route', async (slug) => {
    const { fake, client } = openCanvas();

    await client.request('delete', canvasPath`/courses/${1}/pages/${slug}`);
    await client.request('put', canvasPath`/courses/${1}/pages/${slug}`, { useFormData: true, data: { a: 1 } });

    expect(fake.calls.map((call) => call.method)).toEqual(['DELETE', 'PUT']);
    for (const call of fake.calls) {
      expect(new URL(call.url).pathname).toBe(`/api/v1/courses/1/pages/${encodeURIComponent(slug)}`);
    }
  });

  it.each(HOSTILE_IDENTIFIERS)('the self-scoped suffix survives the assignment id %j', async (assignmentId) => {
    const { fake, client } = openCanvas();

    await client.request('get', canvasPath`/courses/${60366}/assignments/${assignmentId}/submissions/self`);

    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname.endsWith('/submissions/self')).toBe(true);
    expect(url.pathname).toBe(`/api/v1/courses/60366/assignments/${encodeURIComponent(assignmentId)}/submissions/self`);
  });

  it.each(HOSTILE_IDENTIFIERS)('pagination with the identifier %j stays on its endpoint', async (id) => {
    const { fake, client } = openCanvas();
    fake.route('GET', /.*/, () => json([{ id: 1 }]));

    await client.fetchAll(canvasPath`/courses/${id}/assignments`);

    expect(fake.calls).toHaveLength(1);
    expect(new URL(fake.calls[0]!.url).pathname).toBe(`/api/v1/courses/${encodeURIComponent(id)}/assignments`);
  });

  it.each(['..', '.', '', 'a\u0000b', 'a\nb'])('the builder refuses the identifier %j outright', (value) => {
    expect(() => canvasPath`/courses/${1}/pages/${value}`).toThrow(CanvasPathError);
  });
});

describe('a hand-built path is refused before the network', () => {
  // Port of TestClientRefusesDelimiters.
  it.each(['?', '#'])('refuses an endpoint containing %j', async (delimiter) => {
    const { fake, client } = openCanvas();

    const failure = failureOf(
      await client.request('get', forged(`/courses/1/assignments/123${delimiter}x/submissions/self`)),
    );

    expect(failure.outcome).toBe('not_dispatched');
    expect(failure.error).toMatch(/^Invalid endpoint/);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an endpoint with a traversal segment', async () => {
    const { fake, client } = openCanvas();

    const failure = failureOf(await client.request('get', forged('/courses/1/assignments/../../users/2')));

    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
  });

  it('does not refuse an ordinary endpoint', async () => {
    const { fake, client } = openCanvas();

    await client.request('get', forged('/courses/1/assignments/123/submissions/self'));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(`${API}/courses/1/assignments/123/submissions/self`);
  });

  it.each([
    '/courses/1/pages/%2e%2e/assignments/5',
    '/courses/1/pages/%2E%2e/assignments/5',
    '/courses/1/pages/.%2E/assignments/5',
    '/courses/1/pages/%2e./assignments/5',
    '/courses/1/pages/%2e/x',
    '/courses/1/pages/./x',
    '/courses/1/assignments/2/submissions/self/%2e%2e/456',
    '/users/self/profile/%2e%2e/%2e%2e/42',
    '/%2e%2e/%2e%2e/login/oauth2/token',
    '/../../login/oauth2/token',
    '/courses/1/pages/x\\..\\..\\users',
    '/courses/1/pages/a b',
    '/courses/1/pages/a\tb',
    '/\\evil.example/courses',
    'courses/1',
    '@evil.example/courses',
    '.evil.example/courses',
    ':8443/courses',
    '',
  ])('refuses the forged path %j for every method and for pagination', async (path) => {
    const { fake, client, meter } = openCanvas();

    const results = [
      await client.request('get', forged(path)),
      await client.request('post', forged(path), { data: { a: 1 } }),
      await client.request('put', forged(path), { data: { a: 1 } }),
      await client.request('delete', forged(path)),
      await client.fetchAll(forged(path)),
    ];

    for (const result of results) {
      const failure = failureOf(result);
      expect(failure.outcome).toBe('not_dispatched');
      expect(failure.error).toMatch(/^Invalid endpoint/);
    }
    expect(fake.calls).toHaveLength(0);
    expect(meter.used).toBe(0);
  });

  it.each([null, undefined, 42, {}, ['/courses']])('refuses the non-string path %j', async (path) => {
    const { fake, client } = openCanvas();
    expect(failureOf(await client.request('get', path as unknown as CanvasPath)).outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
  });

  it('whatever is dispatched goes to exactly the API base plus the given path', async () => {
    const { fake, client } = openCanvas();
    // Percent-encoded separators are not dot segments: the URL parser keeps them.
    // Nor is a doubled slash a new authority once it sits behind the base path.
    const paths = [
      '/courses/1/pages/x%2f..%2fassignments',
      '/courses/1/pages/x%5c..%5cy',
      '/courses/1/pages/%252e%252e',
      '//evil.example/api/v1/courses',
    ];

    for (const path of paths) await client.request('get', forged(path));

    expect(fake.calls.map((call) => call.url)).toEqual(paths.map((path) => `${API}${path}`));
    expect(fake.calls.every((call) => new URL(call.url).origin === ORIGIN)).toBe(true);
  });
});

describe('the anonymization tier follows the URL actually requested', () => {
  const person = { id: 42, name: 'Victim Realname', sortable_name: 'Realname, Victim', login_id: 'victim@school.edu' };

  function serving(payload: unknown) {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.route('GET', /.*/, () => json(payload));
    return { fake, ...createTestClient(fake) };
  }

  it('a template that looks self-only cannot fetch another user unanonymized', async () => {
    const { fake, client } = serving(person);

    // "/users/self/profile" is exempt from anonymization by exact path only.
    const viaValue = await client.request('get', canvasPath`/users/${'self/profile'}`);
    const viaEncoded = await client.request('get', canvasPath`/users/${'self%2Fprofile'}`);
    const viaTraversal = await client.request('get', forged('/users/self/profile/%2e%2e/%2e%2e/42'));

    expect(JSON.stringify(viaValue)).not.toContain('Realname');
    expect(JSON.stringify(viaEncoded)).not.toContain('Realname');
    expect(failureOf(viaTraversal).outcome).toBe('not_dispatched');
    expect(fake.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v1/users/self%2Fprofile',
      '/api/v1/users/self%252Fprofile',
    ]);
  });

  it('the real self-profile path is still exempt', async () => {
    const { client } = serving(person);
    expect(await client.request('get', canvasPath`/users/self/profile`)).toEqual(person);
    expect(await client.request('get', canvasPath`/users/${'self'}/profile`)).toEqual(person);
  });

  it('a submissions/self template cannot be bent into another submission with a lower tier', async () => {
    const submission = { id: 9, user_id: 42, body: 'private essay text', user: person };
    const { fake, client } = serving(submission);

    // The caller's own submission keeps its body (upstream issue 166) ...
    const own = await client.request('get', canvasPath`/courses/${1}/assignments/${2}/submissions/self`);
    // ... but no identifier value can turn that route into someone else's.
    const smuggled = await client.request(
      'get',
      canvasPath`/courses/${1}/assignments/${'2/submissions/456/%2e%2e/..'}/submissions/self`,
    );
    const direct = await client.request('get', canvasPath`/courses/${1}/assignments/${2}/submissions/${456}`);

    expect((own as { body: string }).body).toBe('private essay text');
    // The smuggled value stays inside one segment, so Canvas is asked for an
    // assignment with a strange id and nothing else ...
    expect(new URL(fake.calls[1]!.url).pathname).toBe(
      '/api/v1/courses/1/assignments/2%2Fsubmissions%2F456%2F%252e%252e%2F../submissions/self',
    );
    // ... and because the value names a submissions route once decoded, the
    // response gets the full tier rather than the self exemption.
    expect(JSON.stringify(smuggled)).not.toContain('private essay text');
    expect(JSON.stringify(smuggled)).not.toContain('Realname');
    // The route that really addresses another student's submission is fully anonymized.
    expect(JSON.stringify(direct)).not.toContain('private essay text');
    expect(JSON.stringify(direct)).not.toContain('Realname');
  });

  it('a page slug named after a sensitive route does not lower or skip the page tier', async () => {
    const pageRecord = {
      title: 'Roster',
      body: 'Office hours: prof@school.edu',
      last_edited_by: { id: 42, display_name: 'Victim Realname', avatar_image_url: 'https://cdn/x.png' },
    };
    const { client } = serving(pageRecord);

    for (const slug of ['users', 'x/%2e%2e/%2e%2e/assignments/2/submissions/self/%2e%2e/456', 'front_page']) {
      const result = await client.request('get', canvasPath`/courses/${1}/pages/${slug}`);
      expect(JSON.stringify(result)).not.toContain('Victim Realname');
    }
  });

  it('an encoded route keyword in a hand-built path still gets the strict tier', async () => {
    const { client } = serving([person]);
    const result = await client.request('get', forged('/courses/1/%75sers'));
    expect(JSON.stringify(result)).not.toContain('Realname');
  });
});

describe('no request leaves the pinned origin', () => {
  it.each(HOSTILE_IDENTIFIERS)('for identifier %j, every method, pagination and course resolution', async (id) => {
    const { fake, client, meter } = openCanvas();
    fake.route('GET', '/api/v1/courses', () => json([{ id: 1, course_code: 'CS 101' }]));

      await client.request('get', canvasPath`/courses/${id}/pages/${id}`);
      await client.request('post', canvasPath`/courses/${id}/pages`, { data: { id } });
      await client.request('put', canvasPath`/courses/${id}`, { useFormData: true, data: { id } });
      await client.request('delete', canvasPath`/courses/${1}/pages/${id}`);
      await client.fetchAll(canvasPath`/courses/${id}/users`, { search_term: id });
      await client.courses.resolveCode(id);
      const resolved = await client.courses.resolveId(id);
      if (typeof resolved === 'string') await client.request('get', canvasPath`/courses/${resolved}`);
      await client.downloadFile(id, { maxBytes: 10 });
    expect(fake.calls.length).toBeGreaterThanOrEqual(6);
    expect(meter.remaining).toBeGreaterThan(0);
    for (const call of fake.calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname.startsWith('/api/v1/')).toBe(true);
      expect(url.username).toBe('');
      expect(call.redirect).toBe('manual');
    }
    expect(fake.calls.every((call) => call.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it('refuses every request when the API base itself is unusable', async () => {
    const badBases = [
      '',
      'not a url',
      'ftp://canvas.example.com/api/v1',
      'https://u:p@canvas.example.com/api/v1',
      // Cleartext: the token must never be sent over http, whatever configuration let through.
      'http://canvas.example.com/api/v1',
    ];
    for (const apiBaseUrl of badBases) {
      const fake = createFakeCanvas({ origin: ORIGIN });
      const { config, meter } = createTestClient(fake);
      const { createCanvasClient } = await import('../../src/canvas/client');
      const { createLogger } = await import('../../src/core/logging');
      const client = createCanvasClient({
        credential: { apiBaseUrl, origin: ORIGIN, token: FAKE_TOKEN, callerId: 'c', kind: 'owner-secret' },
        config,
        meter,
        deadline: Date.now() + 10_000,
        log: createLogger({ level: 'error', redactPii: true, sink: () => {} }),
        allowRaw: false,
        pseudonymSalt: null,
        fetchImpl: fake.fetch,
      });

      expect(failureOf(await client.request('get', canvasPath`/courses`)).outcome).toBe('not_dispatched');
      expect(failureOf(await client.fetchAll(canvasPath`/courses`)).outcome).toBe('not_dispatched');
      expect(failureOf(await client.downloadFile(`${ORIGIN}/files/1/download`, { maxBytes: 1 })).outcome).toBe(
        'not_dispatched',
      );
      expect(fake.calls).toHaveLength(0);
    }
  });
});
