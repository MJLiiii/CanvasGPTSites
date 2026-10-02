// Ports tests/code_api/pagination-control-plane.test.ts, the pagination cases of
// tests/core/test_client_state_machine.py and the client-level parts of
// tests/tools/test_truncation_disclosure.py. Where upstream fails on a page cap,
// this port returns a truncated page that must be disclosed.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUNCATION_HINT } from '../../src/canvas/client';
import { isFailure } from '../../src/canvas/errors';
import { canvasPath } from '../../src/canvas/path';
import type { Paged, RequestFailure } from '../../src/types';
import { createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example';
const ROOT = `${ORIGIN}/api/v1/courses`;

function setup(options: Parameters<typeof createTestClient>[1] = {}) {
  const fake = createFakeCanvas({ origin: ORIGIN });
  return { fake, ...createTestClient(fake, options) };
}

function page(data: unknown, next?: string, headers: Record<string, string> = {}): Response {
  return json(data, { headers: next === undefined ? headers : { Link: `<${next}>; rel="next"`, ...headers } });
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
  return value;
}

function pagedOf<T>(value: Paged<T> | RequestFailure): Paged<T> {
  if (isFailure(value)) throw new Error(`expected a page, got failure: ${value.error}`);
  return value;
}

function numbered(count: number): Array<{ id: number }> {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
}

describe('following next links', () => {
  it('asks for per_page=100 and page=1, and leaves the caller params untouched', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => page([{ id: 1 }]));
    const params = { 'include[]': ['term'], enrollment_state: 'active' };
    const before = structuredClone(params);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`, params));

    expect(result).toEqual({ items: [{ id: 1 }], truncated: false, pagesFetched: 1, label: 'items' });
    expect(fake.calls[0]!.url).toBe(`${ROOT}?include%5B%5D=term&enrollment_state=active&per_page=100&page=1`);
    expect(params).toEqual(before);
  });

  it("keeps the caller's per_page", async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => page([]));
    await client.fetchAll(canvasPath`/courses`, { per_page: 25, page: 7 });
    expect(fake.calls[0]!.url).toBe(`${ROOT}?per_page=25&page=1`);
  });

  for (const first of [[{ id: 1 }], []]) {
    it(`a short page of ${first.length} still follows the opaque next query`, async () => {
      const { fake, client } = setup();
      const next = `${ROOT}?cursor=a%2Bb,c&include[]=a&include[]=b`;
      fake.route('GET', '/api/v1/courses', () => (fake.calls.length === 1 ? page(first, next) : page([{ id: 2 }])));

      const result = pagedOf(await client.fetchAll(canvasPath`/courses`));

      expect(result.items).toEqual([...first, { id: 2 }]);
      expect(result.truncated).toBe(false);
      expect(result.pagesFetched).toBe(2);
      // The next URL is used verbatim: nothing is re-encoded or appended.
      expect(fake.calls[1]!.url).toBe(next);
      expect(fake.calls).toHaveLength(2);
    });
  }

  it('does not guess another page after a full page without a next link', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => page(fake.calls.length === 1 ? [1] : []));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`, { per_page: 1 }));

    expect(result.items).toEqual([1]);
    expect(fake.calls).toHaveLength(1);
  });

  it('follows the bookmark links the fake emits, like Canvas', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(250));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { label: 'assignments' }));

    expect(result.items).toHaveLength(250);
    expect(result.items[249]).toEqual({ id: 250 });
    expect(result).toMatchObject({ truncated: false, pagesFetched: 3, label: 'assignments' });
    expect(fake.calls.map((call) => new URL(call.url).searchParams.get('page'))).toEqual([
      '1',
      'bookmark:WzEwMF0',
      'bookmark:WzIwMF0',
    ]);
  });

  it('reads quoted attributes and relation lists, and resolves a relative next', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1
        ? json([1], {
            headers: {
              lInK:
                `<${ROOT}?p=1>; rel="prev"; title="x, <fake>; \\"quote\\"", ` +
                '<?cursor=a%2Bb,c>; title="a;b,c"; ReL="next alternate"',
            },
          })
        : page([2]),
    );

    expect(pagedOf(await client.fetchAll(canvasPath`/courses`)).items).toEqual([1, 2]);
    expect(fake.calls[1]!.url).toBe(`${ROOT}?cursor=a%2Bb,c`);
  });

  it('gives concurrent callers private cursors', async () => {
    const { fake, client } = setup();
    const params = { per_page: 1, 'include[]': ['user'] };
    const before = structuredClone(params);
    fake.route('GET', /^\/api\/v1\/courses\/\d\/modules$/, async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { pathname, searchParams } = request.parsed;
      if (searchParams.has('cursor')) return page([`${pathname}:second`]);
      return page([`${pathname}:first`], `${ORIGIN}${pathname}?cursor=opaque`);
    });

    const [a, b] = await Promise.all([
      client.fetchAll(canvasPath`/courses/${1}/modules`, params),
      client.fetchAll(canvasPath`/courses/${2}/modules`, params),
    ]);

    expect(pagedOf(a).items).toEqual(['/api/v1/courses/1/modules:first', '/api/v1/courses/1/modules:second']);
    expect(pagedOf(b).items).toEqual(['/api/v1/courses/2/modules:first', '/api/v1/courses/2/modules:second']);
    expect(fake.calls).toHaveLength(4);
    expect(new Set(fake.calls.map((call) => call.url)).size).toBe(4);
    expect(params).toEqual(before);
  });

  it('does not append a page twice when a read is retried', async () => {
    const { fake, client, sleeps } = setup();
    fake.route('GET', '/api/v1/courses', (request) => {
      if (fake.calls.length === 1) return new Response('busy', { status: 503 });
      return request.url.includes('cursor=next') ? page([2]) : page([1], `${ROOT}?cursor=next`);
    });

    expect(pagedOf(await client.fetchAll(canvasPath`/courses`)).items).toEqual([1, 2]);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([500]);
  });
});

