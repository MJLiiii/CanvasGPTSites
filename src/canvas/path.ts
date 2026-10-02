// Ports the endpoint guards of canvas_mcp/core/client.py (make_canvas_request) and
// coerce_canvas_id from canvas_mcp/core/validation.py, hardened per security review finding 1.
import type { CanvasPath } from '../types';

/** A path or identifier that must never reach Canvas. Messages never echo the offending value. */
export class CanvasPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasPathError';
  }
}

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// The WHATWG URL parser treats every one of these spellings as "." or ".." and removes it.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const SINGLE_DOT_SEGMENT = /^(?:\.|%2e)$/i;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
// RFC 3986 path characters. `encodeURIComponent` output is a subset, and the
// URL parser leaves all of them untouched, so parsed and built paths can match.
const PATH_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const NUMERIC_CANVAS_ID = /^[0-9]+$/;

function refuse(what: string): never {
  throw new CanvasPathError(`Invalid endpoint: ${what} is not allowed in a request path`);
}

function encodeSegment(value: unknown): string {
  let text: string;
  if (typeof value === 'number') {
    // A fractional, negative or precision-losing number is a caller bug, and
    // its string form would address some other object.
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse('a number that is not a non-negative safe integer');
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    refuse('a value that is not a string or number');
  }
  if (text === '') refuse('an empty path segment');
  if (text === '.' || text === '..') refuse(`'${text}'`);
  if (CONTROL_CHARACTER.test(text)) refuse('a control character');
  try {
    return encodeURIComponent(text);
  } catch {
    // encodeURIComponent throws URIError on a lone surrogate.
    refuse('malformed Unicode');
  }
}

/** Checks on the assembled path, so literal text cannot smuggle what values cannot. */
function checkAssembled(path: string): void {
  if (!path.startsWith('/')) {
    throw new CanvasPathError("Invalid endpoint: a request path must start with '/'");
  }
  for (const delimiter of ['?', '#', '\\']) {
    if (path.includes(delimiter)) refuse(`'${delimiter}'`);
  }
  if (CONTROL_CHARACTER.test(path)) refuse('a control character');
  if (!PATH_CHARACTERS.test(path)) refuse('an unencoded character');
  if (MALFORMED_ESCAPE.test(path)) refuse('a malformed percent-escape');
  if (path.includes('//')) refuse('an empty path segment');
  for (const segment of path.split('/')) {
    if (DOT_SEGMENT.test(segment)) {
      refuse(SINGLE_DOT_SEGMENT.test(segment) ? "'.'" : "'..'");
    }
  }
}

/**
 * The only way to build a Canvas API path.
 *
 *   canvasPath`/courses/${courseId}/pages/${slug}`
 *
 * Literal parts are trusted static text. Every interpolated value is validated
 * and percent-encoded, so it always stays exactly one path segment: a value
 * such as `x/%2e%2e/assignments/5` becomes `x%2F%252e%252e%2Fassignments%2F5`.
 */
export function canvasPath(strings: TemplateStringsArray, ...values: Array<string | number>): CanvasPath {
  // Refuse a plain-function call with a hand-built string: that is concatenation.
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || strings.length !== values.length + 1) {
    throw new CanvasPathError('Invalid endpoint: canvasPath must be used as a template tag');
  }
  let path = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    path += encodeSegment(values[i]) + (strings[i + 1] ?? '');
  }
  checkAssembled(path);
  return path as CanvasPath;
}

/**
 * Brand a complete, ALREADY-ENCODED path from a trusted source (a constant, a
 * path recovered from a signed cursor). It encodes nothing, so never use it to
 * join identifiers; that is what `canvasPath` is for.
 */
export function rawCanvasPath(path: string): CanvasPath {
  if (typeof path !== 'string') {
    throw new CanvasPathError('Invalid endpoint: a request path must be a string');
  }
  checkAssembled(path);
  return path as CanvasPath;
}

/**
 * Canonical digit string of a Canvas object id, from its number or string form.
 * Canvas ids are plain ASCII digits; anything else is rejected, not sanitized.
 * Surrounding whitespace is stripped, as upstream does.
 */
export function canvasId(value: unknown): string {
  let text: string | null = null;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (typeof value === 'bigint') {
    text = String(value);
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    // Above 2^53 a number no longer identifies the object the caller meant.
    text = String(value);
  }
  if (text === null || !NUMERIC_CANVAS_ID.test(text)) {
    throw new CanvasPathError('Invalid Canvas ID: expected a numeric ID');
  }
  return text;
}

interface ApiBase {
  origin: string;
  /** Base pathname without a trailing slash, e.g. `/api/v1`. */
  pathname: string;
}

function parseApiBase(apiBaseUrl: string): ApiBase | null {
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  // https only: every request built on this base carries the Canvas token.
  if (base.protocol !== 'https:') return null;
  if (base.username || base.password || base.search || base.href.includes('#')) return null;
  return { origin: base.origin, pathname: base.pathname.replace(/\/+$/, '') };
}

/**
 * The request URL for `path`, or null when the parsed URL is not exactly the
 * API base plus the built path. `new URL()` resolves encoded dot segments
 * (`/pages/%2e%2e/assignments/5` becomes `/assignments/5`), so comparing the
 * parsed pathname with the built one is what proves the request was not
 * retargeted. A null result must be reported as `not_dispatched`.
 */
export function resolveCanvasUrl(apiBaseUrl: string, path: CanvasPath): URL | null {
  const base = parseApiBase(apiBaseUrl);
  if (base === null || typeof path !== 'string' || !path.startsWith('/')) return null;
  const expectedPathname = base.pathname + path;
  let url: URL;
  try {
    url = new URL(base.origin + expectedPathname);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.pathname !== expectedPathname) return null;
  if (url.username || url.password || url.search || url.href.includes('#')) return null;
  return url;
}

/**
 * Whether a pagination `next` link may be followed with credentials: absolute
 * https, same origin as the API base, same pathname as the page before it, no
 * userinfo and no fragment (not even an empty one). The query is opaque.
 */
export function isPinnedPageUrl(next: string, apiBaseUrl: string, expectedPathname: string): boolean {
  const base = parseApiBase(apiBaseUrl);
  if (base === null || typeof next !== 'string') return false;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.origin === base.origin &&
    url.pathname === expectedPathname &&
    url.username === '' &&
    url.password === '' &&
    !url.href.includes('#')
  );
}

/**
 * Pathname of the URL actually requested, with the API base prefix removed
 * (`/courses/1/pages/x`). The anonymization tier is chosen from this, never
 * from the template. A URL outside the base keeps its full pathname, which
 * matches no self-only exemption and so can only raise the tier.
 */
export function apiRelativePath(url: URL, apiBaseUrl: string): string {
  const base = parseApiBase(apiBaseUrl);
  if (base === null || url.origin !== base.origin) return url.pathname;
  if (base.pathname === '') return url.pathname;
  if (url.pathname === base.pathname) return '/';
  if (!url.pathname.startsWith(`${base.pathname}/`)) return url.pathname;
  return url.pathname.slice(base.pathname.length);
}
