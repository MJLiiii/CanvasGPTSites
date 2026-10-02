// Ports canvas_mcp/core/client.py (make_canvas_request, fetch_all_paginated_results), hardened
// per docs/design/architecture-detail.md section 5 and docs/design/review-findings.md.
import { anonymizeResponse } from '../core/anonymization';
import { maxTier, tierForPath } from '../core/anonymization-tiers';
import { dataAccessFields, redactSecrets, sanitizeUrl } from '../core/logging';
import type {
  AnonymizationTier,
  BudgetView,
  CallerInfo,
  CanvasClient,
  CanvasCredential,
  CanvasPath,
  Config,
  DownloadedFile,
  FormBody,
  Logger,
  PageOptions,
  Paged,
  Params,
  RequestFailure,
  RequestOptions,
  TruncationReason,
  TruncationRecord,
} from '../types';
import { USER_AGENT } from '../version';
import type { SubrequestMeter } from './budget';
import { createCourseResolver } from './course-resolver';
import { buildFormBody, buildQuery } from './encode';
import { httpFailure, isThrottled, makeFailure, notDispatched, pythonRepr, requestFailed } from './errors';
import { downloadFile } from './files';
import { createLimiter } from './limiter';
import { PaginationLinkError, nextPageUrl } from './link-header';
import { apiRelativePath, isPinnedPageUrl, rawCanvasPath, resolveCanvasUrl } from './path';
import { NARROW_REQUEST_HINT, TRUNCATION_REASON_TEXT } from './truncation';

