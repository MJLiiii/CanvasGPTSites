// Ports tests/security/test_path_segment_injection.py as far as it applies to
// path building, plus the encoded dot-segment cases from security review finding 1.
import { describe, expect, it } from 'vitest';
import {
  CanvasPathError,
  apiRelativePath,
  canvasId,
  canvasPath,
  isPinnedPageUrl,
  rawCanvasPath,
  resolveCanvasUrl,
} from '../../src/canvas/path';
import type { CanvasPath } from '../../src/types';

const BASE = 'https://canvas.example.com/api/v1';

/** A path made without the builder, as a buggy or hostile caller would. */
function forged(path: string): CanvasPath {
  return path as CanvasPath;
}

describe('URL construction premise', () => {
  // The finding the whole module rests on, asserted rather than assumed.
  it.each([
    ['/courses/1/pages/%2e%2e/assignments/5', '/api/v1/courses/1/assignments/5'],
    ['/courses/1/pages/%2E%2e/assignments/5', '/api/v1/courses/1/assignments/5'],
    ['/courses/1/pages/.%2e/assignments/5', '/api/v1/courses/1/assignments/5'],
    ['/courses/1/pages/../assignments/5', '/api/v1/courses/1/assignments/5'],
    ['/courses/1/assignments/2/submissions/self/%2e%2e/456', '/api/v1/courses/1/assignments/2/submissions/456'],
    ['/courses/1/pages/%2e/x', '/api/v1/courses/1/pages/x'],
  ])('the URL parser retargets %s', (endpoint, pathname) => {
    expect(new URL(`${BASE}${endpoint}`).pathname).toBe(pathname);
  });

  it.each(['123/submissions/456?', '123/submissions/456#'])(
    'a raw delimiter in %s moves the self suffix off the path',
    (assignmentId) => {
      const url = new URL(`${BASE}/courses/60366/assignments/${assignmentId}/submissions/self`);
      expect(url.pathname.endsWith('/submissions/self')).toBe(false);
      expect(url.pathname.endsWith('/submissions/456')).toBe(true);
    },
  );
});

