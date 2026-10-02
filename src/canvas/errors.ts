// Ports canvas_mcp/core/write_outcome.py and the error normalization of
// make_canvas_request in canvas_mcp/core/client.py.
import type { RequestFailure, WriteOutcome } from '../types';

/** Existing messaging policy: timeout, conflict, rate limit and 5xx are uncertain. */
export const NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

export type FailureExtra = Partial<Pick<RequestFailure, 'status' | 'throttled' | 'budgetExhausted'>>;

const WRITE_OUTCOMES: ReadonlySet<string> = new Set<WriteOutcome>(['not_dispatched', 'rejected', 'may_have_written']);

export function makeFailure(error: string, outcome: WriteOutcome, extra?: FailureExtra): RequestFailure {
  const failure: RequestFailure = { error, outcome };
  if (extra?.status !== undefined) failure.status = extra.status;
  if (extra?.throttled !== undefined) failure.throttled = extra.throttled;
  if (extra?.budgetExhausted !== undefined) failure.budgetExhausted = extra.budgetExhausted;
  return failure;
}

/**
 * True for a failure produced by the Canvas client. A bare `{error}` object
 * carries no transport evidence and is deliberately not a `RequestFailure`.
 */
export function isFailure(x: unknown): x is RequestFailure {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const candidate = x as { error?: unknown; outcome?: unknown };
  return (
    typeof candidate.error === 'string' && typeof candidate.outcome === 'string' && WRITE_OUTCOMES.has(candidate.outcome)
  );
}

/**
 * Upstream's public error shape. `outcome` and the other evidence fields are
 * internal ("never a new wire field"), so a tool that returns a failure as its
 * output must pass it through this first.
 */
export function failureToWire(failure: RequestFailure): { error: string } {
  return { error: failure.error };
}

// What Python's str.isprintable() rejects, apart from the ASCII space.
const PYTHON_NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).padStart(width, '0');
}

function pythonStringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === ' ' || !PYTHON_NON_PRINTABLE.test(char)) out += char;
    else if (codePoint <= 0xff) out += `\\x${hex(codePoint, 2)}`;
    else if (codePoint <= 0xffff) out += `\\u${hex(codePoint, 4)}`;
    else out += `\\U${hex(codePoint, 8)}`;
  }
  return out + quote;
}

function pythonNumberRepr(value: number): string {
  if (Number.isInteger(value) || Math.abs(value) >= 1e-4) return String(value);
  // Python switches to exponent notation below 1e-4 and pads the exponent to two digits.
  return value.toExponential().replace(/e([+-])(\d)$/, (_match, sign: string, digit: string) => `e${sign}0${digit}`);
}

/**
 * Python's `repr()` of a value decoded from JSON, which is how upstream prints
 * Canvas error bodies (`{'status': 'unauthorized'}`). JavaScript cannot tell a
 * JSON `1.0` from `1`, so a whole-number float prints as an integer.
 */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return pythonNumberRepr(value);
  if (typeof value === 'string') return pythonStringRepr(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const items = Object.entries(value).map(([key, item]) => `${pythonStringRepr(key)}: ${pythonRepr(item)}`);
    return `{${items.join(', ')}}`;
  }
  return String(value);
}

function describeBody(bodyText: string): string {
  try {
    const details: unknown = JSON.parse(bodyText);
    // An f-string applies str(), so a top-level string is printed without quotes.
    return `, Details: ${typeof details === 'string' ? details : pythonRepr(details)}`;
  } catch {
    // Not JSON, or nested too deeply to print. The parser's own message is
    // dropped because V8 quotes a snippet of the body in it.
    return `, Text: ${bodyText}`;
  }
}

/**
 * Failure for a non-2xx Canvas response, with upstream's exact text:
 * "HTTP error: <code>, Details: <parsed body>" or "HTTP error: <code>, Text: <body>".
 * 400/401/403/404/422 prove nothing was written; every other status, 429
 * included, may have written.
 */
export function httpFailure(status: number, bodyText: string, extra?: FailureExtra): RequestFailure {
  const outcome: WriteOutcome = NO_WRITE_STATUSES.has(status) ? 'rejected' : 'may_have_written';
  return makeFailure(`HTTP error: ${status}${describeBody(bodyText)}`, outcome, { ...extra, status });
}

/** Transport-level failure (timeout, reset, unreadable 2xx body). The request may have landed. */
export function requestFailed(message: string, extra?: FailureExtra): RequestFailure {
  return makeFailure(`Request failed: ${message}`, 'may_have_written', extra);
}

/** Local refusal: nothing was sent to Canvas. The message is used as given. */
export function notDispatched(message: string, extra?: FailureExtra): RequestFailure {
  return makeFailure(message, 'not_dispatched', extra);
}

/**
 * Whether Canvas is throttling the caller. Canvas answers an exhausted quota
 * with 403 "Rate Limit Exceeded" rather than 429. This only drives retry and
 * slowdown; the write outcome still comes from the status (403 is `rejected`).
 */
export function isThrottled(status: number, bodyText: string, headers: Headers): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (bodyText.includes('Rate Limit Exceeded')) return true;
  const remaining = headers.get('X-Rate-Limit-Remaining')?.trim();
  if (!remaining || !/^-?\d+(?:\.\d+)?$/.test(remaining)) return false;
  return Number(remaining) <= 0;
}
