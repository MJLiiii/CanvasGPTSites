// Pins the encoding rules of canvas_mcp/core/client.py (httpx params=/data= and the
// urlencode() tuple-list branch) as ported in src/canvas/encode.ts.
import { describe, expect, it } from 'vitest';
import { buildFormBody, buildQuery } from '../../src/canvas/encode';
import type { Params, Scalar } from '../../src/types';

function pairs(search: URLSearchParams | string): Array<[string, string]> {
  return [...new URLSearchParams(search).entries()];
}

describe('buildQuery', () => {
  it('returns an empty string when there is nothing to send', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined, b: [] })).toBe('');
  });

  it('has no leading question mark', () => {
    expect(buildQuery({ per_page: 100 })).toBe('per_page=100');
  });

  it('turns arrays into repeated keys in order', () => {
    const query = buildQuery({ 'include[]': ['user', 'assessor', 'user'], per_page: 100 });
    expect(pairs(query)).toEqual([
      ['include[]', 'user'],
      ['include[]', 'assessor'],
      ['include[]', 'user'],
      ['per_page', '100'],
    ]);
  });

  it('keeps the insertion order of keys', () => {
    expect(pairs(buildQuery({ z: 1, a: 2, m: 3 })).map(([key]) => key)).toEqual(['z', 'a', 'm']);
  });

  it('writes booleans as true/false, not True/False', () => {
    expect(buildQuery({ only_announcements: true, published: false })).toBe('only_announcements=true&published=false');
    expect(pairs(buildQuery({ flags: [true, false] }))).toEqual([
      ['flags', 'true'],
      ['flags', 'false'],
    ]);
  });

  it('writes null as an empty value and skips undefined', () => {
    expect(buildQuery({ search_term: null, skipped: undefined, kept: 'x' })).toBe('search_term=&kept=x');
    expect(pairs(buildQuery({ list: ['a', null, 'b'] }))).toEqual([
      ['list', 'a'],
      ['list', ''],
      ['list', 'b'],
    ]);
  });

  it('keeps empty strings, zero and numbers', () => {
    expect(pairs(buildQuery({ a: '', b: 0, c: 85.5, d: -1 }))).toEqual([
      ['a', ''],
      ['b', '0'],
      ['c', '85.5'],
      ['d', '-1'],
    ]);
  });

  it('escapes delimiters so a value cannot add parameters', () => {
    const query = buildQuery({ search_term: 'a&as_user_id=1#x', 'k&y': 'v=1', q: 'é 😀+%' });
    expect(query).not.toContain('#');
    expect(query.split('&')).toHaveLength(3);
    expect(pairs(query)).toEqual([
      ['search_term', 'a&as_user_id=1#x'],
      ['k&y', 'v=1'],
      ['q', 'é 😀+%'],
    ]);
  });

  it('survives a round trip through URL.search', () => {
    const params: Params = { 'include[]': ['a b', 'c/d'], 'filter[name]': 'x?y', page: 1 };
    const url = new URL('https://canvas.example/api/v1/courses');
    url.search = buildQuery(params);
    expect(url.pathname).toBe('/api/v1/courses');
    expect(url.hash).toBe('');
    expect([...url.searchParams.entries()]).toEqual([
      ['include[]', 'a b'],
      ['include[]', 'c/d'],
      ['filter[name]', 'x?y'],
      ['page', '1'],
    ]);
  });

  it('does not mutate its input', () => {
    const params: Params = { per_page: 1, 'include[]': ['user'] };
    const before = structuredClone(params);
    buildQuery(params);
    expect(params).toEqual(before);
  });
});

describe('buildFormBody', () => {
  it('returns URLSearchParams, which fetch sends as application/x-www-form-urlencoded', () => {
    const body = buildFormBody({ 'wiki_page[title]': 'Week 1' });
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.toString()).toBe('wiki_page%5Btitle%5D=Week+1');
    expect(new Request('https://canvas.example/x', { method: 'POST', body }).headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
  });

  it('applies the same value rules as the query for a record', () => {
    const body = buildFormBody({
      'assignment[name]': 'Essay',
      'assignment[published]': true,
      'assignment[peer_reviews]': false,
      'assignment[due_at]': null,
      'assignment[points_possible]': 10,
      'assignment[submission_types][]': ['online_text_entry', 'online_upload'],
      'assignment[description]': undefined,
      'assignment[allowed_extensions][]': [],
    });
    expect(pairs(body)).toEqual([
      ['assignment[name]', 'Essay'],
      ['assignment[published]', 'true'],
      ['assignment[peer_reviews]', 'false'],
      ['assignment[due_at]', ''],
      ['assignment[points_possible]', '10'],
      ['assignment[submission_types][]', 'online_text_entry'],
      ['assignment[submission_types][]', 'online_upload'],
    ]);
  });

  it('keeps order and duplicate keys of a tuple list', () => {
    // modules.py: module[prerequisite_module_ids][] must repeat, between other fields.
    const tuples: Array<[string, Scalar]> = [
      ['module[name]', 'Week 2'],
      ['module[prerequisite_module_ids][]', '11'],
      ['module[prerequisite_module_ids][]', '12'],
      ['module[position]', 2],
      ['module[prerequisite_module_ids][]', '11'],
    ];
    const body = buildFormBody(tuples);
    expect(pairs(body)).toEqual([
      ['module[name]', 'Week 2'],
      ['module[prerequisite_module_ids][]', '11'],
      ['module[prerequisite_module_ids][]', '12'],
      ['module[position]', '2'],
      ['module[prerequisite_module_ids][]', '11'],
    ]);
    expect(body.toString()).toBe(
      'module%5Bname%5D=Week+2&module%5Bprerequisite_module_ids%5D%5B%5D=11&module%5Bprerequisite_module_ids%5D%5B%5D=12' +
        '&module%5Bposition%5D=2&module%5Bprerequisite_module_ids%5D%5B%5D=11',
    );
  });

  it('applies the value rules to a tuple list as well', () => {
    expect(
      pairs(
        buildFormBody([
          ['a', true],
          ['a', false],
          ['b', null],
          ['c', 0],
          ['d', ''],
        ]),
      ),
    ).toEqual([
      ['a', 'true'],
      ['a', 'false'],
      ['b', ''],
      ['c', '0'],
      ['d', ''],
    ]);
  });

  it('handles an empty record and an empty tuple list', () => {
    expect(buildFormBody({}).toString()).toBe('');
    expect(buildFormBody([]).toString()).toBe('');
  });

  it('escapes text that would otherwise split the body', () => {
    const body = buildFormBody({ body: 'a&recipients[]=1\r\nb=c', subject: '100% + more' });
    expect(body.toString().split('&')).toHaveLength(2);
    expect(pairs(body.toString())).toEqual([
      ['body', 'a&recipients[]=1\r\nb=c'],
      ['subject', '100% + more'],
    ]);
  });

  it('does not mutate its input', () => {
    const tuples: Array<[string, Scalar]> = [['k', 'v']];
    const record = { list: ['a', 'b'] };
    buildFormBody(tuples);
    buildFormBody(record);
    expect(tuples).toEqual([['k', 'v']]);
    expect(record).toEqual({ list: ['a', 'b'] });
  });
});