describe('refusing bad pagination', () => {
  it('fails on a self cycle before fetching or appending the repeated page', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', (request) =>
      fake.calls.length > 3 ? new Response('finite test sentinel', { status: 400 }) : page([1], request.url),
    );

    const failure = failureOf(await client.fetchAll(canvasPath`/courses`, { per_page: 1 }));

    expect(failure.error).toBe('Pagination cycle detected; no partial result returned');
    expect(fake.calls).toHaveLength(1);
  });

  it('fails on a longer cycle', async () => {
    const { fake, client } = setup();
    // first page -> a -> b -> a
    fake.route('GET', '/api/v1/courses', (request) =>
      page([1], `${ROOT}?cursor=${request.url.includes('cursor=a') ? 'b' : 'a'}`),
    );

    const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

    expect(failure.error).toMatch(/cycle/i);
    expect(fake.calls).toHaveLength(3);
  });

  for (const next of [
    'https://other.example/api/v1/courses?p=2',
    'https://canvas.example/api/v1/users?p=2',
    'https://user:pass@canvas.example/api/v1/courses?p=2',
    `${ROOT}?p=2#fragment`,
    `${ROOT}?p=2#`,
    'http://canvas.example/api/v1/courses?p=2',
    'https://canvas.example:8443/api/v1/courses?p=2',
    'https://canvas.example/api/v1/courses/?p=2',
    'https://canvas.example/api/v1/courses/%2e%2e/users?p=2',
  ]) {
    it(`rejects the unsafe next link ${next} before another dispatch`, async () => {
      const { fake, client } = setup();
      fake.route('GET', '/api/v1/courses', () => page([1], next));

      const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

      expect(failure.error).toBe('Invalid pagination link: origin or endpoint changed');
      expect(failure.outcome).toBe('not_dispatched');
      expect(fake.calls).toHaveLength(1);
    });
  }

  for (const link of [
    '<broken; rel="next"',
    `<${ROOT}?p=2>; rel="next", <${ROOT}?p=3>; rel="next"`,
    `<${ROOT}?p=2>; rel="next"; anchor="/other"`,
    `<${ROOT}?p=2>`,
    `<${ROOT}?p=2>; rel`,
    `<${ROOT}?p=2>; rel=""`,
    `<${ROOT}?p=2>; rel="next,prev"`,
  ]) {
    it(`fails on the malformed or ambiguous Link header ${link}`, async () => {
      const { fake, client } = setup();
      fake.route('GET', '/api/v1/courses', () => json([1], { headers: { Link: link } }));

      const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

      expect(failure.error).toMatch(/pagination link/i);
      expect(fake.calls).toHaveLength(1);
    });
  }

  for (const data of [null, { unexpected: [] }, 'text', 3]) {
    it(`treats the non-array page ${JSON.stringify(data)} as an error, not a partial success`, async () => {
      const { fake, client } = setup();
      fake.route('GET', '/api/v1/courses', () => page(data));

      const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

      expect(failure.error).toBe('Invalid paginated response: expected a list');
    });
  }

  it('reports a non-array page on a later page without partial items', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1 ? page([1], `${ROOT}?p=2`) : page({ conversations: [] }),
    );
    expect(failureOf(await client.fetchAll(canvasPath`/courses`)).error).toBe(
      'Invalid paginated response: expected a list',
    );
  });

  it('returns a later HTTP error instead of the pages already collected', async () => {
    const { fake, client, logLines } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1 ? page([1], `${ROOT}?p=2`) : new Response('forbidden', { status: 403 }),
    );

    const result = await client.fetchAll(canvasPath`/courses`);
    const failure = failureOf(result);

    expect(failure.error).toBe('HTTP error: 403, Text: forbidden');
    expect('items' in result).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(client.truncations).toEqual([]);
    expect(logLines.some((line) => line.includes('canvas_pagination_truncated'))).toBe(false);
  });

  it('returns a persistent throttle on a later page as a failure, with no partial items', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1 ? page([1], `${ROOT}?p=2`) : new Response('Rate Limit Exceeded', { status: 403 }),
    );

    const failure = failureOf(await client.fetchAll(canvasPath`/courses`));

    expect(failure.throttled).toBe(true);
    // One page, then the throttled page and its two retries.
    expect(fake.calls).toHaveLength(4);
  });
});

