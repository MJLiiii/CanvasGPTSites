// A stand-in for Canvas in tests: a `fetch` backed by a route table that records every call
// it receives, wherever the call is addressed. No request leaves the process.
import { SubrequestMeter } from '../../src/canvas/budget';
import { createCanvasClient } from '../../src/canvas/client';
import { createLogger } from '../../src/core/logging';
import { parseConfig } from '../../src/env';
import type { CanvasClient, CanvasCredential, Config } from '../../src/types';

export interface FakeCall {
  method: string;
  /** The URL exactly as the client passed it to fetch. */
  url: string;
  /** Request headers with lower-cased names. */
  headers: Record<string, string>;
  /** Text bodies as sent; multipart bodies as the FormData object. */
  body: string | FormData | null;
  redirect: string | undefined;
}

export interface FakeRequest extends FakeCall {
  parsed: URL;
  signal: AbortSignal | null;
}

export type FakeHandler = (request: FakeRequest) => Response | Promise<Response>;

export interface FakeCanvas {
  readonly origin: string;
  fetch: typeof fetch;
  /** Every call the fake received, in order, including calls to other origins. */
  calls: FakeCall[];
  /**
   * Register a handler. `target` is a pathname on the fake's origin
   * ("/api/v1/courses"), a RegExp tested against that pathname, or an absolute
   * URL without query ("https://cdn.example/file") for another origin. The
   * newest matching route wins; an unrouted call gets a 404.
   */
  route(method: string, target: string | RegExp, handler: FakeHandler): void;
  /**
   * Serve `items` from `pathname` in pages, with Canvas-style `Link` headers
   * whose `next` URL carries an opaque bookmark. `pageSize` defaults to the
   * request's `per_page`, or 10 as Canvas does.
   */
  paginate(pathname: string, items: readonly unknown[], pageSize?: number): void;
  /** Forget all recorded calls and all routes. */
  reset(): void;
}

interface Route {
  method: string;
  target: string | RegExp;
  handler: FakeHandler;
}

interface LooseInit {
  method?: string;
  headers?: unknown;
  body?: unknown;
  redirect?: string;
  signal?: AbortSignal | null;
}

/** A JSON response, as Canvas sends them. */
export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers },
  });
}

function bookmark(offset: number): string {
  return `bookmark:${btoa(JSON.stringify([offset])).replace(/=+$/, '')}`;
}

function offsetOf(page: string | null, size: number): number {
  if (page === null) return 0;
  if (page.startsWith('bookmark:')) {
    const decoded: unknown = JSON.parse(atob(page.slice('bookmark:'.length)));
    return Array.isArray(decoded) && typeof decoded[0] === 'number' ? decoded[0] : 0;
  }
  const number = Number(page);
  return Number.isInteger(number) && number >= 1 ? (number - 1) * size : 0;
}

