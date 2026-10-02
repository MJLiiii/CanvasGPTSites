// Ports the link-parsing cases of tests/code_api/pagination-control-plane.test.ts and the
// endpoint-pinning invariant of tests/code_api/pagination-redirect.test.ts.
import { describe, expect, it } from 'vitest';
import { PaginationLinkError, nextPageUrl, splitLink } from '../../src/canvas/link-header';
import { isPinnedPageUrl } from '../../src/canvas/path';

const API_BASE = 'https://canvas.example/api/v1';
const root = `${API_BASE}/courses`;
const current = new URL(`${root}?page=1&per_page=100`);

/** The check the client applies to a parsed next link before following it. */
function pinned(next: URL | string, firstPage: URL = current): boolean {
  return isPinnedPageUrl(typeof next === 'string' ? next : next.href, API_BASE, firstPage.pathname);
}

describe('splitLink', () => {
  it('splits on the separator', () => {
    expect(splitLink('<a>; rel="next", <b>; rel="prev"', ',')).toEqual(['<a>; rel="next"', ' <b>; rel="prev"']);
    expect(splitLink('; rel="next"; title="x"', ';')).toEqual(['', ' rel="next"', ' title="x"']);
  });

  it('returns the whole value when the separator is absent', () => {
    expect(splitLink('<a>; rel="next"', ',')).toEqual(['<a>; rel="next"']);
    expect(splitLink('', ',')).toEqual(['']);
  });

  it('does not split inside angle brackets', () => {
    expect(splitLink('<https://h/x?a=1,2;b>; rel="next"', ',')).toEqual(['<https://h/x?a=1,2;b>; rel="next"']);
    expect(splitLink('<https://h/x?a=1,2;b>; rel="next"', ';')).toEqual(['<https://h/x?a=1,2;b>', ' rel="next"']);
  });

  it('does not split inside quotes, including escaped quotes', () => {
    expect(splitLink('<a>; title="x, y"; rel="next"', ',')).toEqual(['<a>; title="x, y"; rel="next"']);
    expect(splitLink('<a>; title="x \\" , y", <b>', ',')).toEqual(['<a>; title="x \\" , y"', ' <b>']);
    expect(splitLink('<a>; title="<not, a, link>"', ',')).toEqual(['<a>; title="<not, a, link>"']);
  });

  it.each(['<broken; rel="next"', 'a>b', '<<a>>', '<a>; title="open', '<a>; title="x\\'])(
    'throws on unbalanced syntax: %s',
    (value) => {
      expect(() => splitLink(value, ',')).toThrow(PaginationLinkError);
      expect(() => splitLink(value, ',')).toThrow('Invalid pagination link syntax');
    },
  );
});

