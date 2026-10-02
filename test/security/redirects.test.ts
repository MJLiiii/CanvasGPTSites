// Ports tests/code_api/pagination-redirect.test.ts and
// test_pagination_cannot_redirect_credentials_or_change_endpoint from
// tests/core/test_client_state_machine.py, and adds the download rules of security review
// finding 13: Authorization is sent to the Canvas origin and nowhere else.
import { describe, expect, it } from 'vitest';
import { isFailure } from '../../src/canvas/errors';
import { canvasPath } from '../../src/canvas/path';
import type { RequestFailure } from '../../src/types';
import { FAKE_TOKEN, createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';
import type { FakeCanvas } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.edu';
const API = `${ORIGIN}/api/v1`;
const EVIL = 'https://evil.example';

function setup(options: Parameters<typeof createTestClient>[1] = {}) {
  const fake = createFakeCanvas({ origin: ORIGIN });
  return { fake, ...createTestClient(fake, options) };
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
  return value;
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** Calls that carried credentials anywhere but the Canvas origin. Must always be empty. */
function leaks(fake: FakeCanvas): string[] {
  return fake.calls
    .filter((call) => {
      const sentSecret = Object.values(call.headers).some((value) => value.includes(FAKE_TOKEN));
      const inUrl = call.url.includes(FAKE_TOKEN);
      const inBody = typeof call.body === 'string' && call.body.includes(FAKE_TOKEN);
      return new URL(call.url).origin !== ORIGIN && (sentSecret || inUrl || inBody);
    })
    .map((call) => call.url);
}

function offOrigin(fake: FakeCanvas): string[] {
  return fake.calls.map((call) => call.url).filter((url) => new URL(url).origin !== ORIGIN);
}

describe('API redirects are never followed', () => {
  const targets = [
    `${EVIL}/api/v1/courses`,
    `${EVIL}/collect?from=canvas`,
    '//evil.example/api/v1/courses',
    `${API}/users/self/profile`,
    '/login/canvas',
    'http://canvas.example.edu/api/v1/courses',
  ];
  const statuses = [301, 302, 303, 307, 308];

  for (const location of targets) {
    for (const status of statuses) {
      it(`GET answered ${status} to ${location} fails without a second request`, async () => {
        const { fake, client } = setup();
        fake.route('GET', /.*/, (request) =>
          request.parsed.pathname === '/api/v1/courses' ? redirect(location, status) : json({ reached: true }),
        );
        fake.route('GET', `${EVIL}/api/v1/courses`, () => json({ reached: true }));

        const failure = failureOf(await client.request('get', canvasPath`/courses`));

        expect(failure.error).toBe(`HTTP error: ${status}, Text: `);
        expect(failure.status).toBe(status);
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]!.redirect).toBe('manual');
        expect(offOrigin(fake)).toEqual([]);
      });
    }
  }

  // A 307/308 would replay the body, credentials included, at the new location.
  it.each([
    ['post', 'POST', 307],
    ['put', 'PUT', 308],
    ['delete', 'DELETE', 307],
    ['post', 'POST', 302],
  ] as const)('%s answered with a redirect is not replayed anywhere', async (verb, method, status) => {
    const { fake, client, sleeps } = setup();
    fake.route(method, '/api/v1/courses/1/pages/a', () => redirect(`${EVIL}/courses/1/pages/a`, status));
    fake.route(method, `${EVIL}/courses/1/pages/a`, () => json({ reached: true }));

    const failure = failureOf(
      await client.request(
        verb,
        canvasPath`/courses/${1}/pages/${'a'}`,
        verb === 'delete' ? {} : { useFormData: true, data: { 'wiki_page[body]': 'secret draft' } },
      ),
    );

    expect(failure.error).toBe(`HTTP error: ${status}, Text: `);
    expect(failure.outcome).toBe('may_have_written');
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(offOrigin(fake)).toEqual([]);
  });

  // Port of "HTTP redirect cannot bypass pagination endpoint validation".
  it('a redirect cannot stand in for a page of results', async () => {
    const { fake, client } = setup();
    let redirected = 0;
    fake.route('GET', '/api/v1/courses', () => redirect('/other'));
    fake.route('GET', '/other', () => {
      redirected++;
      return json([1]);
    });

    const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

    expect(failure.error).toBe('HTTP error: 302, Text: ');
    expect(redirected).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it('a redirect on a later page returns no partial result and is not followed', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1
        ? json([1], { headers: { Link: `<${API}/courses?page=2>; rel="next"` } })
        : redirect(`${EVIL}/api/v1/courses?page=2`),
    );

    const result = await client.fetchAll(canvasPath`/courses`);

    expect(failureOf(result).error).toBe('HTTP error: 302, Text: ');
    expect('items' in result).toBe(false);
    expect(offOrigin(fake)).toEqual([]);
  });

  it('the course resolver does not follow redirects either', async () => {
    const { fake, client } = setup();
    fake.route('GET', /^\/api\/v1\/courses/, () => redirect(`${EVIL}/api/v1/courses`));

    expect(isFailure(await client.courses.resolveId('CS 101'))).toBe(true);
    expect(await client.courses.resolveCode(5)).toBe('5');

    expect(offOrigin(fake)).toEqual([]);
  });
});