/** What a Canvas client is built from. One per tool call; nothing in it outlives the call. */
export interface CanvasClientDeps {
  credential: CanvasCredential;
  config: Config;
  meter: SubrequestMeter;
  /** Epoch ms after which no new request is started. */
  deadline: number;
  log: Logger;
  /** Whether this tool call may read Canvas with anonymization off. */
  allowRaw: boolean;
  pseudonymSalt: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `createCanvasClient`, as the layers that are handed it see it. */
export type CanvasClientFactory = (deps: CanvasClientDeps) => CanvasClient;

/** Default number of results per page for paginated requests. */
export const DEFAULT_PAGE_SIZE = 100;

export const DEFAULT_TRUNCATION_HINT = NARROW_REQUEST_HINT;

const THROTTLE_RETRIES = 2;
const THROTTLE_BACKOFF_MS: readonly number[] = [1000, 2000];
const THROTTLE_JITTER_MS = 250;
/** A throttle wait must end at least this long before the deadline. */
const DEADLINE_MARGIN_MS = 2000;
const DEADLINE_SLACK_MS = 5;
const TRANSIENT_RETRIES = 1;
const TRANSIENT_WAIT_MS = 500;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Below this many `X-Rate-Limit-Remaining` units the client stops running requests in parallel. */
const SLOWDOWN_BELOW = 150;
/** Below this many units pagination stops rather than spend the caller's last quota. */
const STOP_PAGINATION_BELOW = 50;

const MAX_ERROR_BODY_CHARS = 16384;
const MAX_ERROR_MESSAGE_CHARS = 200;

const INVALID_PATH_ERROR = 'Invalid endpoint: the request path does not resolve under the Canvas API base';
const RAW_ACCESS_ERROR = 'Raw Canvas access refused: this tool may not turn anonymization off';
const DEADLINE_ERROR = 'Tool deadline reached: the Canvas request was not sent';
const PAGINATION_PINNED_ERROR = 'Invalid pagination link: origin or endpoint changed';
const PAGINATION_CYCLE_ERROR = 'Pagination cycle detected; no partial result returned';
const PAGINATION_SHAPE_ERROR = 'Invalid paginated response: expected a list';

const ORIGIN_PROBE = rawCanvasPath('/courses');
/** What a failed file download is logged under, whichever host the failing hop was on. */
const DOWNLOAD_LOG_ENDPOINT = '/files';

type Verb = 'get' | 'post' | 'put' | 'delete';
const VERBS: ReadonlySet<string> = new Set<Verb>(['get', 'post', 'put', 'delete']);

interface Exchange {
  ok: true;
  data: unknown;
  status: number;
  link: string | null;
  rateRemaining: number | null;
}

interface FailedExchange {
  ok: false;
  failure: RequestFailure;
  retry: 'throttle' | 'transient' | null;
  retryAfterMs: number | null;
  /** The request was held back, or cut short, by the tool deadline. */
  deadlineHit: boolean;
}

interface Dispatch {
  verb: Verb;
  url: URL;
  /** API-relative pathname of `url`, for logs and the anonymization tier. */
  relative: string;
  body?: string | FormData;
  contentType?: string;
  useReserved: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rateLimitRemaining(headers: Headers): number | null {
  const raw = headers.get('X-Rate-Limit-Remaining')?.trim();
  if (!raw || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(raw)) return null;
  return Number(raw);
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After')?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  return Number(raw) * 1000;
}

/**
 * The text upstream reports for a 2xx body that is not JSON: Python's
 * JSONDecodeError for a document with no value at its start (an empty body,
 * an HTML page). Anything that fails deeper inside gets a generic message,
 * and never the parser's own, because V8 quotes the body in it.
 */
function invalidJsonMessage(text: string): string {
  const position = /^[ \t\n\r]*/.exec(text)?.[0].length ?? 0;
  const first = text.charAt(position);
  if (first !== '' && /[[{"\-0-9tfnNI]/.test(first)) {
    return 'response body is not valid JSON';
  }
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return `Expecting value: line ${line} column ${column} (char ${position})`;
}

const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()[\]]+/gi;

export function createCanvasClient(deps: CanvasClientDeps): CanvasClient {
  const { config, meter, log } = deps;
  // The credential is read once into this closure. Nothing below copies the
  // token into a returned value, an error or a log field.
  const token = deps.credential.token;
  const apiBaseUrl = deps.credential.apiBaseUrl;
  const authorization = `Bearer ${token}`;
  const caller: CallerInfo = Object.freeze({
    origin: deps.credential.origin,
    callerId: deps.credential.callerId,
    kind: deps.credential.kind,
  });

  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const limiter = createLimiter(config.maxConcurrentRequests);
  const pseudonymMemo = new Map<string, string>();
  const truncations: TruncationRecord[] = [];
  const truncationOf = new WeakMap<object, TruncationRecord>();
  let slowedDown = false;

  // The origin downloads are pinned to. It comes from the same base URL that
  // resolveCanvasUrl pins API requests to, and a base that function would
  // refuse yields no origin at all.
  const canvasOrigin = resolveCanvasUrl(apiBaseUrl, ORIGIN_PROBE)?.origin ?? null;

  // ---- failures -----------------------------------------------------------

  function scrub(text: string): string {
    return redactSecrets(text, [token]);
  }

  function budgetFailure(): RequestFailure {
    return notDispatched(
      `Request budget exhausted: this tool call may make at most ${meter.limit} Canvas and storage ` +
        'requests, so the Canvas request was not sent',
      { budgetExhausted: true },
    );
  }

  function describeError(error: unknown): { name: string; message: string; timedOut: boolean } {
    // Duck-typed: a DOMException is not an Error subclass on every runtime.
    const thrown = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown; message?: unknown };
    const name = typeof thrown.name === 'string' && thrown.name !== '' ? thrown.name : 'Error';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const raw = typeof thrown.message === 'string' ? thrown.message : '';
    // An exception message can quote the request URL. Keep only its scheme,
    // host and path: the query is where verifiers and tokens travel.
    const message = scrub(raw.replace(URL_IN_TEXT, (url) => sanitizeUrl(url))).slice(0, MAX_ERROR_MESSAGE_CHARS);
    return { name: scrub(name), message, timedOut };
  }

  function transportFailure(error: unknown, method: string, relative: string): FailedExchange {
    const described = describeError(error);
    const endpoint = sanitizeUrl(relative);
    log.error('canvas_request_failed', {
      method: method.toUpperCase(),
      endpoint,
      error_type: described.name,
      detail: described.message,
    });
    if (config.logAccessEvents) {
      log.info('data_access', dataAccessFields(method, relative, 'error', described.name));
    }
    const text = described.timedOut
      ? 'the request timed out'
      : described.message === ''
        ? described.name
        : `${described.name}: ${described.message}`;
    return {
      ok: false,
      failure: requestFailed(text),
      retry: 'transient',
      retryAfterMs: null,
      // Timers may fire a few milliseconds early.
      deadlineHit: described.timedOut && now() >= deps.deadline - DEADLINE_SLACK_MS,
    };
  }

  // ---- one outbound request -----------------------------------------------

  function noteRateLimit(remaining: number | null): void {
    if (remaining === null || remaining >= SLOWDOWN_BELOW || slowedDown) return;
    slowedDown = true;
    limiter.setMax(1);
    log.warn('canvas_rate_limit_low', { remaining: Math.floor(remaining) });
  }

  function headersFor(contentType: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (contentType !== undefined) headers['Content-Type'] = contentType;
    return headers;
  }

  /** Budget and deadline gate shared by every outbound fetch. Returns the timeout to use, or the refusal. */
  function admit(useReserved: boolean): number | RequestFailure {
    const timeLeft = deps.deadline - now();
    if (!(timeLeft > 0)) return notDispatched(DEADLINE_ERROR);
    const granted = useReserved ? meter.takeReserved('canvas') : meter.take('canvas');
    if (!granted) return budgetFailure();
    return Math.max(1, Math.min(config.apiTimeoutMs, timeLeft));
  }

  async function sendOnce(dispatch: Dispatch, attempt: number): Promise<Exchange | FailedExchange> {
    const endpoint = sanitizeUrl(dispatch.relative);
    const timeoutMs = admit(dispatch.useReserved);
    if (typeof timeoutMs !== 'number') {
      const deadlineHit = timeoutMs.budgetExhausted !== true;
      log.warn('canvas_request_not_sent', {
        method: dispatch.verb.toUpperCase(),
        endpoint,
        reason: deadlineHit ? 'deadline' : 'budget',
      });
      return { ok: false, failure: timeoutMs, retry: null, retryAfterMs: null, deadlineHit };
    }

    log.debug('canvas_request', { method: dispatch.verb.toUpperCase(), endpoint, retry: attempt });

    let status: number;
    let headers: Headers;
    let text: string;
    try {
      const response = await fetchImpl(dispatch.url.href, {
        method: dispatch.verb.toUpperCase(),
        headers: headersFor(dispatch.contentType),
        body: dispatch.body,
        // A followed redirect would carry Authorization to wherever Canvas
        // (or anything answering for it) points.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      headers = response.headers;
      text = await response.text();
      // Browsers hide a manual redirect behind status 0.
      if (status === 0 && (response.type as string) === 'opaqueredirect') status = 302;
    } catch (error) {
      return transportFailure(error, dispatch.verb, dispatch.relative);
    }

    const rateRemaining = rateLimitRemaining(headers);
    noteRateLimit(rateRemaining);

    if (status >= 200 && status <= 299) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        log.error('canvas_request_failed', {
          method: dispatch.verb.toUpperCase(),
          endpoint,
          error_type: 'JSONDecodeError',
        });
        if (config.logAccessEvents) {
          log.info('data_access', dataAccessFields(dispatch.verb, dispatch.relative, 'error', 'JSONDecodeError'));
        }
        return {
          ok: false,
          failure: requestFailed(invalidJsonMessage(text), { status }),
          retry: null,
          retryAfterMs: null,
          deadlineHit: false,
        };
      }
      if (config.logAccessEvents) {
        log.info('data_access', dataAccessFields(dispatch.verb, dispatch.relative, 'success'));
      }
      return { ok: true, data, status, link: headers.get('Link'), rateRemaining };
    }

    const throttled = isThrottled(status, text, headers);
    const body =
      text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}... [truncated]` : text;
    const failure = httpFailure(status, body, throttled ? { throttled: true } : undefined);
    failure.error = scrub(failure.error);
    // Status code only: the response body may contain PII.
    log.error('canvas_api_error', { method: dispatch.verb.toUpperCase(), endpoint, status_code: status, throttled });
    if (config.logAccessEvents) {
      log.info('data_access', dataAccessFields(dispatch.verb, dispatch.relative, 'error', `HTTP ${status}`));
    }
    return {
      ok: false,
      failure,
      retry: throttled ? 'throttle' : TRANSIENT_STATUSES.has(status) ? 'transient' : null,
      retryAfterMs: retryAfterMs(headers),
      deadlineHit: false,
    };
  }

  /**
   * Send with the retry policy. Only GET is ever repeated: a write may have
   * been applied before the error arrived, and repeating it can duplicate it.
   */
  async function execute(dispatch: Dispatch): Promise<Exchange | FailedExchange> {
    let throttleRetries = 0;
    let transientRetries = 0;
    for (let attempt = 0; ; attempt++) {
      const result = await limiter.run(() => sendOnce(dispatch, attempt));
      if (result.ok || dispatch.verb !== 'get' || result.retry === null) return result;

      let waitMs: number;
      if (result.retry === 'throttle') {
        if (throttleRetries >= THROTTLE_RETRIES) return result;
        const base = result.retryAfterMs ?? THROTTLE_BACKOFF_MS[throttleRetries] ?? 2000;
        waitMs = base + Math.floor(Math.random() * THROTTLE_JITTER_MS);
        if (now() + waitMs > deps.deadline - DEADLINE_MARGIN_MS) return result;
        throttleRetries++;
      } else {
        if (transientRetries >= TRANSIENT_RETRIES) return result;
        waitMs = TRANSIENT_WAIT_MS;
        if (now() + waitMs >= deps.deadline) return result;
        transientRetries++;
      }
      // A retry costs a budget slot like any other request.
      if (meter.remaining + (dispatch.useReserved ? meter.reserved : 0) < 1) return result;
      log.warn('canvas_request_retry', {
        endpoint: sanitizeUrl(dispatch.relative),
        reason: result.retry,
        wait_ms: waitMs,
        attempt: attempt + 1,
      });
      await sleep(waitMs);
    }
  }

  // ---- anonymization ------------------------------------------------------

  function refuseRaw(skipAnonymization: boolean | undefined, relative: string): RequestFailure | null {
    if (!skipAnonymization || deps.allowRaw) return null;
    log.security('canvas_raw_access_refused', { endpoint: sanitizeUrl(relative) });
    return notDispatched(RAW_ACCESS_ERROR);
  }

  /** `relative` is the pathname actually requested, never a template. */
  function anonymize<T>(data: T, relative: string, forceTier: AnonymizationTier | undefined): T {
    if (!config.anonymizationEnabled) return data;
    const tier = maxTier(tierForPath(relative), forceTier ?? 'none');
    if (tier === 'none') return data;
    log.debug('canvas_anonymization_applied', { endpoint: sanitizeUrl(relative), tier });
    return anonymizeResponse(data, { tier, path: relative, salt: deps.pseudonymSalt, memo: pseudonymMemo });
  }

  function blockedPath(): RequestFailure {
    log.warn('canvas_request_blocked', { reason: 'path' });
    return notDispatched(INVALID_PATH_ERROR);
  }

  // ---- request ------------------------------------------------------------

  async function request<T = unknown>(
    method: Verb,
    path: CanvasPath,
    options: RequestOptions = {},
  ): Promise<T | RequestFailure> {
    const verb = String(method).toLowerCase();
    if (!VERBS.has(verb)) return notDispatched(`Unsupported method: ${String(method).slice(0, 20)}`);

    const resolved = resolveCanvasUrl(apiBaseUrl, path);
    if (resolved === null) return blockedPath();
    const relative = apiRelativePath(resolved, apiBaseUrl);

    const refused = refuseRaw(options.skipAnonymization, relative);
    if (refused !== null) return refused;

    const dispatch: Dispatch = {
      verb: verb as Verb,
      url: resolved,
      relative,
      useReserved: verb !== 'get' || options.useReserved === true,
    };

    if (verb === 'get' || verb === 'delete') {
      if ((options.data !== undefined && options.data !== null) || options.multipart !== undefined) {
        return notDispatched(`Unsupported request: a ${verb.toUpperCase()} cannot carry a body`);
      }
      const query = buildQuery(options.params);
      if (query !== '') {
        const withQuery = new URL(`${resolved.href}?${query}`);
        if (withQuery.origin !== resolved.origin || withQuery.pathname !== resolved.pathname) return blockedPath();
        dispatch.url = withQuery;
      }
    } else {
      if (options.params !== undefined && buildQuery(options.params) !== '') {
        return notDispatched(`Unsupported request: query params are not sent with ${verb.toUpperCase()}`);
      }
      if (options.multipart !== undefined) {
        // fetch writes the multipart Content-Type itself, boundary included.
        dispatch.body = options.multipart;
      } else if (options.data !== undefined && options.data !== null) {
        if (options.useFormData) {
          if (typeof options.data !== 'object') {
            return notDispatched('Unsupported request: form data must be an object or a list of pairs');
          }
          dispatch.body = buildFormBody(options.data as FormBody).toString();
          dispatch.contentType = 'application/x-www-form-urlencoded';
        } else {
          let json: string | undefined;
          try {
            json = JSON.stringify(options.data);
          } catch {
            json = undefined;
          }
          if (json === undefined) return notDispatched('Unsupported request: the body cannot be encoded as JSON');
          dispatch.body = json;
          dispatch.contentType = 'application/json';
        }
      }
    }

    const exchange = await execute(dispatch);
    if (!exchange.ok) return exchange.failure;

    if (verb === 'get') seedCourses(relative, exchange.data);
    const data = options.skipAnonymization ? exchange.data : anonymize(exchange.data, relative, options.forceTier);

    // Upstream tools treat any response with a top-level "error" key as a
    // failure, whatever the status. The request did reach Canvas.
    if (isRecord(data) && Object.hasOwn(data, 'error')) {
      const detail = typeof data.error === 'string' ? data.error : pythonRepr(data.error);
      return makeFailure(scrub(detail), 'may_have_written', { status: exchange.status });
    }
    return data as T;
  }

  // ---- pagination ---------------------------------------------------------

  async function fetchAllPages<T>(
    path: CanvasPath,
    params: Params | undefined,
    options: PageOptions,
    record: boolean,
  ): Promise<Paged<T> | RequestFailure> {
    const label = options.label ?? 'items';
    const first = resolveCanvasUrl(apiBaseUrl, path);
    if (first === null) return blockedPath();
    const relative = apiRelativePath(first, apiBaseUrl);

    const refused = refuseRaw(options.skipAnonymization, relative);
    if (refused !== null) return refused;

    const maxPages =
      typeof options.maxPages === 'number' && options.maxPages >= 1 ? Math.floor(options.maxPages) : config.maxPages;
    const maxItems =
      typeof options.maxItems === 'number' && options.maxItems >= 1 ? Math.floor(options.maxItems) : null;

    // Each traversal owns its query and cursor; the caller's params are not modified.
    const query = buildQuery({ ...params, per_page: params?.per_page ?? DEFAULT_PAGE_SIZE, page: 1 });
    let url = new URL(`${first.href}?${query}`);
    if (url.origin !== first.origin || url.pathname !== first.pathname) return blockedPath();

    const seen = new Set<string>();
    let items: unknown[] = [];
    let pagesFetched = 0;

    const finish = (reason?: TruncationReason): Paged<T> => {
      if (reason === 'max_items' && maxItems !== null) items = items.slice(0, maxItems);
      seedCourses(relative, items);
      // One pass over the merged list, so a student gets the same pseudonym on every page.
      const merged = (options.skipAnonymization ? items : anonymize(items, relative, options.forceTier)) as T[];
      if (reason === undefined) {
        return { items: merged, truncated: false, pagesFetched, label };
      }
      const page: Paged<T> = { items: merged, truncated: true, reason, pagesFetched, label };
      log.info('canvas_pagination_truncated', {
        endpoint: sanitizeUrl(relative),
        reason,
        pages: pagesFetched,
        count: merged.length,
      });
      if (record) {
        const entry: TruncationRecord = { label, reason, disclosed: false };
        truncations.push(entry);
        truncationOf.set(page, entry);
      }
      return page;
    };

    for (;;) {
      seen.add(url.href);
      const exchange = await execute({ verb: 'get', url, relative, useReserved: false });
      if (!exchange.ok) {
        // Running out of budget or time after at least one page is a
        // truncation. A Canvas error on any page returns no partial items.
        if (pagesFetched > 0 && exchange.failure.budgetExhausted === true) return finish('budget');
        if (pagesFetched > 0 && exchange.deadlineHit) return finish('deadline');
        return exchange.failure;
      }
      if (!Array.isArray(exchange.data)) {
        if (isRecord(exchange.data) && Object.hasOwn(exchange.data, 'error')) {
          const detail =
            typeof exchange.data.error === 'string' ? exchange.data.error : pythonRepr(exchange.data.error);
          return makeFailure(scrub(detail), 'may_have_written', { status: exchange.status });
        }
        return makeFailure(PAGINATION_SHAPE_ERROR, 'may_have_written', { status: exchange.status });
      }
      items = items.concat(exchange.data);
      pagesFetched++;

      let next: URL | null;
      try {
        next = nextPageUrl(exchange.link, url);
      } catch (error) {
        const message = error instanceof PaginationLinkError ? error.message : 'Invalid pagination link';
        log.warn('canvas_pagination_link_refused', { endpoint: sanitizeUrl(relative), reason: 'syntax' });
        return notDispatched(message);
      }
      if (next === null) {
        return finish(maxItems !== null && items.length > maxItems ? 'max_items' : undefined);
      }
      // Canvas next links are opaque: the query is kept as is, but credentials
      // are never forwarded to another origin or endpoint.
      if (!isPinnedPageUrl(next.href, apiBaseUrl, first.pathname)) {
        log.security('canvas_pagination_link_refused', { endpoint: sanitizeUrl(relative), reason: 'pin' });
        return notDispatched(PAGINATION_PINNED_ERROR);
      }
      if (seen.has(next.href)) {
        log.warn('canvas_pagination_link_refused', { endpoint: sanitizeUrl(relative), reason: 'cycle' });
        return notDispatched(PAGINATION_CYCLE_ERROR);
      }

      if (maxItems !== null && items.length >= maxItems) return finish('max_items');
      if (pagesFetched >= maxPages) return finish('max_pages');
      if (exchange.rateRemaining !== null && exchange.rateRemaining < STOP_PAGINATION_BELOW) {
        return finish('throttle');
      }
      if (meter.remaining < 1) return finish('budget');
      if (now() >= deps.deadline) return finish('deadline');
      url = next;
    }
  }

  function fetchAll<T = unknown>(
    path: CanvasPath,
    params?: Params,
    options: PageOptions = {},
  ): Promise<Paged<T> | RequestFailure> {
    return fetchAllPages<T>(path, params, options, true);
  }

  // ---- truncation disclosure ----------------------------------------------

  function markDisclosed(page: Paged<unknown>): void {
    const entry =
      truncationOf.get(page) ??
      // A tool may have copied the page object; fall back to the matching record.
      truncations.find((t) => !t.disclosed && t.label === page.label && t.reason === page.reason);
    if (entry !== undefined) entry.disclosed = true;
  }

  function requireComplete(page: Paged<unknown>, what: string): string | null {
    if (!page.truncated) return null;
    markDisclosed(page);
    const why = page.reason !== undefined ? TRUNCATION_REASON_TEXT[page.reason] : undefined;
    return (
      `Error: could not read the complete list of ${what}: only the first ${page.pagesFetched} page(s) ` +
      `were read${why !== undefined ? ` because ${why}` : ''}, and more exist in Canvas. ` +
      'A partial list must not decide a write. Narrow the request and try again.'
    );
  }

  function disclose(page: Paged<unknown>, hint?: string): string {
    if (!page.truncated) return '';
    markDisclosed(page);
    const notice =
      `⚠️ Results truncated: showing ${page.items.length} ${page.label} from the first ` +
      `${page.pagesFetched} page(s); more exist in Canvas. ${hint ?? DEFAULT_TRUNCATION_HINT}`;
    return notice.trimEnd();
  }

  // ---- course resolution --------------------------------------------------

  const courses = createCourseResolver({
    // Not recorded as a truncation: a cut-off course list is the resolver's
    // concern, not something the tool's own output has to disclose.
    fetchAll: (path, params, options) => fetchAllPages<unknown>(path, params, options ?? {}, false),
    request: (method, path) => request(method, path),
    budget: meter,
  });

  function seedCourses(relative: string, data: unknown): void {
    if (relative === '/courses' || /^\/courses\/[^/]+$/.test(relative)) {
      courses.seedCourses(data);
    }
  }

  // ---- file download ------------------------------------------------------

  async function sendDownloadHop(url: URL, withAuth: boolean): Promise<Response | RequestFailure> {
    const timeoutMs = admit(false);
    if (typeof timeoutMs !== 'number') return timeoutMs;
    const headers: Record<string, string> = { Accept: '*/*', 'User-Agent': USER_AGENT };
    // Checked here as well as by the caller: the token goes to the Canvas origin or nowhere.
    if (withAuth && canvasOrigin !== null && url.origin === canvasOrigin && url.protocol === 'https:') {
      headers.Authorization = authorization;
    }
    log.debug('canvas_download_hop', { host: url.host, authenticated: headers.Authorization !== undefined });
    try {
      return await limiter.run(() =>
        fetchImpl(url.href, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      // Not the hop's own path: after a redirect it belongs to another host and can name the file.
      return transportFailure(error, 'get', DOWNLOAD_LOG_ENDPOINT).failure;
    }
  }

  function download(fileUrl: string, options: { maxBytes: number }): Promise<DownloadedFile | RequestFailure> {
    return downloadFile(fileUrl, options, {
      canvasOrigin,
      send: sendDownloadHop,
      failure: (error) => transportFailure(error, 'get', DOWNLOAD_LOG_ENDPOINT).failure,
    });
  }

  const budget: BudgetView = Object.freeze({
    get limit(): number {
      return meter.limit;
    },
    get used(): number {
      return meter.used;
    },
    get remaining(): number {
      return meter.remaining;
    },
    reserve: (n: number): boolean => meter.reserve(n),
  });

  return Object.freeze({
    request,
    fetchAll,
    requireComplete,
    disclose,
    downloadFile: download,
    courses,
    budget,
    // A snapshot: callers can read the records but not edit the client's own.
    get truncations(): ReadonlyArray<TruncationRecord> {
      return truncations.map((entry) => ({ ...entry }));
    },
    caller,
  });
}