describe('nextPageUrl', () => {
  it.each([null, '', '   '])('returns null for the missing header %j', (header) => {
    expect(nextPageUrl(header, current)).toBeNull();
  });

  it('follows an opaque next query without rewriting it', () => {
    const next = `${root}?cursor=a%2Bb,c&include[]=a&include[]=b`;
    expect(nextPageUrl(`<${next}>; rel="next"`, current)?.href).toBe(next);
  });

  it('returns null when no relation is next: a full final page does not guess another page', () => {
    const header = `<${root}?page=1>; rel="current", <${root}?page=1>; rel="first", <${root}?page=1>; rel="last"`;
    expect(nextPageUrl(header, current)).toBeNull();
  });

  it('picks next out of a typical Canvas header', () => {
    const header =
      `<${root}?page=1&per_page=100>; rel="current",` +
      `<${root}?page=2&per_page=100>; rel="next",` +
      `<${root}?page=1&per_page=100>; rel="first",` +
      `<${root}?page=7&per_page=100>; rel="last"`;
    expect(nextPageUrl(header, current)?.href).toBe(`${root}?page=2&per_page=100`);
  });

  it('accepts an unquoted relation and any parameter-name case', () => {
    expect(nextPageUrl(`<${root}?p=2>; rel=next`, current)?.href).toBe(`${root}?p=2`);
    expect(nextPageUrl(`<${root}?p=2>; REL="NEXT"`, current)?.href).toBe(`${root}?p=2`);
    expect(nextPageUrl(`  <${root}?p=2>  ;  rel = "next"  `, current)?.href).toBe(`${root}?p=2`);
  });

  it('quoted attributes and relation lists preserve relative opaque next', () => {
    const header = `<${root}?p=1>; rel="prev"; title="x, <fake>; \\"quote\\"", <?cursor=a%2Bb,c>; title="a;b,c"; ReL="next alternate"`;
    expect(nextPageUrl(header, new URL(root))?.href).toBe(`${root}?cursor=a%2Bb,c`);
  });

  it('accepts an absolute-URI extension relation next to next', () => {
    expect(nextPageUrl(`<${root}?p=2>; rel="next https://example.com/rels/page"`, current)?.href).toBe(`${root}?p=2`);
    expect(nextPageUrl(`<${root}?p=2>; rel="https://example.com/rels/page"`, current)).toBeNull();
  });

  it('resolves the target as given, leaving the safety check to the page-URL validation', () => {
    const next = nextPageUrl('<https://other.example/api/v1/courses?p=2>; rel="next"', current);
    expect(next?.origin).toBe('https://other.example');
    expect(pinned(next as URL)).toBe(false);
  });

  // Malformed, ambiguous or context-changing next links fail instead of ending pagination.
  it.each([
    ['<broken; rel="next"', 'Invalid pagination link syntax'],
    [`<${root}?p=2>; rel="next", <${root}?p=3>; rel="next"`, 'Ambiguous or anchored pagination link'],
    [`<${root}?p=2>; rel="next"; anchor="/other"`, 'Ambiguous or anchored pagination link'],
    [`<${root}?p=2>`, 'Invalid pagination link relation'],
    [`<${root}?p=2>; rel`, 'Invalid pagination link relation'],
    [`<${root}?p=2>; rel=""`, 'Invalid pagination link relation'],
    [`<${root}?p=2>; rel="next,prev"`, 'Invalid pagination link relation'],
    [`<${root}?p=2>; rel="next"; rel="prev"`, 'Ambiguous pagination link relation'],
    [`<${root}?p=2>; rel="prev"; rel="next"`, 'Ambiguous pagination link relation'],
    [`${root}?p=2; rel="next"`, 'Invalid pagination link syntax'],
    [`<${root}?p=2> junk; rel="next"`, 'Invalid pagination link parameters'],
    [`<${root}?p=2>; rel="next"; =x`, 'Invalid pagination link parameters'],
    [`<${root}?p=2>; rel="next" extra`, 'Invalid pagination link parameters'],
    [`<${root}?p=2>; rel="ne xt:"`, 'Invalid pagination link relation'],
    [`<${root}?p=2>; rel="next 1bad"`, 'Invalid pagination link relation'],
    ['<http://[::1>; rel="next"', 'Invalid pagination link URL'],
    [`<${root}?p=2>; rel="next",`, 'Invalid pagination link syntax'],
  ])('throws for %s', (header, message) => {
    expect(() => nextPageUrl(header, current)).toThrow(PaginationLinkError);
    expect(() => nextPageUrl(header, current)).toThrow(message);
    expect(() => nextPageUrl(header, current)).toThrow(/pagination link/i);
  });

  it('rejects a malformed entry even when a valid next precedes it', () => {
    expect(() => nextPageUrl(`<${root}?p=2>; rel="next", <${root}?p=9>`, current)).toThrow(
      'Invalid pagination link relation',
    );
  });

  it('rejects an anchored entry only when it is the next link', () => {
    expect(nextPageUrl(`<${root}?p=0>; rel="prev"; anchor="/x", <${root}?p=2>; rel="next"`, current)?.href).toBe(
      `${root}?p=2`,
    );
  });
});

// upstream validatePageUrl, whose role isPinnedPageUrl takes in this port (it also requires https).
describe('pinning a parsed next link', () => {
  it.each([`${root}?cursor=opaque`, `${root}`, `${root}?page=2&per_page=100`, 'https://canvas.example:443/api/v1/courses?p=2'])(
    'accepts %s',
    (next) => {
      expect(pinned(new URL(next))).toBe(true);
    },
  );

  // Unsafe next links are rejected before another dispatch.
  it.each([
    'https://other.example/api/v1/courses?p=2',
    'https://canvas.example/api/v1/users?p=2',
    'https://user:pass@canvas.example/api/v1/courses?p=2',
    'https://user@canvas.example/api/v1/courses?p=2',
    `${root}?p=2#fragment`,
    `${root}?p=2#`,
    'http://canvas.example/api/v1/courses?p=2',
    'https://canvas.example:8443/api/v1/courses?p=2',
    'https://canvas.example/api/v1/courses/?p=2',
    'https://canvas.example/api/v1/courses/%2e%2e/users?p=2',
  ])('rejects %s', (next) => {
    expect(pinned(new URL(next))).toBe(false);
    // The raw header value is refused too, not only its parsed form.
    expect(pinned(next)).toBe(false);
  });

  it('a redirect target cannot stand in for the paginated endpoint', () => {
    // pagination-redirect.test.ts: a 302 to /other must never be read as a page.
    expect(pinned(new URL('/other', current))).toBe(false);
    expect(pinned(new URL('/api/v1/other', current))).toBe(false);
  });

  it('keeps each traversal pinned to its own first page', () => {
    const a = new URL('https://canvas.example/api/v1/courses/1/submissions?page=1');
    const b = new URL('https://canvas.example/api/v1/courses/2/submissions?page=1');
    const nextA = nextPageUrl(`<${a.origin}${a.pathname}?cursor=opaque>; rel="next"`, a) as URL;
    expect(pinned(nextA, a)).toBe(true);
    expect(pinned(nextA, b)).toBe(false);
  });

  it('refuses a relative next link resolved against an http page, even on the same host', () => {
    const httpPage = new URL('http://canvas.example/api/v1/courses?page=1');
    const next = nextPageUrl('<?page=2>; rel="next"', httpPage) as URL;
    expect(next.href).toBe('http://canvas.example/api/v1/courses?page=2');
    expect(pinned(next, httpPage)).toBe(false);
  });
});