describe('truncation', () => {
  // Counterpart of test_unbounded_unique_next_links_hit_explicit_budget.
  it('stops an unending chain of unique next links at the page cap', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => page([fake.calls.length], `${ROOT}?cursor=${fake.calls.length + 1}`));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`, {}, { maxPages: 3, label: 'courses' }));

    expect(result).toEqual({
      items: [1, 2, 3],
      truncated: true,
      reason: 'max_pages',
      pagesFetched: 3,
      label: 'courses',
    });
    expect(fake.calls).toHaveLength(3);
    expect(client.truncations).toEqual([{ label: 'courses', reason: 'max_pages', disclosed: false }]);
  });

  it('uses CANVAS_MAX_PAGES when the caller gives no cap', async () => {
    const { fake, client } = setup({ config: { maxPages: 4 } });
    fake.paginate('/api/v1/courses/1/assignments', numbered(1_000));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`));

    expect(result.items).toHaveLength(400);
    expect(result).toMatchObject({ truncated: true, reason: 'max_pages', pagesFetched: 4 });
    expect(fake.calls).toHaveLength(4);
  });

  it('is not truncated when the cap is reached on the last page', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(300));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxPages: 3 }));

    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.items).toHaveLength(300);
    expect(client.truncations).toEqual([]);
  });

  // Counterpart of test_list_conversations_reports_more_available_without_fetching_more.
  it('reports that more exist after one page without fetching more', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/conversations', numbered(3), 2);

    const result = pagedOf(await client.fetchAll(canvasPath`/conversations`, {}, { maxPages: 1 }));

    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result).toMatchObject({ truncated: true, reason: 'max_pages', pagesFetched: 1 });
    expect(fake.calls).toHaveLength(1);
  });

  // Counterpart of test_list_conversations_last_page_reports_complete.
  it('reports a single last page as complete', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/conversations', numbered(1), 2);

    const result = pagedOf(await client.fetchAll(canvasPath`/conversations`, {}, { maxPages: 1 }));

    expect(result).toMatchObject({ truncated: false, pagesFetched: 1 });
    expect(result.items).toHaveLength(1);
  });

  it('stops at maxItems and cuts the list to it', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(500), 100);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxItems: 150 }));

    expect(result.items).toHaveLength(150);
    expect(result).toMatchObject({ truncated: true, reason: 'max_items', pagesFetched: 2 });
    expect(fake.calls).toHaveLength(2);
  });

  it('is complete when the list ends exactly at maxItems', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(200), 100);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxItems: 200 }));

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(200);
  });

  it('cuts a single oversized page to maxItems and says so', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(80), 100);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxItems: 50 }));

    expect(result.items).toHaveLength(50);
    expect(result).toMatchObject({ truncated: true, reason: 'max_items', pagesFetched: 1 });
  });

  it('truncates when the budget runs out between pages', async () => {
    const { fake, client, meter } = setup({ budget: 3 });
    fake.paginate('/api/v1/courses/1/assignments', numbered(1_000));

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { label: 'assignments' }));

    expect(result.items).toHaveLength(300);
    expect(result).toMatchObject({ truncated: true, reason: 'budget', pagesFetched: 3 });
    expect(fake.calls).toHaveLength(3);
    expect(meter.remaining).toBe(0);
    expect(client.truncations).toEqual([{ label: 'assignments', reason: 'budget', disclosed: false }]);
  });

  it('leaves reserved slots alone when it truncates for budget', async () => {
    const { fake, client, meter } = setup({ budget: 4 });
    fake.paginate('/api/v1/courses/1/assignments', numbered(1_000));
    client.budget.reserve(2);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`));

    expect(result).toMatchObject({ truncated: true, reason: 'budget', pagesFetched: 2 });
    expect(meter.reserved).toBe(2);
  });

  it('returns a failure, not an empty truncated page, when not even the first page can be sent', async () => {
    const { fake, client } = setup({ budget: 0 });
    fake.paginate('/api/v1/courses/1/assignments', numbered(10));

    const failure = failureOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`));

    expect(failure.outcome).toBe('not_dispatched');
    expect(failure.budgetExhausted).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(client.truncations).toEqual([]);
  });

  it('truncates when the deadline passes between pages', async () => {
    const { fake, client, clock } = setup({ deadlineIn: 10_000 });
    fake.route('GET', '/api/v1/courses', () => {
      clock.now += 4_000;
      return page([fake.calls.length], `${ROOT}?cursor=${fake.calls.length + 1}`);
    });

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`));

    expect(result).toMatchObject({ items: [1, 2, 3], truncated: true, reason: 'deadline', pagesFetched: 3 });
    expect(fake.calls).toHaveLength(3);
  });

  it('truncates when a later page is cut short by the deadline', async () => {
    const { fake, client } = setup({ realTime: true, deadlineIn: 60, config: { apiTimeoutMs: 60_000 } });
    fake.route('GET', '/api/v1/courses', () =>
      fake.calls.length === 1 ? page([1], `${ROOT}?cursor=2`) : new Promise<Response>(() => {}),
    );

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`));

    expect(result).toMatchObject({ items: [1], truncated: true, reason: 'deadline', pagesFetched: 1 });
  });

  it('stops paginating when X-Rate-Limit-Remaining falls below 50', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () =>
      page([fake.calls.length], `${ROOT}?cursor=${fake.calls.length + 1}`, {
        'X-Rate-Limit-Remaining': fake.calls.length === 1 ? '400' : '49.9',
      }),
    );

    const result = pagedOf(await client.fetchAll(canvasPath`/courses`));

    expect(result).toMatchObject({ items: [1, 2], truncated: true, reason: 'throttle', pagesFetched: 2 });
    expect(fake.calls).toHaveLength(2);
  });

  it('finishes normally on a low quota when there is no next page', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', () => page([1], undefined, { 'X-Rate-Limit-Remaining': '10' }));
    expect(pagedOf(await client.fetchAll(canvasPath`/courses`)).truncated).toBe(false);
  });
});