describe('canvasPath', () => {
  it('builds a static path with no interpolation', () => {
    expect(canvasPath`/courses`).toBe('/courses');
    expect(canvasPath`/users/self/profile`).toBe('/users/self/profile');
  });

  it('interpolates numeric ids in number and string form', () => {
    expect(canvasPath`/courses/${60366}/assignments/${'999'}/submissions/self`).toBe(
      '/courses/60366/assignments/999/submissions/self',
    );
    expect(canvasPath`/courses/${0}`).toBe('/courses/0');
    expect(canvasPath`/courses/${Number.MAX_SAFE_INTEGER}`).toBe('/courses/9007199254740991');
  });

  it.each(['', '.', '..'])('rejects the segment %j', (value) => {
    expect(() => canvasPath`/courses/1/pages/${value}`).toThrow(CanvasPathError);
    expect(() => canvasPath`/courses/1/pages/${value}/revisions`).toThrow(CanvasPathError);
  });

  it("names '..' in the refusal, as upstream does", () => {
    expect(() => canvasPath`/courses/1/pages/${'..'}`).toThrow(
      "Invalid endpoint: '..' is not allowed in a request path",
    );
  });

  it.each([
    ['%2e%2e', '%252e%252e'],
    ['%2E%2e', '%252E%252e'],
    ['.%2e', '.%252e'],
    ['%2e', '%252e'],
    ['a/b', 'a%2Fb'],
    ['a%2fb', 'a%252fb'],
    ['a\\b', 'a%5Cb'],
    ['%5c', '%255c'],
    ['a?b', 'a%3Fb'],
    ['a#b', 'a%23b'],
    ['a b', 'a%20b'],
    ['a;b=c', 'a%3Bb%3Dc'],
    ['user@host:80', 'user%40host%3A80'],
    ['sis_course_id:ABC_101', 'sis_course_id%3AABC_101'],
    ['...', '...'],
    ['..a', '..a'],
    ['my-page_title.v2~', 'my-page_title.v2~'],
  ])('encodes %j as the single segment %j', (value, encoded) => {
    const path = canvasPath`/courses/1/pages/${value}`;
    expect(path).toBe(`/courses/1/pages/${encoded}`);
    const url = resolveCanvasUrl(BASE, path);
    expect(url?.pathname).toBe(`/api/v1/courses/1/pages/${encoded}`);
    expect(url?.search).toBe('');
    expect(url?.hash).toBe('');
  });

  it.each(['\u0000', 'a\nb', 'a\rb', 'a\tb', '\u001f', 'a\u007fb', 'a\u0085b', '\u009f'])(
    'rejects the control character in %j',
    (value) => {
      expect(() => canvasPath`/courses/1/pages/${value}`).toThrow(/control character/);
    },
  );

  it('rejects a lone surrogate instead of throwing URIError', () => {
    expect(() => canvasPath`/courses/1/pages/${'a\ud800b'}`).toThrow(CanvasPathError);
  });

  it.each(['syllabus-été', '课程-大纲', 'página', 'emoji-😀', 'עברית', 'a\u00a0b'])(
    'keeps the unicode slug %j as one round-tripping segment',
    (slug) => {
      const path = canvasPath`/courses/1/pages/${slug}`;
      const url = resolveCanvasUrl(BASE, path);
      expect(url).not.toBeNull();
      expect(url?.pathname).toBe(`/api/v1${path}`);
      const segments = path.split('/');
      expect(segments).toHaveLength(5);
      expect(decodeURIComponent(segments[4] ?? '')).toBe(slug);
    },
  );

  it('keeps a very long value as one segment', () => {
    const long = `${'a/'.repeat(20000)}%2e%2e`;
    const path = canvasPath`/courses/1/pages/${long}`;
    expect(path.split('/')).toHaveLength(5);
    expect(resolveCanvasUrl(BASE, path)?.pathname).toBe(`/api/v1${path}`);
    expect(decodeURIComponent(path.split('/')[4] ?? '')).toBe(long);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53, 1e21])('rejects the number %s', (value) => {
    expect(() => canvasPath`/courses/${value}`).toThrow(CanvasPathError);
  });

  it.each([[undefined], [null], [{}], [['1']], [true], [{ toString: () => '../x' }]])(
    'rejects the non-string, non-number value %s',
    (value) => {
      expect(() => canvasPath`/courses/${value as unknown as string}`).toThrow(CanvasPathError);
    },
  );

  it('does not echo the offending value in the error', () => {
    try {
      canvasPath`/courses/${'secret\u0000value'}`;
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('requires a leading slash', () => {
    expect(() => canvasPath`courses/${1}`).toThrow(CanvasPathError);
    expect(() => canvasPath`${'courses'}/1`).toThrow(CanvasPathError);
    expect(() => canvasPath``).toThrow(CanvasPathError);
  });

  // Upstream layer 1: a delimiter or traversal segment in the endpoint is refused.
  it('refuses a literal delimiter and names it', () => {
    expect(() => canvasPath`/courses/1/assignments/123?x/submissions/self`).toThrow(CanvasPathError);
    expect(() => canvasPath`/courses/1/assignments/123?x/submissions/self`).toThrow(
      "Invalid endpoint: '?' is not allowed in a request path",
    );
    expect(() => canvasPath`/courses/1/assignments/123#x/submissions/self`).toThrow(
      "Invalid endpoint: '#' is not allowed in a request path",
    );
  });

  it('refuses literal traversal, backslash, whitespace and empty segments', () => {
    expect(() => canvasPath`/courses/1/assignments/../../users/2`).toThrow(/'\.\.'/);
    expect(() => canvasPath`/courses/./users`).toThrow(/'\.'/);
    expect(() => canvasPath`/courses/%2e%2e/users`).toThrow(/'\.\.'/);
    expect(() => canvasPath`/courses/.%2E/users`).toThrow(/'\.\.'/);
    expect(() => canvasPath`/courses\\users`).toThrow(CanvasPathError);
    expect(() => canvasPath`/courses /users`).toThrow(CanvasPathError);
    expect(() => canvasPath`/courses//users`).toThrow(CanvasPathError);
    expect(() => canvasPath`/courses/%zz`).toThrow(CanvasPathError);
  });

  it('refuses a literal that completes a dot segment around a value', () => {
    expect(() => canvasPath`/courses/.${'%2e'}`).not.toThrow();
    expect(() => canvasPath`/courses/%2${'e'}/x`).toThrow(CanvasPathError);
  });

  it('refuses being called as a plain function', () => {
    const call = canvasPath as unknown as (...args: unknown[]) => CanvasPath;
    expect(() => call('/courses/1/../2')).toThrow(CanvasPathError);
    expect(() => call(['/courses/1'])).toThrow(CanvasPathError);
  });

  it('keeps the self suffix on the path for a smuggled assignment id', () => {
    for (const assignmentId of ['123/submissions/456?', '123/submissions/456#', '123%2Fsubmissions%2F456?']) {
      const path = canvasPath`/courses/${60366}/assignments/${assignmentId}/submissions/self`;
      const url = resolveCanvasUrl(BASE, path);
      expect(url?.pathname.endsWith('/submissions/self')).toBe(true);
      expect(url?.pathname.split('/')).toHaveLength(9);
      expect(url?.search).toBe('');
    }
  });
});

describe('pathname pinning', () => {
  const hostile = [
    'x/%2e%2e/assignments/5',
    'x/%2e%2e/%2e%2e/assignments/2/submissions/self/%2e%2e/456',
    '%2e%2e/assignments/5',
    '..%2f..%2fusers%2f2',
    '%2e%2e%2f',
    '%252e%252e',
    '..;/x',
    '.;',
    '..\\..\\users',
    '%5c..%5c',
    '‥',
    '．．',
    '%c0%ae%c0%ae',
    '%u002e%u002e',
    '//evil.example/x',
    '@evil.example',
    ':80',
    'x?y#z',
    'x&y=z',
    "!'()*~",
    '%',
    '%%',
    '%2',
    '+',
    ' ',
  ];

  it.each(hostile)('a slug like %j never yields a URL whose pathname differs from the built path', (slug) => {
    for (const path of [
      canvasPath`/courses/1/pages/${slug}`,
      canvasPath`/courses/1/pages/${slug}/revisions/${3}`,
      canvasPath`/courses/${slug}/assignments/${slug}/submissions/self`,
    ]) {
      const url = resolveCanvasUrl(BASE, path);
      expect(url).not.toBeNull();
      expect(url?.origin).toBe('https://canvas.example.com');
      expect(url?.pathname).toBe(`/api/v1${path}`);
      expect(url?.href).toBe(`${BASE}${path}`);
    }
    const single = canvasPath`/courses/1/pages/${slug}`;
    expect(single.split('/')).toHaveLength(5);
    expect(decodeURIComponent(single.split('/')[4] ?? '')).toBe(slug);
    expect(apiRelativePath(resolveCanvasUrl(BASE, single) as URL, BASE)).toBe(single);
  });

  it('holds for every printable ASCII character and a sample of the BMP', () => {
    const samples: string[] = [];
    for (let code = 0x20; code < 0x7f; code++) samples.push(`a${String.fromCharCode(code)}b`);
    for (let code = 0xa0; code < 0xd800; code += 97) samples.push(String.fromCharCode(code));
    for (const value of samples) {
      const path = canvasPath`/x/${value}/y`;
      expect(resolveCanvasUrl(BASE, path)?.pathname).toBe(`/api/v1${path}`);
      expect(path.split('/')).toHaveLength(4);
    }
  });
});

describe('resolveCanvasUrl', () => {
  it('returns the URL for a built path', () => {
    const url = resolveCanvasUrl(BASE, canvasPath`/courses/${1}/pages/${'a b'}`);
    expect(url?.href).toBe('https://canvas.example.com/api/v1/courses/1/pages/a%20b');
  });

  it('ignores a trailing slash on the base', () => {
    expect(resolveCanvasUrl(`${BASE}/`, canvasPath`/courses`)?.href).toBe(`${BASE}/courses`);
    expect(resolveCanvasUrl('https://canvas.example.com/', canvasPath`/courses`)?.href).toBe(
      'https://canvas.example.com/courses',
    );
  });

  it.each([
    '/courses/1/pages/%2e%2e/assignments/5',
    '/courses/1/pages/%2E%2e/assignments/5',
    '/courses/1/pages/.%2e/assignments/5',
    '/courses/1/pages/../assignments/5',
    '/courses/1/pages/./x',
    '/courses/1/pages/%2e',
    '/courses/1/pages/..',
    '/courses/1/assignments/2/submissions/self/%2e%2e/456',
    '/../../login',
    '/courses/1?include[]=x',
    '/courses/1?',
    '/courses/1#frag',
    '/courses/1#',
    '/courses\\1',
    '/courses/a b',
    '/courses/a\tb',
    '/courses/a\nb',
    '/courses/é',
    '/courses/"x"',
    'courses/1',
    '',
    '@evil.example/x',
    '.evil.example/x',
    ':8443/x',
  ])('returns null for the forged path %j', (path) => {
    expect(resolveCanvasUrl(BASE, forged(path))).toBeNull();
  });

  it('never leaves the base origin for a path that looks like an authority', () => {
    const url = resolveCanvasUrl(BASE, forged('//evil.example/x'));
    expect(url === null || (url.origin === 'https://canvas.example.com' && url.pathname === '/api/v1//evil.example/x')).toBe(true);
  });

  it.each([
    'not a url',
    '',
    '/api/v1',
    'ftp://canvas.example.com/api/v1',
    'file:///api/v1',
    // Cleartext: the token rides on every request built from the base.
    'http://canvas.example.com/api/v1',
    'http://127.0.0.1:8080/api/v1',
    'https://user:pass@canvas.example.com/api/v1',
    'https://user@canvas.example.com/api/v1',
    'https://canvas.example.com/api/v1?x=1',
    'https://canvas.example.com/api/v1#x',
    'https://canvas.example.com/api/v1#',
  ])('returns null for the unusable base %j', (base) => {
    expect(resolveCanvasUrl(base, canvasPath`/courses`)).toBeNull();
  });
});

describe('rawCanvasPath', () => {
  it('brands a clean, already-encoded path', () => {
    expect(rawCanvasPath('/courses/1/pages/a%2Fb')).toBe('/courses/1/pages/a%2Fb');
    expect(rawCanvasPath('/courses')).toBe('/courses');
    expect(resolveCanvasUrl(BASE, rawCanvasPath('/courses/sis_course_id:X/users'))?.pathname).toBe(
      '/api/v1/courses/sis_course_id:X/users',
    );
  });

  it.each([
    '',
    'courses',
    '/courses/1/assignments/../../users/2',
    '/courses/./1',
    '/courses/%2e%2e/1',
    '/courses/%2E./1',
    '/courses/.%2e',
    '/courses/1?x=1',
    '/courses/1#x',
    '/courses\\1',
    '/courses//1',
    '/courses/a b',
    '/courses/a\u0000b',
    '/courses/é',
    '/courses/%',
    '/courses/%2',
    '/courses/%zz',
  ])('rejects %j', (path) => {
    expect(() => rawCanvasPath(path)).toThrow(CanvasPathError);
  });

  it('mirrors the upstream traversal refusal text', () => {
    expect(() => rawCanvasPath('/courses/1/assignments/../../users/2')).toThrow(
      "Invalid endpoint: '..' is not allowed in a request path",
    );
    expect(() => rawCanvasPath('/conversations?bad')).toThrow("Invalid endpoint: '?' is not allowed in a request path");
  });

  it('never yields a path that the URL parser would retarget', () => {
    for (const path of ['/courses/1/pages/%2e%2e/assignments/5', '/a/%2e/b', '/a/../b', '/a/.%2E/b']) {
      expect(() => rawCanvasPath(path)).toThrow(CanvasPathError);
    }
  });
});

describe('canvasId', () => {
  it.each([
    [123, '123'],
    ['123', '123'],
    [' 123 ', '123'],
    ['0', '0'],
    [0, '0'],
    ['007', '007'],
    [123n, '123'],
    ['12345678901234567890', '12345678901234567890'],
  ])('accepts %s', (good, expected) => {
    expect(canvasId(good)).toBe(expected);
  });

  it.each([
    '123/submissions/456?',
    '123/submissions/456#',
    '123%2Fsubmissions%2F456',
    '../../users/2',
    '123 456',
    '',
    '   ',
    'abc',
    '12.3',
    '-1',
    '+1',
    '1e3',
    '0x10',
    'sis_assignment_id:x',
    '١٢٣', // non-ASCII digits
    '１２３', // full-width digits
    '123\n456',
    'self',
  ])('rejects the string %j', (bad) => {
    expect(() => canvasId(bad)).toThrow(CanvasPathError);
  });

  it.each([
    [-1],
    [12.3],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [2 ** 53],
    [1e21],
    [-5n],
    [null],
    [undefined],
    [true],
    [{}],
    [[]],
    [['1']],
  ])(
    'rejects the non-id value %s',
    (bad) => {
      expect(() => canvasId(bad)).toThrow(CanvasPathError);
    },
  );

  it('produces a value canvasPath passes through unchanged', () => {
    expect(canvasPath`/courses/${canvasId(' 42 ')}/assignments/${canvasId(7)}`).toBe('/courses/42/assignments/7');
  });
});

describe('isPinnedPageUrl', () => {
  const pathname = '/api/v1/courses';
  const root = `${BASE}/courses`;

  it.each([
    `${root}?page=2&per_page=100`,
    `${root}?cursor=a%2Bb,c&include[]=a&include[]=b`,
    `${root}`,
    'https://canvas.example.com:443/api/v1/courses?page=2',
    'HTTPS://CANVAS.EXAMPLE.COM/api/v1/courses?page=2',
  ])('accepts %s', (next) => {
    expect(isPinnedPageUrl(next, BASE, pathname)).toBe(true);
  });

  // The unsafe next links of pagination-control-plane.test.ts.
  it.each([
    'https://other.example/api/v1/courses?p=2',
    'https://canvas.example.com/api/v1/users?p=2',
    'https://user:pass@canvas.example.com/api/v1/courses?p=2',
    'https://user@canvas.example.com/api/v1/courses?p=2',
    `${root}?p=2#fragment`,
    `${root}?p=2#`,
    'http://canvas.example.com/api/v1/courses?p=2',
    'https://canvas.example.com:8443/api/v1/courses?p=2',
    'https://canvas.example.com.evil.example/api/v1/courses?p=2',
    'https://canvas.example.com/api/v1/courses/?p=2',
    'https://canvas.example.com/api/v1/courses/1?p=2',
    'https://canvas.example.com/api/v1/courses/%2e%2e/users?p=2',
    'https://canvas.example.com/api/v1/Courses?p=2',
    '/api/v1/courses?p=2',
    '?p=2',
    '//canvas.example.com/api/v1/courses?p=2',
    'javascript:alert(1)',
    '',
  ])('rejects %j', (next) => {
    expect(isPinnedPageUrl(next, BASE, pathname)).toBe(false);
  });

  it('refuses every next link when the base is http', () => {
    expect(isPinnedPageUrl('http://127.0.0.1:8080/api/v1/courses?p=2', 'http://127.0.0.1:8080/api/v1', pathname)).toBe(false);
    expect(isPinnedPageUrl('https://127.0.0.1:8080/api/v1/courses?p=2', 'http://127.0.0.1:8080/api/v1', pathname)).toBe(false);
  });

  it('rejects everything for an unusable base', () => {
    expect(isPinnedPageUrl(`${root}?p=2`, 'not a url', pathname)).toBe(false);
  });

  it('pins to the pathname of the resolved first page', () => {
    const first = resolveCanvasUrl(BASE, canvasPath`/courses/${1}/pages/${'a/b'}`) as URL;
    expect(isPinnedPageUrl(`${first.href}?page=2`, BASE, first.pathname)).toBe(true);
    expect(isPinnedPageUrl(`${BASE}/courses/1/pages/a/b?page=2`, BASE, first.pathname)).toBe(false);
  });
});

describe('apiRelativePath', () => {
  it('strips the API base prefix from the requested URL', () => {
    expect(apiRelativePath(new URL(`${BASE}/courses/1/pages/a%2Fb?x=1`), BASE)).toBe('/courses/1/pages/a%2Fb');
    expect(apiRelativePath(new URL(`${BASE}/users/self`), `${BASE}/`)).toBe('/users/self');
    expect(apiRelativePath(new URL(BASE), BASE)).toBe('/');
  });

  it('reports the path Canvas will actually serve, not the template', () => {
    // If a retargeted URL ever got this far, the tier must be chosen from where it points.
    const retargeted = new URL(`${BASE}/courses/1/pages/%2e%2e/assignments/2/submissions/456`);
    expect(apiRelativePath(retargeted, BASE)).toBe('/courses/1/assignments/2/submissions/456');
  });

  it('keeps the full pathname when the URL is outside the base', () => {
    expect(apiRelativePath(new URL('https://canvas.example.com/api/v10/users/self'), BASE)).toBe('/api/v10/users/self');
    expect(apiRelativePath(new URL('https://canvas.example.com/login'), BASE)).toBe('/login');
    expect(apiRelativePath(new URL('https://other.example/api/v1/users/self'), BASE)).toBe('/api/v1/users/self');
    expect(apiRelativePath(new URL(`${BASE}/users/self`), 'not a url')).toBe('/api/v1/users/self');
  });

  it('handles a base at the origin root', () => {
    expect(apiRelativePath(new URL('https://canvas.example.com/courses/1'), 'https://canvas.example.com')).toBe('/courses/1');
  });
});
