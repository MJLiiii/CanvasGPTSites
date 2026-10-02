// Covers the port of canvas_mcp/core/cache.py (get_course_id, get_course_code) as a
// per-client memo, with the corrections of coverage review findings 4 and 20.
import { describe, expect, it } from 'vitest';
import { COURSE_LIST_MAX_PAGES, createCourseResolver } from '../../src/canvas/course-resolver';
import type { CourseResolverClient } from '../../src/canvas/course-resolver';
import { isFailure, makeFailure } from '../../src/canvas/errors';
import { canvasPath } from '../../src/canvas/path';
import type { Paged, RequestFailure } from '../../src/types';
import { createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.edu';
const API = `${ORIGIN}/api/v1`;

const COURSES = [
  { id: 101, name: 'Marketing', course_code: 'badm_350_120251_246794' },
  { id: 102, name: 'Finance', course_code: 'FIN 221' },
  { id: 103, name: 'No code', course_code: null },
  { id: 104, name: 'Empty code', course_code: '' },
];

function setup(options: Parameters<typeof createTestClient>[1] = {}) {
  const fake = createFakeCanvas({ origin: ORIGIN });
  fake.paginate('/api/v1/courses', COURSES);
  return { fake, ...createTestClient(fake, options) };
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
  return value;
}

describe('resolveId', () => {
  it.each([
    [60366, '60366'],
    ['60366', '60366'],
    [' 60366 ', '60366'],
    ['0', '0'],
  ])('returns the numeric id %j as is, with no request', async (identifier, expected) => {
    const { fake, client } = setup();
    expect(await client.courses.resolveId(identifier)).toBe(expected);
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    'sis_course_id:BADM-350/2025 Spring',
    'sis_integration_id:abc',
    'lti_context_id:4dde05e8ca1973bcca9bffc13e1548820eee93a3',
    'uuid:WvAHhY5FINzq5IyRIJybGeiXyFkG3SqHUPb7jZY5',
  ])('passes the Canvas-native identifier %s through undecoded, with no request', async (identifier) => {
    const { fake, client } = setup();
    expect(await client.courses.resolveId(identifier)).toBe(identifier);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns an identifier that canvasPath encodes into exactly one segment', async () => {
    const { fake, client } = setup();
    fake.route('GET', /^\/api\/v1\/courses\/[^/]+\/assignments$/, () => json([]));

    const id = await client.courses.resolveId('sis_course_id:A/B?c#d');
    if (typeof id !== 'string') throw new Error('expected an identifier');
    await client.request('get', canvasPath`/courses/${id}/assignments`);

    expect(fake.calls[0]!.url).toBe(`${API}/courses/sis_course_id%3AA%2FB%3Fc%23d/assignments`);
  });

  it.each(['sis_course_id:', 'uuid:', 'sis_course_id:a\u0000b', 'lti_context_id:a\nb'])(
    'refuses the prefixed identifier %j with an empty or control-character value',
    async (identifier) => {
      const { fake, client } = setup();
      const failure = failureOf(await client.courses.resolveId(identifier));
      expect(failure.outcome).toBe('not_dispatched');
      expect(failure.error).toMatch(/^Invalid course identifier/);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('matches a course code exactly against the course list', async () => {
    const { fake, client } = setup();

    expect(await client.courses.resolveId('badm_350_120251_246794')).toBe('101');
    expect(await client.courses.resolveId('FIN 221')).toBe('102');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(`${API}/courses?per_page=100&page=1`);
  });

  it('loads the course list once per client, even for concurrent and missing lookups', async () => {
    const { fake, client } = setup();

    const results = await Promise.all([
      client.courses.resolveId('FIN 221'),
      client.courses.resolveId('badm_350_120251_246794'),
      client.courses.resolveId('nope'),
      client.courses.resolveId('fin 221'),
    ]);
    await client.courses.resolveId('still nope');
    await client.courses.resolveCode(102);

    expect(results[0]).toBe('102');
    expect(results[1]).toBe('101');
    expect(isFailure(results[2])).toBe(true);
    // Exact match only: a different case is a different code.
    expect(isFailure(results[3])).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('falls back to a SIS id for an unknown value with an underscore, as upstream', async () => {
    const { client } = setup();
    expect(await client.courses.resolveId('econ_102_fall')).toBe('sis_course_id:econ_102_fall');
  });

  it('reports any other unknown value as not found, without dispatching anything else', async () => {
    const { fake, client } = setup();

    const failure = failureOf(await client.courses.resolveId('BADM 999'));

    expect(failure.error).toBe("Course 'BADM 999' not found. Use list_courses to get the course ID.");
    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(1);
  });

  it.each(['', '   ', 'a\u0007b'])('reports %j as not found without loading the list', async (identifier) => {
    const { fake, client } = setup();
    const failure = failureOf(await client.courses.resolveId(identifier));
    expect(failure.error).toMatch(/^Course '.*' not found\. Use list_courses to get the course ID\.$/);
    expect(failure.error).not.toContain('\u0007');
    expect(fake.calls).toHaveLength(0);
  });

  it('never interpolates a path-shaped identifier: it is looked up, then refused', async () => {
    const { fake, client } = setup();

    for (const hostile of ['1/users', '%2e%2e', '../accounts/1', '123?include[]=x', '-1', '12.5', '١٢٣']) {
      expect(failureOf(await client.courses.resolveId(hostile)).error).toContain('not found');
    }
    // Only the one course-list load went out.
    expect(fake.calls.map((call) => call.url)).toEqual([`${API}/courses?per_page=100&page=1`]);
  });

  it(`reads at most ${COURSE_LIST_MAX_PAGES} pages of courses and records no truncation for it`, async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    const many = Array.from({ length: 700 }, (_, index) => ({ id: index + 1, course_code: `CODE ${index + 1}` }));
    fake.paginate('/api/v1/courses', many);
    const { client } = createTestClient(fake);

    expect(await client.courses.resolveId('CODE 500')).toBe('500');
    expect(isFailure(await client.courses.resolveId('CODE 501'))).toBe(true);

    expect(fake.calls).toHaveLength(COURSE_LIST_MAX_PAGES);
    expect(client.truncations).toEqual([]);
  });

  it('when the list cannot be read, keeps the SIS fallback and otherwise reports the cause', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.route('GET', '/api/v1/courses', () =>
      json({ errors: [{ message: 'Invalid access token.' }] }, { status: 401 }),
    );
    const { client } = createTestClient(fake);

    expect(await client.courses.resolveId('econ_102')).toBe('sis_course_id:econ_102');
    const failure = failureOf(await client.courses.resolveId('ECON 102'));

    expect(failure.error).toBe("HTTP error: 401, Details: {'errors': [{'message': 'Invalid access token.'}]}");
    expect(failure.status).toBe(401);
    // A failed lookup wrote nothing.
    expect(failure.outcome).toBe('not_dispatched');
    // The failed load is not repeated.
    expect(fake.calls).toHaveLength(1);
  });

  it('reports an exhausted budget instead of "not found"', async () => {
    const { fake, client } = setup({ budget: 0 });

    const failure = failureOf(await client.courses.resolveId('FIN 221'));

    expect(failure.budgetExhausted).toBe(true);
    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('resolveCode', () => {
  it('serves every listed course from one course-list request', async () => {
    const { fake, client } = setup();

    expect(await client.courses.resolveCode(101)).toBe('badm_350_120251_246794');
    expect(await client.courses.resolveCode('102')).toBe('FIN 221');
    expect(await client.courses.resolveCode(101)).toBe('badm_350_120251_246794');

    expect(fake.calls).toHaveLength(1);
  });

  it('asks Canvas for a course that is not in the list, once', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/900', () => json({ id: 900, course_code: 'PAST 100' }));

    const codes = await Promise.all([
      client.courses.resolveCode(900),
      client.courses.resolveCode('900'),
      client.courses.resolveCode(900),
    ]);
    expect(await client.courses.resolveCode(900)).toBe('PAST 100');

    expect(codes).toEqual(['PAST 100', 'PAST 100', 'PAST 100']);
    expect(fake.calls.map((call) => call.url)).toEqual([`${API}/courses?per_page=100&page=1`, `${API}/courses/900`]);
    // The reverse mapping is learned too.
    expect(await client.courses.resolveId('PAST 100')).toBe('900');
  });

  it('falls back to the id when the course cannot be read or has no code, and does not ask again', async () => {
    const { fake, client } = setup();

    expect(await client.courses.resolveCode(999)).toBe('999');
    expect(await client.courses.resolveCode(999)).toBe('999');
    expect(await client.courses.resolveCode(103)).toBe('103');
    expect(await client.courses.resolveCode(103)).toBe('103');
    expect(await client.courses.resolveCode(104)).toBe('104');

    expect(fake.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v1/courses',
      '/api/v1/courses/999',
      '/api/v1/courses/103',
      '/api/v1/courses/104',
    ]);
  });

  it('returns the id without a request when the budget is spent', async () => {
    const { fake, client, meter } = setup({ budget: 1 });

    expect(await client.courses.resolveCode(101)).toBe('badm_350_120251_246794');
    expect(await client.courses.resolveCode(900)).toBe('900');

    expect(meter.remaining).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it('returns a code-like string with underscores unchanged, as upstream', async () => {
    const { fake, client } = setup();
    expect(await client.courses.resolveCode('badm_350_120251_246794')).toBe('badm_350_120251_246794');
    expect(fake.calls).toHaveLength(0);
  });

  it.each(['..', '', '%2e%2e', 'a/b', 'x\u0000y'])('never throws for the odd id %j', async (id) => {
    const { client } = setup();
    await expect(client.courses.resolveCode(id)).resolves.toBe(id.trim());
  });

  it('never throws when Canvas is unreachable', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.route('GET', /.*/, () => {
      throw new TypeError('fetch failed');
    });
    const { client } = createTestClient(fake);
    await expect(client.courses.resolveCode(5)).resolves.toBe('5');
  });
});

describe('seeding from responses the client already has', () => {
  it('learns from GET /courses/{id}, so no further request is needed', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/900', () => json({ id: 900, name: 'Past', course_code: 'PAST 100' }));

    await client.request('get', canvasPath`/courses/${900}`);

    expect(await client.courses.resolveCode(900)).toBe('PAST 100');
    expect(await client.courses.resolveId('PAST 100')).toBe('900');
    expect(fake.calls).toHaveLength(1);
  });

  it('learns from a /courses listing fetched by the tool', async () => {
    const { fake, client } = setup();

    await client.fetchAll(canvasPath`/courses`, { enrollment_state: 'active' });

    expect(await client.courses.resolveCode(102)).toBe('FIN 221');
    expect(await client.courses.resolveId('FIN 221')).toBe('102');
    expect(fake.calls).toHaveLength(1);
  });

  it('does not take a filtered listing for the whole list', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses', (request) =>
      json(request.parsed.searchParams.has('enrollment_state') ? COURSES.slice(0, 1) : COURSES),
    );

    await client.fetchAll(canvasPath`/courses`, { enrollment_state: 'active' });
    // 102 was not in the filtered listing; the full list is loaded before giving up.
    expect(await client.courses.resolveCode(102)).toBe('FIN 221');

    expect(fake.calls).toHaveLength(2);
  });

  it('does not learn from other endpoints or from writes', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/api/v1/courses/1/assignments', () => json([{ id: 900, course_code: 'FAKE 1' }]));
    fake.route('PUT', '/api/v1/courses/900', () => json({ id: 900, course_code: 'FAKE 2' }));

    await client.fetchAll(canvasPath`/courses/${1}/assignments`);
    await client.request('put', canvasPath`/courses/${900}`, { data: {} });

    expect(isFailure(await client.courses.resolveId('FAKE 1'))).toBe(true);
    expect(isFailure(await client.courses.resolveId('FAKE 2'))).toBe(true);
  });

  it('keeps one memo per client: nothing is shared between calls', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.paginate('/api/v1/courses', COURSES);
    const first = createTestClient(fake);
    const second = createTestClient(fake);

    expect(await first.client.courses.resolveId('FIN 221')).toBe('102');
    expect(fake.calls).toHaveLength(1);
    expect(await second.client.courses.resolveId('FIN 221')).toBe('102');
    expect(fake.calls).toHaveLength(2);
  });
});

describe('createCourseResolver with a stub client', () => {
  function stub(pageOrFailure: Paged<unknown> | RequestFailure, remaining = 10) {
    const seen: string[] = [];
    const client: CourseResolverClient = {
      fetchAll: async (path, params, options) => {
        seen.push(`fetchAll ${path} ${JSON.stringify(params)} ${JSON.stringify(options)}`);
        return pageOrFailure;
      },
      request: async (_method, path) => {
        seen.push(`request ${path}`);
        return { id: 77, course_code: 'ONE OFF' };
      },
      budget: { remaining },
    };
    return { seen, resolver: createCourseResolver(client) };
  }

  const listing: Paged<unknown> = {
    items: [{ id: 5, course_code: 'CS 101' }, 'junk', null, { id: null, course_code: 'X' }, { course_code: 'Y' }],
    truncated: false,
    pagesFetched: 1,
    label: 'courses',
  };

  it('asks for the course list with per_page=100 and the page cap', async () => {
    const { seen, resolver } = stub(listing);

    expect(await resolver.resolveId('CS 101')).toBe('5');
    expect(isFailure(await resolver.resolveId('X'))).toBe(true);

    expect(seen).toEqual(['fetchAll /courses {"per_page":100} {"maxPages":5,"label":"courses"}']);
  });

  it('builds the per-course path through canvasPath', async () => {
    const { seen, resolver } = stub(listing);
    expect(await resolver.resolveCode('sis:a/b')).toBe('ONE OFF');
    expect(seen[1]).toBe('request /courses/sis%3Aa%2Fb');
  });

  it('seedCourses accepts one object or a list and ignores anything else', async () => {
    const { seen, resolver } = stub(listing);

    resolver.seedCourses({ id: 9, course_code: 'SEED 9' });
    resolver.seedCourses([{ id: '10', course_code: 'SEED 10' }, 4, { id: 11 }]);
    resolver.seedCourses('nonsense');
    resolver.seedCourses(undefined);

    expect(await resolver.resolveCode(9)).toBe('SEED 9');
    expect(await resolver.resolveId('SEED 10')).toBe('10');
    expect(seen).toEqual([]);
  });

  it('survives a client that throws', async () => {
    const resolver = createCourseResolver({
      fetchAll: async () => {
        throw new Error('boom');
      },
      request: async () => {
        throw new Error('boom');
      },
      budget: { remaining: 5 },
    });

    expect(failureOf(await resolver.resolveId('CS 101')).outcome).toBe('not_dispatched');
    expect(await resolver.resolveCode(5)).toBe('5');
  });

  it('turns a may_have_written list failure into a plain refusal', async () => {
    const { resolver } = stub(makeFailure('HTTP error: 500, Text: boom', 'may_have_written', { status: 500 }));
    const failure = failureOf(await resolver.resolveId('CS 101'));
    expect(failure).toEqual({ error: 'HTTP error: 500, Text: boom', outcome: 'not_dispatched', status: 500 });
  });
});