describe('disclosure', () => {
  async function truncatedPage(label?: string) {
    const context = setup();
    context.fake.paginate('/api/v1/courses/1/assignments', numbered(500), 100);
    const result = pagedOf(
      await context.client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxPages: 2, label }),
    );
    return { ...context, result };
  }

  it('returns the standard notice and marks the truncation disclosed', async () => {
    const { client, result } = await truncatedPage('assignments');

    expect(client.truncations).toEqual([{ label: 'assignments', reason: 'max_pages', disclosed: false }]);
    const notice = client.disclose(result);

    expect(notice).toBe(
      '⚠️ Results truncated: showing 200 assignments from the first 2 page(s); more exist in Canvas. ' +
        'Narrow the request (one course, a search term, or a date range).',
    );
    expect(notice.endsWith(DEFAULT_TRUNCATION_HINT)).toBe(true);
    expect(client.truncations).toEqual([{ label: 'assignments', reason: 'max_pages', disclosed: true }]);
  });

  it('uses the hint the tool supplies and the default label', async () => {
    const { client, result } = await truncatedPage();
    expect(client.disclose(result, 'Use search_term to find a specific file.')).toBe(
      '⚠️ Results truncated: showing 200 items from the first 2 page(s); more exist in Canvas. ' +
        'Use search_term to find a specific file.',
    );
  });

  it('returns an empty string for a complete page', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(5));
    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`));

    expect(client.disclose(result)).toBe('');
    expect(client.requireComplete(result, 'assignments')).toBeNull();
  });

  it('marks only the page that was disclosed', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/assignments', numbered(500), 100);
    fake.paginate('/api/v1/courses/1/modules', numbered(500), 100);
    const assignments = pagedOf(
      await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, { maxPages: 1, label: 'assignments' }),
    );
    pagedOf(await client.fetchAll(canvasPath`/courses/${1}/modules`, {}, { maxPages: 1, label: 'modules' }));

    client.disclose(assignments);

    expect(client.truncations).toEqual([
      { label: 'assignments', reason: 'max_pages', disclosed: true },
      { label: 'modules', reason: 'max_pages', disclosed: false },
    ]);
  });

  it('still finds the record when the tool hands back a copy of the page', async () => {
    const { client, result } = await truncatedPage('assignments');
    client.disclose({ ...result, items: result.items.slice(0, 5) });
    expect(client.truncations[0]!.disclosed).toBe(true);
  });

  it('hands out a snapshot of the truncation records', async () => {
    const { client } = await truncatedPage('assignments');
    const snapshot = client.truncations as unknown as Array<{ disclosed: boolean }>;
    snapshot[0]!.disclosed = true;
    snapshot.length = 0;
    expect(client.truncations).toEqual([{ label: 'assignments', reason: 'max_pages', disclosed: false }]);
  });

  // Issue 420: a truncated read must never become a write.
  it('requireComplete refuses a truncated list in terms a tool can return as is', async () => {
    const { client, result } = await truncatedPage('submissions');

    const refusal = client.requireComplete(result, 'submissions for this assignment');

    expect(refusal).not.toBeNull();
    expect(refusal!.startsWith('Error')).toBe(true);
    expect(refusal).toContain('submissions for this assignment');
    expect(refusal).toContain('only the first 2 page(s)');
    expect(refusal).toContain('the page limit was reached');
    expect(refusal).toContain('must not decide a write');
    // The refusal states the truncation, so it counts as disclosed.
    expect(client.truncations[0]!.disclosed).toBe(true);
  });

  it.each([
    ['budget', { budget: 2 }, {}, 'the request budget for this tool call ran out'],
    ['max_items', {}, { maxItems: 150 }, 'the item limit was reached'],
  ] as const)('requireComplete names the %s reason', async (reason, clientOptions, pageOptions, text) => {
    const { fake, client } = setup(clientOptions);
    fake.paginate('/api/v1/courses/1/assignments', numbered(500), 100);
    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/assignments`, {}, pageOptions));

    expect(result.reason).toBe(reason);
    expect(client.requireComplete(result, 'assignments')).toContain(text);
  });
});

