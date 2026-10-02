// Ports the streamed download of canvas_mcp/tools/files.py (read_course_file), with redirects
// followed by hand so Authorization never crosses origins (security review finding 13).
import type { DownloadedFile, RequestFailure, WriteOutcome } from '../types';
import { NO_WRITE_STATUSES, isFailure, makeFailure, notDispatched } from './errors';

/** Redirects followed after the first request (hop 0). */
export const MAX_DOWNLOAD_REDIRECTS = 3;

/** Start of the failure text when a file is over `maxBytes`; see `isFileTooLarge`. */
export const FILE_TOO_LARGE_ERROR = 'File exceeds the download size limit';

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * What the download needs from the Canvas client. The client keeps the token:
 * this module only decides, per hop, whether Authorization may be attached.
 */
export interface DownloadTransport {
  /** Origin every request is pinned to, or null when the API base is unusable. */
  readonly canvasOrigin: string | null;
  /**
   * One GET with `redirect: 'manual'`, costing one budget slot. `withAuth`
   * asks for the Authorization header; the client still refuses to attach it
   * to a URL outside the Canvas origin.
   */
  send(url: URL, withAuth: boolean): Promise<Response | RequestFailure>;
  /** Turn an error thrown while reading the body into a sanitized failure. */
  failure(error: unknown): RequestFailure;
}

export function isFileTooLarge(failure: RequestFailure): boolean {
  return failure.error.startsWith(FILE_TOO_LARGE_ERROR);
}

function tooLarge(maxBytes: number): RequestFailure {
  return notDispatched(`${FILE_TOO_LARGE_ERROR} of ${maxBytes} bytes`);
}

function isHttpsWithoutCredentials(url: URL): boolean {
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is unwanted; failing to cancel it changes nothing.
  }
}

function statusFailure(status: number): RequestFailure {
  const outcome: WriteOutcome = NO_WRITE_STATUSES.has(status) ? 'rejected' : 'may_have_written';
  // The body is left out: after a redirect it comes from a third-party host.
  return makeFailure(`HTTP error: ${status}`, outcome, { status });
}

async function readBody(
  response: Response,
  maxBytes: number,
  transport: DownloadTransport,
): Promise<DownloadedFile | RequestFailure> {
  const declared = response.headers.get('Content-Length')?.trim();
  if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    await discardBody(response);
    return tooLarge(maxBytes);
  }
  const contentType = response.headers.get('Content-Type') ?? DEFAULT_CONTENT_TYPE;
  if (response.body === null) {
    return { bytes: new Uint8Array(0), contentType };
  }

  // Content-Length can be absent or wrong, so the bytes are counted as they arrive.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already over the limit; the stream is abandoned either way.
        }
        return tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    return transport.failure(error);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}

/**
 * Download a Canvas file URL into memory.
 *
 * Hop 0 must be on the Canvas origin and carries Authorization. Redirects are
 * followed by hand, https only. The first hop that leaves the Canvas origin
 * drops Authorization for good: a later redirect back to Canvas is requested
 * without it, because an untrusted host chose that URL.
 */
export async function downloadFile(
  fileUrl: string,
  options: { maxBytes: number },
  transport: DownloadTransport,
): Promise<DownloadedFile | RequestFailure> {
  const maxBytes = options.maxBytes;
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return notDispatched('Invalid download size limit');
  }

  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    return notDispatched('Invalid file URL');
  }
  if (transport.canvasOrigin === null || url.origin !== transport.canvasOrigin || !isHttpsWithoutCredentials(url)) {
    return notDispatched('File URL is not on the Canvas origin; the download was not attempted');
  }

  let authAllowed = true;
  for (let redirects = 0; ; redirects++) {
    const response = await transport.send(url, authAllowed);
    if (isFailure(response)) return response;

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status < 200 || response.status > 299) {
        await discardBody(response);
        return statusFailure(response.status);
      }
      return readBody(response, maxBytes, transport);
    }

    await discardBody(response);
    const location = response.headers.get('Location');
    if (location === null || location.trim() === '') {
      return notDispatched('Redirect without Location header');
    }
    if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
      return notDispatched(`Too many redirects: the download stopped after ${MAX_DOWNLOAD_REDIRECTS}`);
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return notDispatched('Invalid redirect location');
    }
    if (!isHttpsWithoutCredentials(next)) {
      return notDispatched('Redirect to a location that is not plain https was refused');
    }
    if (next.origin !== transport.canvasOrigin) {
      authAllowed = false;
    }
    url = next;
  }
}
