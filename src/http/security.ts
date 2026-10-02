// Ports the request bounds of canvas-mcp src/canvas_mcp/server.py (_declared_content_length, _read_body) and adds
// the checks a browser-reachable Worker needs: Host allowlist, no browser on /mcp, security headers.
import type { Config } from '../types';

/**
 * Body cap for a request no authorized identity stands behind. Enough for any
 * discovery message, far too little to be a memory-pressure lever.
 */
export const ANONYMOUS_BODY_LIMIT_BYTES = 64 * 1024;

export const STATUS_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** Headers of every HTML response. The page has no script, no frame and nothing a cache may keep. */
export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': STATUS_PAGE_CSP,
  'X-Frame-Options': 'DENY',
  // no-referrer turns an HTML form POST's Origin into null in browsers,
  // preventing the owner's same-origin token check. External referrers stay hidden.
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/** Headers of every non-HTML response this app builds itself. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

function stripPort(host: string): string {
  // An IPv6 literal keeps its brackets; only a trailing :port is removed.
  return host.replace(/:[0-9]+$/, '');
}

/** The host the request was addressed to, lowercased: the Host header, else the URL's host. */
export function requestHost(request: Request): string {
  const header = request.headers.get('host');
  if (header !== null && header.trim() !== '') {
    return header.trim().toLowerCase();
  }
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when ALLOWED_HOSTS is empty or names the request's host. An entry
 * matches with or without the port.
 */
export function isAllowedHost(request: Request, config: Pick<Config, 'allowedHosts'>): boolean {
  if (config.allowedHosts.length === 0) return true;
  const host = requestHost(request);
  if (host === '') return false;
  const bare = stripPort(host);
  return config.allowedHosts.some((allowed) => allowed === host || allowed === bare);
}

/**
 * The name of the first header that marks a request as coming from a browser
 * (`Origin` or any `Sec-Fetch-*`), or null. The plugin calls /mcp server to
 * server and sends neither, so on that path their presence alone is refused:
 * script on any origin, this Site's included, must not become an MCP client.
 */
export function browserRequestMarker(headers: Headers): string | null {
  if (headers.has('origin')) return 'origin';
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith('sec-fetch-')) return name.toLowerCase();
  }
  return null;
}

/**
 * True when the request carries an `Origin` header naming the request's own
 * origin. A missing header is not same-origin: the caller must prove it.
 */
export function hasSameOriginHeader(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '' || origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (origin === url.origin) return true;
  // Behind a gateway the URL may name an internal host while Host names the Site.
  return origin.toLowerCase() === `${url.protocol}//${requestHost(request)}`;
}

/** Parse Content-Length, or null if absent or unparseable. */
export function declaredContentLength(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null || !/^[0-9]+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'unreadable' };

/**
 * Read a request body as UTF-8 text, refusing bodies over `maxBytes`.
 *
 * The check runs per chunk rather than on the assembled body, so an oversized
 * or chunked upload (which has no Content-Length to refuse up front) is
 * abandoned while it streams instead of being buffered first.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = declaredContentLength(request.headers);
  if (declared !== null && declared > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  if (request.body === null) {
    return { ok: true, text: '' };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'unreadable' };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text };
}

/** The body cap for a request: the configured limit for an authorized caller, 64 KiB at most for anyone else. */
export function bodyLimitFor(authorized: boolean, config: Pick<Config, 'maxRequestBytes'>): number {
  return authorized ? config.maxRequestBytes : Math.min(ANONYMOUS_BODY_LIMIT_BYTES, config.maxRequestBytes);
}

/**
 * The response with a 401 turned into a 403 and any challenge header removed.
 * The Sites gateway owns OAuth; a 401 or `WWW-Authenticate` from this Worker
 * would send the client into an authorization discovery this app cannot answer.
 */
export function withoutAuthChallenge(response: Response): Response {
  if (response.status !== 401 && !response.headers.has('www-authenticate')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete('www-authenticate');
  return new Response(response.body, { status: response.status === 401 ? 403 : response.status, headers });
}