export function createFakeCanvas(options: { origin: string }): FakeCanvas {
  const origin = new URL(options.origin).origin;
  const calls: FakeCall[] = [];
  const routes: Route[] = [];

  function find(method: string, url: URL): FakeHandler | undefined {
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route === undefined || route.method !== method) continue;
      if (typeof route.target === 'string') {
        const wanted = route.target.startsWith('/') ? origin + route.target : route.target;
        if (wanted === url.origin + url.pathname) return route.handler;
      } else if (url.origin === origin && route.target.test(url.pathname)) {
        return route.handler;
      }
    }
    return undefined;
  }

  async function fakeFetch(input: unknown, init: LooseInit = {}): Promise<Response> {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url: unknown }).url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as Record<string, string> | undefined).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: string | FormData | null = null;
    if (typeof init.body === 'string' || init.body instanceof FormData) body = init.body;
    else if (init.body !== undefined && init.body !== null) body = String(init.body);

    const call: FakeCall = { method, url: href, headers, body, redirect: init.redirect };
    calls.push(call);

    const signal = init.signal ?? null;
    if (signal?.aborted) throw signal.reason;
    const parsed = new URL(href);
    const handler = find(method, parsed);
    const answer = Promise.resolve().then(() =>
      handler === undefined
        ? json({ errors: [{ message: 'not routed' }] }, { status: 404 })
        : handler({ ...call, parsed, signal }),
    );
    if (signal === null) return answer;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      answer.then(
        (response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  const fake: FakeCanvas = {
    origin,
    fetch: fakeFetch as unknown as typeof fetch,
    calls,
    route(method, target, handler) {
      routes.push({ method: method.toUpperCase(), target, handler });
    },
    paginate(pathname, items, pageSize) {
      fake.route('GET', pathname, (request) => {
        const requested = Number(request.parsed.searchParams.get('per_page'));
        const size = pageSize ?? (Number.isInteger(requested) && requested > 0 ? requested : 10);
        const offset = offsetOf(request.parsed.searchParams.get('page'), size);
        const self = `${origin}${pathname}`;
        const links = [
          `<${self}?page=${offset === 0 ? 'first' : bookmark(offset)}&per_page=${size}>; rel="current"`,
        ];
        if (offset + size < items.length) {
          links.push(`<${self}?page=${bookmark(offset + size)}&per_page=${size}>; rel="next"`);
        }
        links.push(`<${self}?page=first&per_page=${size}>; rel="first"`);
        return json(items.slice(offset, offset + size), { headers: { Link: links.join(',') } });
      });
    },
    reset() {
      calls.length = 0;
      routes.length = 0;
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// A real client wired to the fake
// ---------------------------------------------------------------------------

/** Recognisable on sight, so a test can search any output for a leak. */
export const FAKE_TOKEN = '7~FAKEcanvasTOKEN0123456789abcdefghijklmnopqrstuvwxyzABCD';

export const TEST_START = 1_700_000_000_000;

export function testConfig(origin: string, overrides: Partial<Config> = {}): Config {
  const config = parseConfig({
    CANVAS_API_URL: origin,
    CANVAS_API_TOKEN: FAKE_TOKEN,
    OWNER_EMAIL: 'owner@example.edu',
  });
  return { ...config, ...overrides };
}

export interface TestClientOptions {
  config?: Partial<Config>;
  /** Subrequest budget of the call. Default 40. */
  budget?: number;
  /** Milliseconds from the start of the call to its deadline. Default 25000. */
  deadlineIn?: number;
  allowRaw?: boolean;
  pseudonymSalt?: string | null;
  /** Use wall-clock time and real sleeps instead of the controlled clock. */
  realTime?: boolean;
}

export interface TestClient {
  client: CanvasClient;
  config: Config;
  meter: SubrequestMeter;
  /** One JSON string per log event. The logger is given no secrets to scrub, so a leak would show. */
  logLines: string[];
  /** Every wait the client asked for, in milliseconds. */
  sleeps: number[];
  /** Controlled clock: `sleep` advances it, and a test may move it by hand. */
  clock: { now: number };
}

/** The real Canvas client, with the fake as its transport and a clock the test controls. */
export function createTestClient(fake: FakeCanvas, options: TestClientOptions = {}): TestClient {
  const config = testConfig(fake.origin, options.config);
  const meter = new SubrequestMeter(options.budget ?? 40);
  const logLines: string[] = [];
  const sleeps: number[] = [];
  const clock = { now: TEST_START };
  const credential: CanvasCredential = {
    apiBaseUrl: `${fake.origin}/api/v1`,
    origin: fake.origin,
    token: FAKE_TOKEN,
    callerId: 'caller-test',
    kind: 'owner-secret',
  };
  const deadlineIn = options.deadlineIn ?? 25_000;
  const client = createCanvasClient({
    credential,
    config,
    meter,
    deadline: (options.realTime ? Date.now() : clock.now) + deadlineIn,
    log: createLogger({ level: 'debug', redactPii: config.logRedactPii, sink: (line) => logLines.push(line) }),
    allowRaw: options.allowRaw ?? false,
    pseudonymSalt: options.pseudonymSalt ?? null,
    fetchImpl: fake.fetch,
    ...(options.realTime
      ? {}
      : {
          now: (): number => clock.now,
          sleep: async (ms: number): Promise<void> => {
            sleeps.push(ms);
            clock.now += ms;
          },
        }),
  });
  return { client, config, meter, logLines, sleeps, clock };
}