describe('anonymization of paged results', () => {
  function roster(from: number, to: number) {
    return Array.from({ length: to - from + 1 }, (_, index) => ({
      id: from + index,
      name: `Real Person ${from + index}`,
      sortable_name: `Person ${from + index}, Real`,
    }));
  }

  it('anonymizes once over the merged list, so pseudonyms agree across pages', async () => {
    const { fake, client } = setup();
    // Student 3 appears on both pages.
    fake.route('GET', '/api/v1/courses/1/users', () =>
      fake.calls.length === 1 ? page(roster(1, 3), `${ORIGIN}/api/v1/courses/1/users?cursor=2`) : page(roster(3, 5)),
    );

    const result = pagedOf(await client.fetchAll<{ id: number; name: string }>(canvasPath`/courses/${1}/users`));

    expect(result.items.map((user) => user.id)).toEqual([1, 2, 3, 3, 4, 5]);
    for (const user of result.items) expect(user.name).toMatch(/^Student_[0-9a-f]{8}$/);
    expect(result.items[2]!.name).toBe(result.items[3]!.name);
    expect(new Set(result.items.map((user) => user.name)).size).toBe(5);
    expect(JSON.stringify(result)).not.toContain('Real Person');
  });

  it('anonymizes a truncated list too', async () => {
    const { fake, client } = setup();
    fake.paginate('/api/v1/courses/1/users', roster(1, 300), 100);

    const result = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/users`, {}, { maxPages: 1 }));

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.items)).not.toContain('Real Person');
  });

  it('applies forceTier to the merged list', async () => {
    const groups = [{ id: 1, name: 'Group A', users: roster(1, 2) }];
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/groups', () => page(groups));

    const byPath = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/groups`));
    const forced = pagedOf(await client.fetchAll(canvasPath`/courses/${1}/groups`, {}, { forceTier: 'full' }));

    expect(JSON.stringify(byPath.items)).toContain('Real Person 1');
    expect(JSON.stringify(forced.items)).not.toContain('Real Person');
  });

  it('returns real records only to a client created with allowRaw', async () => {
    const refused = setup();
    const allowed = setup({ allowRaw: true });
    for (const { fake } of [refused, allowed]) fake.paginate('/api/v1/courses/1/users', roster(1, 2));

    const failure = failureOf(
      await refused.client.fetchAll(canvasPath`/courses/${1}/users`, {}, { skipAnonymization: true }),
    );
    const raw = pagedOf(
      await allowed.client.fetchAll(canvasPath`/courses/${1}/users`, {}, { skipAnonymization: true }),
    );

    expect(failure.outcome).toBe('not_dispatched');
    expect(refused.fake.calls).toHaveLength(0);
    expect(raw.items).toEqual(roster(1, 2));
  });
});