describe('hostile next links', () => {
  // Port of test_pagination_cannot_redirect_credentials_or_change_endpoint, with more shapes.
  it.each([
    `${EVIL}/api/v1/courses?page=2`,
    `${API}/users?page=2`,
    `${API}/courses/1/users?page=2`,
    `${API}/courses/../users?page=2`,
    `${API}/courses/%2e%2e/users?page=2`,
    `https://canvas.example.edu.evil.example/api/v1/courses?page=2`,
    `https://canvas.example.edu@evil.example/api/v1/courses?page=2`,
    `https://token:${FAKE_TOKEN}@canvas.example.edu/api/v1/courses?page=2`,
    'http://canvas.example.edu/api/v1/courses?page=2',
    'https://canvas.example.edu:444/api/v1/courses?page=2',
    '//evil.example/api/v1/courses?page=2',
    '/api/v1/users?page=2',
    '../users?page=2',
    `${API}/courses?page=2#@evil.example`,
    'javascript:alert(1)',
    'data:application/json,[]',
  ])('the next link %s is refused before another dispatch', async (target) => {
    const { fake, client } = setup();
    fake.route('GET', /.*/, () => json([{ id: 1 }], { headers: { Link: `<${target}>; rel="next"` } }));
    fake.route('GET', `${EVIL}/api/v1/courses`, () => json([{ id: 666 }]));

    const result = await client.fetchAll(canvasPath`/courses`);

    expect(failureOf(result).error).toMatch(/^Invalid pagination link/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(`${API}/courses?per_page=100&page=1`);
    expect(offOrigin(fake)).toEqual([]);
  });

  it('a hostile link on a later page is refused too', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => {
      const next = fake.calls.length < 3 ? `${API}/courses?cursor=${fake.calls.length}` : `${EVIL}/api/v1/courses`;
      return json([{ id: fake.calls.length }], { headers: { Link: `<${next}>; rel="next"` } });
    });

    const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

    expect(failure.error).toBe('Invalid pagination link: origin or endpoint changed');
    expect(fake.calls).toHaveLength(3);
    expect(offOrigin(fake)).toEqual([]);
  });

  it('a same-endpoint next link keeps Authorization and is fetched from the pinned origin', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1
        ? json([{ id: 1 }], { headers: { Link: `<${API}/courses?page=bookmark:abc>; rel="next"` } })
        : json([{ id: 2 }]),
    );

    await client.fetchAll(canvasPath`/courses`);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(fake.calls.every((call) => call.redirect === 'manual')).toBe(true);
  });
});

