// No upstream counterpart: what the Milestone 0 diagnostics tools may learn about a request and the runtime.
// Everything here reports shapes (names, lengths, hashes, counts), never a header value or a binding's contents.
import { sha256Hex } from '../core/hash';
import type { DiagnosticsAccess, Env, ProbeOutcome } from '../types';

/**
 * The one URL the subrequest probe fetches. A constant: no caller input and
 * no configuration reaches the probe's request, and it carries no credentials.
 */
export const PROBE_FETCH_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

const PROBE_D1_STATEMENT = 'SELECT 1';
const MAX_PROBE_COUNT = 200;
const MAX_ERROR_TEXT = 160;
const MAX_CLAIM_TEXT = 200;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface DiagnosticsExecutionContext {
  props?: Record<string, unknown>;
}

function probeCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.min(MAX_PROBE_COUNT, Math.max(0, Math.trunc(count)));
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const name = SAFE_ERROR_NAME.test(String(error.name)) ? error.name : 'Error';
  const firstLine = (String(error.message).split(/\r?\n/, 1)[0] ?? '').trim().slice(0, MAX_ERROR_TEXT);
  return firstLine === '' ? name : `${name}: ${firstLine}`;
}

function decodeBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function claimText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_CLAIM_TEXT);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(' ').slice(0, MAX_CLAIM_TEXT);
  }
  return undefined;
}

type AuthorizationShape = ReturnType<DiagnosticsAccess['authorizationShape']>;

/**
 * The shape of an Authorization value: its scheme, how many dot-separated
 * segments the credential has, and, when it parses as a JWT, the issuer and
 * audience claims. Those two name parties, not a secret; nothing else of the
 * token is read out.
 */
function authorizationShapeOf(value: string | null): AuthorizationShape {
  if (value === null) return { present: false };
  const match = /^([A-Za-z][A-Za-z0-9_-]{0,31})[ \t]+(\S.*)$/.exec(value.trim());
  if (match === null) return { present: true };
  const scheme = match[1] as string;
  const segments = (match[2] as string).split('.');
  const shape: AuthorizationShape = { present: true, scheme, segments: segments.length };
  if (segments.length === 3) {
    const payload = decodeBase64Url(segments[1] as string);
    if (payload !== null) {
      try {
        const claims: unknown = JSON.parse(payload);
        if (claims !== null && typeof claims === 'object' && !Array.isArray(claims)) {
          const iss = claimText((claims as Record<string, unknown>).iss);
          const aud = claimText((claims as Record<string, unknown>).aud);
          if (iss !== undefined) shape.jwtIss = iss;
          if (aud !== undefined) shape.jwtAud = aud;
        }
      } catch {
        // Not a JWT payload; the segment count is all there is to report.
      }
    }
  }
  return shape;
}

interface D1Like {
  prepare(query: string): { first(): Promise<unknown> };
}

function asD1(value: unknown): D1Like | null {
  return value !== null && typeof value === 'object' && typeof (value as { prepare?: unknown }).prepare === 'function'
    ? (value as D1Like)
    : null;
}

/** Run `step` up to `count` times, one after another, stopping at the first one that throws. */
async function runSequential(count: number, step: () => Promise<string | null>): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = { attempted: 0, succeeded: 0 };
  for (let i = 0; i < count; i += 1) {
    outcome.attempted += 1;
    try {
      const problem = await step();
      if (problem === null) {
        outcome.succeeded += 1;
      } else if (outcome.firstError === undefined) {
        outcome.firstError = problem;
      }
    } catch (error) {
      // A platform limit makes every later call fail the same way; one failure is the answer.
      if (outcome.firstError === undefined) outcome.firstError = describeError(error);
      break;
    }
  }
  return outcome;
}

/**
 * Diagnostics access for one request. Registered with the dispatcher only in
 * diagnostics mode, which configuration allows only while the deployment
 * holds no Canvas token and no confirmation secret.
 */
export function createDiagnosticsAccess(
  request: Request,
  env: Env,
  ctx: DiagnosticsExecutionContext | undefined,
  fetchImpl: typeof fetch,
): DiagnosticsAccess {
  return {
    headerSummary() {
      const summary: Array<{ name: string; length: number; sha256_8: string }> = [];
      request.headers.forEach((value, name) => {
        summary.push({ name: name.toLowerCase(), length: value.length, sha256_8: sha256Hex(value).slice(0, 8) });
      });
      return summary.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    authorizationShape() {
      return authorizationShapeOf(request.headers.get('authorization'));
    },

    bindingNames() {
      return Object.keys(env).sort();
    },

    ctxPropKeys() {
      const props: unknown = ctx?.props;
      return props !== null && typeof props === 'object' ? Object.keys(props).sort() : [];
    },

    probeFetch(count: number): Promise<ProbeOutcome> {
      return runSequential(probeCount(count), async () => {
        const response = await fetchImpl(PROBE_FETCH_URL, { method: 'GET', redirect: 'manual' });
        await response.body?.cancel().catch(() => undefined);
        return response.ok ? null : `HTTP ${response.status}`;
      });
    },

    async probeD1(count: number): Promise<ProbeOutcome> {
      const db = asD1(env.DB);
      if (db === null) {
        return { attempted: 0, succeeded: 0, firstError: 'The D1 binding DB is not present' };
      }
      return runSequential(probeCount(count), async () => {
        await db.prepare(PROBE_D1_STATEMENT).first();
        return null;
      });
    },
  };
}
