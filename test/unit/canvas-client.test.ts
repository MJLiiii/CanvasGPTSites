// Ports the single-request cases of tests/core/test_client_state_machine.py and
// tests/core/test_client.py (auth headers), plus the request, retry, budget and
// anonymization rules of architecture section 5.
import { describe, expect, it } from 'vitest';
import { isFailure } from '../../src/canvas/errors';
import { canvasPath } from '../../src/canvas/path';
import type { RequestFailure } from '../../src/types';
import { FAKE_TOKEN, createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.edu';
const API = `${ORIGIN}/api/v1`;

function setup(options: Parameters<typeof createTestClient>[1] = {}) {
  const fake = createFakeCanvas({ origin: ORIGIN });
  return { fake, ...createTestClient(fake, options) };
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
  return value;
}

describe('request shape', () => {
  it('sends Bearer auth, Accept and the port User-Agent to the pinned URL', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/7', () => json({ id: 7, name: 'Course' }));

    const result = await client.request('get', canvasPath`/courses/${7}`);

    expect(result).toEqual({ id: 7, name: 'Course' });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${API}/courses/7`);
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(call.headers.accept).toBe('application/json');
    expect(call.headers['user-agent']).toMatch(/^canvas-gpt-sites\/\S+ \(TypeScript port of canvas-mcp/);
    expect(call.redirect).toBe('manual');
    expect(call.body).toBeNull();
  });

  it('puts GET params in the query: lists repeat, booleans are words, null is empty', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => json([]));

    await client.request('get', canvasPath`/courses`, {
      params: { 'include[]': ['term', 'teachers'], published: true, search: null, skipped: undefined, per_page: 50 },
    });

    expect(fake.calls[0]!.url).toBe(
      `${API}/courses?include%5B%5D=term&include%5B%5D=teachers&published=true&search=&per_page=50`,
    );
  });

  it('puts DELETE params in the query and sends no body', async () => {
    const { fake, client } = setup();
    fake.route('DELETE', '/api/v1/courses/1/pages/intro', () => json({ deleted: true }));

    await client.request('delete', canvasPath`/courses/${1}/pages/${'intro'}`, { params: { event: 'delete' } });

    const call = fake.calls[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe(`${API}/courses/1/pages/intro?event=delete`);
    expect(call.body).toBeNull();
  });

  it('sends a JSON body by default', async () => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses/1/x', () => json({ ok: true }));

    await client.request('post', canvasPath`/courses/${1}/x`, { data: { user_id: 5, nested: { a: [1, 2] } } });

    const call = fake.calls[0]!;
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toBe('{"user_id":5,"nested":{"a":[1,2]}}');
    expect(call.url).toBe(`${API}/courses/1/x`);
  });

  it('sends urlencoded form data with repeated keys when useFormData is set', async () => {
    const { fake, client } = setup();
    fake.route('PUT', '/api/v1/courses/1/x', () => json({ ok: true }));

    await client.request('put', canvasPath`/courses/${1}/x`, {
      useFormData: true,
      data: { 'wiki_page[title]': 'A & B', 'ids[]': [1, 2], 'wiki_page[published]': false },
    });

    const call = fake.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.body).toBe('wiki_page%5Btitle%5D=A+%26+B&ids%5B%5D=1&ids%5B%5D=2&wiki_page%5Bpublished%5D=false');
  });

  it('keeps the order and duplicate keys of a tuple list', async () => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses/1/modules', () => json({ id: 3 }));

    await client.request('post', canvasPath`/courses/${1}/modules`, {
      useFormData: true,
      data: [
        ['module[name]', 'Week 1'],
        ['module[prerequisite_module_ids][]', 10],
        ['module[prerequisite_module_ids][]', 11],
      ],
    });

    expect(fake.calls[0]!.body).toBe(
      'module%5Bname%5D=Week+1' +
        '&module%5Bprerequisite_module_ids%5D%5B%5D=10' +
        '&module%5Bprerequisite_module_ids%5D%5B%5D=11',
    );
  });

  it('passes a multipart body through and lets fetch write its Content-Type', async () => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses/1/rubrics/upload', () => json({ id: 9 }));
    const form = new FormData();
    form.set('attachment', new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'rubric.csv');

    await client.request('post', canvasPath`/courses/${1}/rubrics/upload`, { multipart: form });

    const call = fake.calls[0]!;
    expect(call.body).toBe(form);
    expect(call.headers['content-type']).toBeUndefined();
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('sends no body and no Content-Type when a write has no data', async () => {
    const { fake, client } = setup();
    fake.route('PUT', '/api/v1/courses/1/modules/2/items/3/done', () => json({}));

    await client.request('put', canvasPath`/courses/${1}/modules/${2}/items/${3}/done`);
    await client.request('put', canvasPath`/courses/${1}/modules/${2}/items/${3}/done`, { useFormData: true });

    for (const call of fake.calls) {
      expect(call.body).toBeNull();
      expect(call.headers['content-type']).toBeUndefined();
    }
  });

  it('refuses a request it would have to send differently from what the caller wrote', async () => {
    const { fake, client } = setup();

    const queryOnWrite = failureOf(
      await client.request('post', canvasPath`/courses`, { params: { a: 1 }, data: { b: 2 } }),
    );
    const bodyOnRead = failureOf(await client.request('get', canvasPath`/courses`, { data: { b: 2 } }));
    const bodyOnDelete = failureOf(await client.request('delete', canvasPath`/courses/${1}`, { data: { b: 2 } }));
    const badMethod = failureOf(await client.request('patch' as 'get', canvasPath`/courses`));

    for (const failure of [queryOnWrite, bodyOnRead, bodyOnDelete, badMethod]) {
      expect(failure.outcome).toBe('not_dispatched');
    }
    expect(badMethod.error).toBe('Unsupported method: patch');
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts an upper-case method name', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => json([]));
    expect(await client.request('GET' as 'get', canvasPath`/courses`)).toEqual([]);
  });
});

describe('error mapping', () => {
  it('reports a JSON error body with upstream wording and marks 404 as rejected', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/9', () =>
      json({ errors: [{ message: 'The specified resource does not exist.' }] }, { status: 404 }),
    );

    const failure = failureOf(await client.request('get', canvasPath`/courses/${9}`));

    expect(failure.error).toBe(
      "HTTP error: 404, Details: {'errors': [{'message': 'The specified resource does not exist.'}]}",
    );
    expect(failure.outcome).toBe('rejected');
    expect(failure.status).toBe(404);
    expect(failure.throttled).toBeUndefined();
  });

  it.each([400, 401, 403, 404, 422])('classifies %i as rejected', async (status) => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses', () => json({ message: 'no' }, { status }));
    expect(failureOf(await client.request('post', canvasPath`/courses`, { data: {} })).outcome).toBe('rejected');
  });

  it.each([409, 429, 500, 502, 503])('classifies %i on a write as may_have_written', async (status) => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses', () => new Response('boom', { status }));
    const failure = failureOf(await client.request('post', canvasPath`/courses`, { data: {} }));
    expect(failure.error).toBe(`HTTP error: ${status}, Text: boom`);
    expect(failure.outcome).toBe('may_have_written');
  });

  it('treats a 3xx as the failure "HTTP error: 302" and does not follow it', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => new Response(null, { status: 302, headers: { Location: '/login' } }));
    fake.route('GET', '/login', () => json({ leaked: true }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toBe('HTTP error: 302, Text: ');
    expect(failure.status).toBe(302);
    expect(failure.outcome).toBe('may_have_written');
    expect(fake.calls).toHaveLength(1);
  });

  it('keeps a non-JSON 2xx an error with may_have_written, as upstream', async () => {
    const { fake, client } = setup();
    fake.route('PUT', '/api/v1/courses/1/done', () => new Response(null, { status: 204 }));
    fake.route('POST', '/api/v1/courses/1/html', () => new Response('\n  <html>secret page</html>', { status: 200 }));
    fake.route('POST', '/api/v1/courses/1/cut', () => new Response('{"id": 1, "name": "cut off', { status: 200 }));

    const empty = failureOf(await client.request('put', canvasPath`/courses/${1}/done`));
    const html = failureOf(await client.request('post', canvasPath`/courses/${1}/html`));
    const cut = failureOf(await client.request('post', canvasPath`/courses/${1}/cut`));

    expect(empty.error).toBe('Request failed: Expecting value: line 1 column 1 (char 0)');
    expect(empty.outcome).toBe('may_have_written');
    expect(empty.status).toBe(204);
    expect(html.error).toBe('Request failed: Expecting value: line 2 column 3 (char 3)');
    expect(cut.error).toBe('Request failed: response body is not valid JSON');
    expect(html.error).not.toContain('secret');
    expect(cut.error).not.toContain('cut off');
  });

  it('treats a 2xx body with a top-level "error" key as a failure, as upstream tools do', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/a', () => json({ error: 'quota exceeded' }));
    fake.route('GET', '/api/v1/courses/1/b', () => json({ error: { code: 3 } }));

    const text = failureOf(await client.request('get', canvasPath`/courses/${1}/a`));
    const object = failureOf(await client.request('get', canvasPath`/courses/${1}/b`));

    expect(text.error).toBe('quota exceeded');
    expect(text.outcome).toBe('may_have_written');
    expect(object.error).toBe("{'code': 3}");
  });

  it('reports a network error by class and a sanitized message', async () => {
    const { fake, client } = setup();
    fake.route('POST', '/api/v1/courses', () => {
      throw new TypeError(`connect failed for ${API}/courses?access_token=${FAKE_TOKEN}&verifier=abc123 (reset)`);
    });

    const failure = failureOf(await client.request('post', canvasPath`/courses`, { data: {} }));

    expect(failure.error).toBe(`Request failed: TypeError: connect failed for ${API}/courses (reset)`);
    expect(failure.outcome).toBe('may_have_written');
    expect(failure.error).not.toContain('verifier');
  });

  it('caps a long error body', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => new Response('x'.repeat(100_000), { status: 500 }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error.length).toBeLessThan(17_000);
    expect(failure.error.endsWith('... [truncated]')).toBe(true);
  });

  it('times a request out and does not repeat a write', async () => {
    const { fake, client } = setup({ realTime: true, config: { apiTimeoutMs: 25 } });
    fake.route('POST', '/api/v1/courses', () => new Promise<Response>(() => {}));

    const failure = failureOf(await client.request('post', canvasPath`/courses`, { data: {} }));

    expect(failure.error).toBe('Request failed: the request timed out');
    expect(failure.outcome).toBe('may_have_written');
    expect(fake.calls).toHaveLength(1);
  });

  it('caps the timeout at the time left to the deadline', async () => {
    const { fake, client } = setup({ realTime: true, deadlineIn: 30, config: { apiTimeoutMs: 60_000 } });
    fake.route('GET', '/api/v1/courses', () => new Promise<Response>(() => {}));

    const started = Date.now();
    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toBe('Request failed: the request timed out');
    expect(Date.now() - started).toBeLessThan(5_000);
    // No retry: the deadline has passed.
    expect(fake.calls).toHaveLength(1);
  });

  it('sends nothing once the deadline has passed', async () => {
    const { fake, client, clock } = setup({ deadlineIn: 1_000 });
    clock.now += 1_000;

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.outcome).toBe('not_dispatched');
    expect(failure.error).toContain('deadline');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('retries', () => {
  // Counterpart of upstream test_429_terminates_after_four_attempts_and_three_backoffs:
  // this port allows two retries with 1 s and 2 s waits (plus jitter).
  it('retries a throttled GET twice, then gives up', async () => {
    const { fake, client, sleeps } = setup();
    fake.route('GET', '/api/v1/courses', () => json({ error: 'slow down' }, { status: 429 }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toContain('429');
    expect(failure.throttled).toBe(true);
    expect(failure.outcome).toBe('may_have_written');
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(sleeps[0]).toBeLessThan(1_250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(2_000);
    expect(sleeps[1]).toBeLessThan(2_250);
  });

  it('waits for an integer Retry-After', async () => {
    const { fake, client, sleeps } = setup();
    let served = 0;
    fake.route('GET', '/api/v1/courses', () =>
      ++served === 1 ? json({}, { status: 429, headers: { 'Retry-After': '3' } }) : json([{ id: 1 }]),
    );

    expect(await client.request('get', canvasPath`/courses`)).toEqual([{ id: 1 }]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3_000);
    expect(sleeps[0]).toBeLessThan(3_250);
  });

  it('treats 403 "Rate Limit Exceeded" as a throttle', async () => {
    const { fake, client, sleeps } = setup();
    let served = 0;
    fake.route('GET', '/api/v1/courses', () =>
      ++served <= 2 ? new Response('403 Forbidden (Rate Limit Exceeded)', { status: 403 }) : json([{ id: 1 }]),
    );

    expect(await client.request('get', canvasPath`/courses`)).toEqual([{ id: 1 }]);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('reports a persistent 403 throttle as throttled and rejected', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => new Response('403 Forbidden (Rate Limit Exceeded)', { status: 403 }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toBe('HTTP error: 403, Text: 403 Forbidden (Rate Limit Exceeded)');
    expect(failure.throttled).toBe(true);
    expect(failure.outcome).toBe('rejected');
    expect(fake.calls).toHaveLength(3);
  });

  it('treats 403 with an exhausted X-Rate-Limit-Remaining as a throttle', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      json({ status: 'forbidden' }, { status: 403, headers: { 'X-Rate-Limit-Remaining': '0.0' } }),
    );

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.throttled).toBe(true);
    expect(fake.calls).toHaveLength(3);
  });

  it('does not retry an ordinary 403', async () => {
    const { fake, client, sleeps } = setup();
    fake.route('GET', '/api/v1/courses', () => json({ status: 'unauthorized' }, { status: 403 }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.throttled).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('never waits past two seconds before the deadline', async () => {
    const { fake, client, sleeps } = setup({ deadlineIn: 2_900 });
    fake.route('GET', '/api/v1/courses', () => json({}, { status: 429 }));

    failureOf(await client.request('get', canvasPath`/courses`));

    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('skips a Retry-After that would pass the deadline', async () => {
    const { fake, client, sleeps } = setup({ deadlineIn: 10_000 });
    fake.route('GET', '/api/v1/courses', () => json({}, { status: 429, headers: { 'Retry-After': '30' } }));

    failureOf(await client.request('get', canvasPath`/courses`));

    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([502, 503, 504])('retries a GET once after 500 ms on %i', async (status) => {
    const { fake, client, sleeps } = setup();
    fake.route('GET', '/api/v1/courses', () => new Response('busy', { status }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toBe(`HTTP error: ${status}, Text: busy`);
    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it('does not retry a GET on 500', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => new Response('boom', { status: 500 }));
    failureOf(await client.request('get', canvasPath`/courses`));
    expect(fake.calls).toHaveLength(1);
  });

  it('retries a GET once after a network error and returns the second answer', async () => {
    const { fake, client, sleeps } = setup();
    let served = 0;
    fake.route('GET', '/api/v1/courses', () => {
      if (++served === 1) throw new TypeError('fetch failed');
      return json([{ id: 1 }]);
    });

    expect(await client.request('get', canvasPath`/courses`)).toEqual([{ id: 1 }]);
    expect(sleeps).toEqual([500]);
  });

  const writes = [
    ['post', 'POST'],
    ['put', 'PUT'],
    ['delete', 'DELETE'],
  ] as const;
  const failures: Array<[string, () => Response]> = [
    ['429', () => json({}, { status: 429, headers: { 'Retry-After': '1' } })],
    ['403 rate limit', () => new Response('Rate Limit Exceeded', { status: 403 })],
    ['502', () => new Response('bad gateway', { status: 502 })],
    ['503', () => new Response('busy', { status: 503 })],
    ['504', () => new Response('timeout', { status: 504 })],
    [
      'a network error',
      () => {
        throw new TypeError('socket hang up');
      },
    ],
  ];
  for (const [verb, method] of writes) {
    for (const [what, respond] of failures) {
      it(`never retries ${method} after ${what}`, async () => {
        const { fake, client, sleeps } = setup();
        fake.route(method, '/api/v1/courses/1/things', respond);

        const failure = failureOf(await client.request(verb, canvasPath`/courses/${1}/things`));

        expect(fake.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
        expect(failure.outcome).toBe(what === '403 rate limit' ? 'rejected' : 'may_have_written');
      });
    }
  }

  it('counts every retry against the budget and stops retrying when it is empty', async () => {
    const { fake, client, meter } = setup({ budget: 2 });
    fake.route('GET', '/api/v1/courses', () => json({}, { status: 429 }));

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.error).toContain('429');
    expect(fake.calls).toHaveLength(2);
    expect(meter.used).toBe(2);
    expect(meter.counts.canvas).toBe(2);
  });
});

describe('budget', () => {
  it('blocks a request when no capacity is left, naming the budget', async () => {
    const { fake, client } = setup({ budget: 0 });

    const failure = failureOf(await client.request('get', canvasPath`/courses`));

    expect(failure.outcome).toBe('not_dispatched');
    expect(failure.budgetExhausted).toBe(true);
    expect(failure.error).toMatch(/budget/i);
    expect(fake.calls).toHaveLength(0);
  });

  it('takes one slot per request and refuses the request after the last one', async () => {
    const { fake, client, meter } = setup({ budget: 2 });
    fake.route('GET', '/api/v1/courses', () => json([]));

    expect(await client.request('get', canvasPath`/courses`)).toEqual([]);
    expect(await client.request('get', canvasPath`/courses`)).toEqual([]);
    const third = failureOf(await client.request('get', canvasPath`/courses`));

    expect(third.budgetExhausted).toBe(true);
    expect(third.error).toContain('at most 2');
    expect(meter.used).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps reserved slots for the write and its read-back', async () => {
    const { fake, client } = setup({ budget: 3 });
    fake.route('GET', '/api/v1/courses/1/pages/a', () => json({ title: 'A' }));
    fake.route('PUT', '/api/v1/courses/1/pages/a', () => json({ title: 'B' }));
    const path = canvasPath`/courses/${1}/pages/${'a'}`;

    expect(client.budget.reserve(2)).toBe(true);
    expect(client.budget.remaining).toBe(1);
    expect(await client.request('get', path)).toEqual({ title: 'A' });
    // Free capacity is gone: an ordinary read cannot eat the reservation.
    expect(failureOf(await client.request('get', path)).budgetExhausted).toBe(true);
    expect(await client.request('put', path, { data: { title: 'B' } })).toEqual({ title: 'B' });
    expect(await client.request('get', path, { useReserved: true })).toEqual({ title: 'A' });
    expect(failureOf(await client.request('get', path, { useReserved: true })).budgetExhausted).toBe(true);

    expect(client.budget.used).toBe(3);
    expect(client.budget.limit).toBe(3);
    expect(fake.calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('lets a reserved read-back retry on its reservation, and only there', async () => {
    const { fake, client, sleeps } = setup({ budget: 2 });
    let served = 0;
    fake.route('GET', '/api/v1/courses/1/pages/a', () =>
      ++served % 2 === 1 ? new Response('busy', { status: 503 }) : json({ title: 'A' }),
    );
    const path = canvasPath`/courses/${1}/pages/${'a'}`;
    client.budget.reserve(2);

    expect(isFailure(await client.request('get', path))).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(await client.request('get', path, { useReserved: true })).toEqual({ title: 'A' });

    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    expect(client.budget.used).toBe(2);
  });

  it('exposes only the budget view, not the meter', () => {
    const { client } = setup();
    expect(Object.keys(client.budget).sort()).toEqual(['limit', 'remaining', 'reserve', 'used']);
    expect('take' in client.budget).toBe(false);
    expect('release' in client.budget).toBe(false);
  });
});

describe('concurrency', () => {
  // Port of test_concurrent_requests_obey_semaphore_cap.
  it('keeps concurrent requests under the configured cap', async () => {
    const { fake, client } = setup({ config: { maxConcurrentRequests: 2 }, budget: 100 });
    let active = 0;
    let peak = 0;
    fake.route('GET', '/api/v1/courses', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return json([]);
    });

    await Promise.all(Array.from({ length: 20 }, () => client.request('get', canvasPath`/courses`)));

    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(fake.calls).toHaveLength(20);
  });

  it('drops to one request at a time once X-Rate-Limit-Remaining falls below 150', async () => {
    const { fake, client, logLines } = setup({ config: { maxConcurrentRequests: 3 }, budget: 100 });
    let active = 0;
    let peak = 0;
    fake.route('GET', '/api/v1/courses', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return json([], { headers: { 'X-Rate-Limit-Remaining': '149.5' } });
    });

    await client.request('get', canvasPath`/courses`);
    peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => client.request('get', canvasPath`/courses`)));

    expect(peak).toBe(1);
    expect(logLines.filter((line) => line.includes('canvas_rate_limit_low'))).toHaveLength(1);
  });

  it('keeps full width while the remaining quota is healthy', async () => {
    const { fake, client } = setup({ config: { maxConcurrentRequests: 3 }, budget: 100 });
    let active = 0;
    let peak = 0;
    fake.route('GET', '/api/v1/courses', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return json([], { headers: { 'X-Rate-Limit-Remaining': '600' } });
    });

    await client.request('get', canvasPath`/courses`);
    await Promise.all(Array.from({ length: 6 }, () => client.request('get', canvasPath`/courses`)));

    expect(peak).toBe(3);
  });
});

describe('anonymization', () => {
  const roster = [
    { id: 501, name: 'Alice Realname', sortable_name: 'Realname, Alice', email: 'alice@school.edu' },
    { id: 502, name: 'Bob Realname', sortable_name: 'Realname, Bob', email: 'bob@school.edu' },
  ];

  it('pseudonymizes a roster by default and keeps ids', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/users', () => json(roster));

    const users = (await client.request('get', canvasPath`/courses/${1}/users`)) as Array<Record<string, unknown>>;

    expect(users.map((user) => user.id)).toEqual([501, 502]);
    for (const user of users) expect(user.name).toMatch(/^Student_[0-9a-f]{8}$/);
    expect(JSON.stringify(users)).not.toMatch(/Realname|school\.edu/);
  });

  it('returns the response untouched when anonymization is disabled in config', async () => {
    const { fake, client } = setup({ config: { anonymizationEnabled: false } });
    fake.route('GET', '/api/v1/courses/1/users', () => json(roster));
    expect(await client.request('get', canvasPath`/courses/${1}/users`)).toEqual(roster);
  });

  it('leaves the caller-only profile endpoint alone', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/users/self/profile', () => json({ id: 1, name: 'The Owner' }));
    expect(await client.request('get', canvasPath`/users/self/profile`)).toEqual({ id: 1, name: 'The Owner' });
  });

  it('raises the tier with forceTier where the path alone is not sensitive', async () => {
    const member = { id: 501, name: 'Alice Realname', sortable_name: 'Realname, Alice' };
    const groups = [{ id: 1, name: 'Group A', users: [member] }];
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/groups', () => json(groups));
    const path = canvasPath`/courses/${1}/groups`;

    const byPath = await client.request('get', path, { params: { 'include[]': ['users'] } });
    const forced = await client.request('get', path, { params: { 'include[]': ['users'] }, forceTier: 'full' });

    expect(JSON.stringify(byPath)).toContain('Alice Realname');
    expect(JSON.stringify(forced)).not.toContain('Realname');
  });

  it('cannot lower the tier with forceTier', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/users', () => json(roster));
    const users = await client.request('get', canvasPath`/courses/${1}/users`, { forceTier: 'none' });
    expect(JSON.stringify(users)).not.toContain('Realname');
  });

  it('gives one student the same pseudonym across requests of a client, keyed by the salt', async () => {
    const unsalted = setup();
    const salted = setup({ pseudonymSalt: 'pepper' });
    for (const { fake } of [unsalted, salted]) {
      fake.route('GET', '/api/v1/courses/1/users', () => json(roster));
      fake.route('GET', '/api/v1/courses/1/users/501', () => json(roster[0]));
    }
    const nameOf = (value: unknown): unknown => (value as { name: unknown }).name;

    const listed = (await unsalted.client.request('get', canvasPath`/courses/${1}/users`)) as unknown[];
    const single = await unsalted.client.request('get', canvasPath`/courses/${1}/users/${501}`);
    const other = await salted.client.request('get', canvasPath`/courses/${1}/users/${501}`);

    expect(nameOf(single)).toBe(nameOf(listed[0]));
    expect(nameOf(other)).toMatch(/^Student_[0-9a-f]{8}$/);
    expect(nameOf(other)).not.toBe(nameOf(single));
  });

  it('refuses raw access without allowRaw, before anything is sent, and logs a security event', async () => {
    const { fake, client, logLines } = setup();
    fake.route('GET', '/api/v1/courses/1/users', () => json(roster));

    const single = failureOf(
      await client.request('get', canvasPath`/courses/${1}/users`, { skipAnonymization: true }),
    );
    const paged = failureOf(await client.fetchAll(canvasPath`/courses/${1}/users`, {}, { skipAnonymization: true }));

    for (const failure of [single, paged]) {
      expect(failure.outcome).toBe('not_dispatched');
      expect(failure.error).toContain('anonymization');
    }
    expect(fake.calls).toHaveLength(0);
    const events = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const security = events.filter((event) => event.level === 'security');
    expect(security).toHaveLength(2);
    expect(security[0]!.event).toBe('canvas_raw_access_refused');
    expect(security[0]!.endpoint).toBe('/courses/***/users');
  });

  it('honours skipAnonymization on a client created with allowRaw', async () => {
    const { fake, client } = setup({ allowRaw: true });
    fake.route('GET', '/api/v1/courses/1/users', () => json(roster));

    expect(await client.request('get', canvasPath`/courses/${1}/users`, { skipAnonymization: true })).toEqual(roster);
    // allowRaw is a permission, not a default.
    expect(JSON.stringify(await client.request('get', canvasPath`/courses/${1}/users`))).not.toContain('Realname');
  });
});

describe('secret handling', () => {
  function deepStrings(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return [value.toString()];
    if (typeof value !== 'object' || value === null || seen.has(value)) return [];
    seen.add(value);
    return Reflect.ownKeys(value).flatMap((key) => deepStrings((value as Record<PropertyKey, unknown>)[key], seen));
  }

  it('exposes only origin, caller id and kind', () => {
    const { client } = setup();
    expect(client.caller).toEqual({ origin: ORIGIN, callerId: 'caller-test', kind: 'owner-secret' });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.caller)).toBe(true);
    expect(JSON.stringify(client)).not.toContain(FAKE_TOKEN);
    expect(deepStrings(client).some((text) => text.includes(FAKE_TOKEN))).toBe(false);
  });

  it('never puts the token in a failure or a log line', async () => {
    const { fake, client, logLines } = setup({ budget: 60 });
    const echo = `Invalid access token ${FAKE_TOKEN} for Authorization: Bearer ${FAKE_TOKEN}`;
    fake.route('GET', '/api/v1/echo/text', () => new Response(echo, { status: 401 }));
    fake.route('GET', '/api/v1/echo/json', () => json({ errors: [{ message: echo }] }, { status: 400 }));
    fake.route('GET', '/api/v1/echo/ok', () => json({ error: echo }));
    fake.route('GET', '/api/v1/echo/list', () => json({ error: echo }));
    fake.route('POST', '/api/v1/echo/throw', () => {
      const error = new Error(`request to ${API}/echo/throw?access_token=${FAKE_TOKEN} failed, token ${FAKE_TOKEN}`);
      error.name = `Err-${FAKE_TOKEN}`;
      throw error;
    });
    fake.route('GET', '/api/v1/echo/redirect', () =>
      new Response(null, { status: 302, headers: { Location: `https://evil.example/?t=${FAKE_TOKEN}` } }),
    );
    fake.route('GET', '/api/v1/echo/link', () =>
      json([1], { headers: { Link: `<https://evil.example/api/v1/echo/link?t=${FAKE_TOKEN}>; rel="next"` } }),
    );
    fake.route('GET', '/files/1/download', () => {
      throw new TypeError(`fetch failed: ${ORIGIN}/files/1/download?verifier=${FAKE_TOKEN}`);
    });

    const results = [
      await client.request('get', canvasPath`/echo/text`),
      await client.request('get', canvasPath`/echo/json`),
      await client.request('get', canvasPath`/echo/ok`),
      await client.fetchAll(canvasPath`/echo/list`),
      await client.request('post', canvasPath`/echo/throw`, { data: { a: 1 } }),
      await client.request('get', canvasPath`/echo/redirect`),
      await client.fetchAll(canvasPath`/echo/link`),
      await client.request('get', canvasPath`/echo/missing`),
      await client.request('get', canvasPath`/echo/text`, { skipAnonymization: true }),
      await client.downloadFile(`${ORIGIN}/files/1/download?verifier=${FAKE_TOKEN}`, { maxBytes: 10 }),
      await client.downloadFile(`https://evil.example/x?t=${FAKE_TOKEN}`, { maxBytes: 10 }),
    ];

    for (const result of results) {
      expect(isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    }
    expect(logLines.length).toBeGreaterThan(10);
    for (const line of logLines) {
      expect(line).not.toContain(FAKE_TOKEN);
      expect(line).not.toContain('Bearer');
    }
    // The sanitized forms are still useful to a reader.
    expect((results[0] as RequestFailure).error).toContain('HTTP error: 401');
    expect((results[4] as RequestFailure).error).toContain(`${API}/echo/throw failed`);
  });

  it('logs endpoints with numeric ids masked and never the query', async () => {
    const { fake, client, logLines } = setup();
    fake.route('GET', '/api/v1/courses/12345/users/678', () => json({ id: 678 }));

    await client.request('get', canvasPath`/courses/${12345}/users/${678}`, { params: { search_term: 'alice' } });

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain('12345');
      expect(line).not.toContain('alice');
    }
    expect(logLines.some((line) => line.includes('/courses/***/users/***'))).toBe(true);
  });

  it('writes data access events only when LOG_ACCESS_EVENTS is on', async () => {
    const on = setup();
    const off = setup({ config: { logAccessEvents: false } });
    for (const { fake, client } of [on, off]) {
      fake.route('GET', '/api/v1/courses', () => json([]));
      await client.request('get', canvasPath`/courses`);
      await client.request('get', canvasPath`/missing`);
    }
    const access = (lines: string[]) =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.event === 'data_access');

    expect(access(off.logLines)).toEqual([]);
    const summary = access(on.logLines).map((event) => ({
      method: event.method,
      endpoint: event.endpoint,
      status: event.status,
      error: event.error,
    }));
    expect(summary).toEqual([
      { method: 'GET', endpoint: '/courses', status: 'success', error: undefined },
      { method: 'GET', endpoint: '/missing', status: 'error', error: 'HTTP 404' },
    ]);
  });
});