describe('download redirects', () => {
  const FILE_URL = `${ORIGIN}/files/7/download?verifier=v1`;

  it('drops Authorization on the first cross-origin hop', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/7/download', () => redirect(`${EVIL}/grab?x=1`));
    fake.route('GET', `${EVIL}/grab`, (request) => new Response(JSON.stringify(request.headers), { status: 200 }));

    const result = await client.downloadFile(FILE_URL, { maxBytes: 10_000 });

    if (isFailure(result)) throw new Error(result.error);
    // What the other origin saw of the request.
    const seen = JSON.parse(new TextDecoder().decode(result.bytes)) as Record<string, string>;
    expect(seen.authorization).toBeUndefined();
    expect(Object.keys(seen).sort()).toEqual(['accept', 'user-agent']);
    expect(leaks(fake)).toEqual([]);
  });

  it('does not give Authorization back when an outside hop redirects to Canvas', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/7/download', () => redirect(`${EVIL}/bounce`));
    fake.route('GET', `${EVIL}/bounce`, () => redirect(`${API}/users/self/profile`, 307));
    fake.route('GET', '/api/v1/users/self/profile', () => json({ id: 1, primary_email: 'owner@school.edu' }));

    await client.downloadFile(FILE_URL, { maxBytes: 10_000 });

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(fake.calls[1]!.headers.authorization).toBeUndefined();
    // Back on the Canvas origin, at a URL the outside host chose: no credentials.
    expect(new URL(fake.calls[2]!.url).origin).toBe(ORIGIN);
    expect(fake.calls[2]!.headers.authorization).toBeUndefined();
    expect(leaks(fake)).toEqual([]);
  });

  it.each([
    `http://evil.example/grab`,
    'http://canvas.example.edu/files/7/download',
    `https://user:${FAKE_TOKEN}@evil.example/grab`,
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('refuses the redirect target %s', async (location) => {
    const { fake, client } = setup();
    fake.route('GET', '/files/7/download', () => redirect(location));

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 10_000 }));

    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(1);
    expect(offOrigin(fake)).toEqual([]);
  });

  it.each([
    `${EVIL}/files/7/download`,
    'https://canvas.example.edu.evil.example/files/7/download',
    `https://canvas.example.edu@evil.example/files/7/download`,
    'http://canvas.example.edu/files/7/download',
    '//evil.example/files/7/download',
  ])('never starts a download at %s', async (url) => {
    const { fake, client } = setup();
    fake.route('GET', /.*/, () => new Response('x'));

    failureOf(await client.downloadFile(url, { maxBytes: 10_000 }));

    expect(fake.calls).toEqual([]);
  });

  it('uses manual redirects on every hop, so the runtime never forwards headers by itself', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/7/download', () => redirect(`${ORIGIN}/files/7/again`));
    fake.route('GET', '/files/7/again', () => redirect(`${EVIL}/final`));
    fake.route('GET', `${EVIL}/final`, () => new Response('bytes'));

    await client.downloadFile(FILE_URL, { maxBytes: 10_000 });

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((call) => call.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(fake.calls.map((call) => call.headers.authorization !== undefined)).toEqual([true, true, false]);
  });
});

describe('across a whole hostile session', () => {
  it('credentials are only ever sent to the Canvas origin', async () => {
    const { fake, client } = setup({ budget: 200 });
    // Canvas (or something answering for it) tries every trick at once.
    fake.route('GET', /^\/api\/v1\/a/, () => redirect(`${EVIL}/a?t=steal`));
    fake.route('POST', /^\/api\/v1\/a/, () => redirect(`${EVIL}/a`, 307));
    fake.route('GET', /^\/api\/v1\/b/, () => json([1], { headers: { Link: `<${EVIL}/api/v1/b>; rel="next"` } }));
    fake.route('GET', /^\/api\/v1\/c/, () =>
      json([1], { headers: { Link: `<https://x:y@canvas.example.edu/api/v1/c?page=2>; rel="next"` } }),
    );
    fake.route('GET', '/files/1/download', () => redirect(`${EVIL}/f1`));
    fake.route('GET', `${EVIL}/f1`, () => redirect(`${ORIGIN}/files/2/download`));
    fake.route('GET', '/files/2/download', () => redirect(`${EVIL}/f2`));
    fake.route('GET', `${EVIL}/f2`, () => new Response('bytes'));

    await client.request('get', canvasPath`/a`);
    await client.request('post', canvasPath`/a`, { data: { note: 'private' } });
    await client.fetchAll(canvasPath`/b`);
    await client.fetchAll(canvasPath`/c`);
    await client.downloadFile(`${ORIGIN}/files/1/download`, { maxBytes: 100 });
    await client.downloadFile(`${EVIL}/files/1/download`, { maxBytes: 100 });

    expect(leaks(fake)).toEqual([]);
    const withAuth = fake.calls.filter((call) => call.headers.authorization !== undefined);
    expect(withAuth.length).toBeGreaterThan(0);
    expect(withAuth.every((call) => new URL(call.url).origin === ORIGIN)).toBe(true);
    // The only requests off the Canvas origin are download hops, without credentials.
    expect(offOrigin(fake)).toEqual([`${EVIL}/f1`, `${EVIL}/f2`]);
    expect(fake.calls.every((call) => call.redirect === 'manual')).toBe(true);
  });
});
