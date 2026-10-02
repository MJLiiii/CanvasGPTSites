// Ports canvas-mcp src/canvas_mcp/core/logging.py and core/audit.py (console only: one JSON object per line).
import type { LogLevel, Logger } from '../types';
import { hmacSha256Hex } from './hash';

export const REDACTED = '[REDACTED]';

// PII keys that are fully redacted in log context
const PII_KEYS: ReadonlySet<string> = new Set([
  'user_id',
  'student_id',
  'email',
  'name',
  'login_id',
  'sis_user_id',
  'value',
]);

// ID keys that are truncated (only the last 4 characters are shown)
const ID_KEYS: ReadonlySet<string> = new Set(['course_id', 'topic_id', 'assignment_id', 'entry_id', 'submission_id']);

// Python's \d matches every Unicode decimal digit; JS \d is ASCII-only.
const NUMERIC_PATH_RE = /\/\p{Nd}+/gu;

/**
 * Sanitize a context object by redacting PII and truncating IDs.
 *
 * - keys in PII_KEYS are replaced with '[REDACTED]'
 * - keys in ID_KEYS are truncated to show only the last 4 characters
 * - all other keys pass through unchanged
 *
 * With `redactPii` false the context is returned as it came.
 */
export function sanitizeContext(fields: Record<string, unknown>, redactPii: boolean): Record<string, unknown> {
  if (!redactPii) {
    return fields;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PII_KEYS.has(key)) {
      sanitized[key] = REDACTED;
    } else if (ID_KEYS.has(key)) {
      const text = String(value);
      sanitized[key] = text.length > 4 ? `***${text.slice(-4)}` : text;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// RFC 3986 appendix B, as urlsplit reads it: scheme, authority, path, query, fragment.
const URL_PARTS = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?[^#]*)?(?:#[\s\S]*)?$/;

// Remove URL credentials, query and fragment, and replace numeric path segments.
//
// Example: /courses/12345/users/678 → /courses/***/users/***
//
// The digit masking is applied to the path only. Upstream runs it over the
// whole rebuilt URL, which also eats the start of a host that begins with a
// digit ("https://1host" → "https:/***host").
export function sanitizeUrl(url: string): string {
  const match = URL_PARTS.exec(url);
  if (match === null) {
    // The pattern accepts every string; this only guards against a future edit breaking that.
    return '';
  }
  const scheme = match[1];
  const authority = match[2];
  const path = (match[3] ?? '').replace(NUMERIC_PATH_RE, '/***');
  let out = '';
  if (scheme !== undefined) {
    out += `${scheme}:`;
  }
  if (authority !== undefined) {
    out += `//${authority.slice(authority.lastIndexOf('@') + 1)}`;
  }
  return out + path;
}

function percentEncodeStrict(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The forms one secret can take inside a string: raw, percent-encoded by
 * `encodeURIComponent`, percent-encoded strictly (Canvas tokens contain `~`,
 * which `URLSearchParams` escapes and `encodeURIComponent` does not),
 * form-encoded, and JSON-escaped.
 */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret]);
  try {
    forms.add(encodeURIComponent(secret));
    forms.add(percentEncodeStrict(secret));
    forms.add(new URLSearchParams([['', secret]]).toString().slice(1));
  } catch {
    // A lone surrogate cannot be percent-encoded; the raw form still applies.
  }
  forms.add(JSON.stringify(secret).slice(1, -1));
  return [...forms].filter((form) => form !== '');
}

/** Replace every occurrence of each non-empty secret, raw or URL-encoded, with "[REDACTED]". */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (text === '' || secrets.length === 0) {
    return text;
  }
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    for (const form of secretForms(secret)) {
      forms.add(form);
    }
  }
  // Longest first, so a secret that contains another one is removed whole.
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  let out = text;
  for (const form of ordered) {
    if (out.includes(form)) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

/**
 * `redactSecrets` applied to every string of a JSON-like value, object keys
 * included. Returns a copy; `onRedacted` is called once for each string that
 * held a secret.
 */
export function redactSecretsDeep<T>(value: T, secrets: readonly string[], onRedacted?: () => void): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const out = redactSecrets(node, secrets);
      if (out !== node) onRedacted?.();
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        // Defined rather than assigned, so a key named "__proto__" stays an ordinary property.
        Object.defineProperty(out, String(walk(key)), { value: walk(child), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return node;
  };
  // The walk keeps the shape of what it is given: strings stay strings, arrays arrays, objects objects.
  return walk(value) as T;
}

/**
 * The only form in which an identity is logged: the first 12 hex characters of
 * a keyed hash of the identity key. Never the email or the gateway user id.
 */
export function identityTag(identityKey: string, hmacKey: string): string {
  return hmacSha256Hex(hmacKey, `identity-tag|${identityKey}`).slice(0, 12);
}

/**
 * Fields of a data access audit event (upstream `log_data_access`). Emit with
 * `log.info('data_access', dataAccessFields(...))` when LOG_ACCESS_EVENTS is on.
 */
export function dataAccessFields(
  method: string,
  endpoint: string,
  status: 'success' | 'error',
  error?: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    method: method.toUpperCase(),
    endpoint: sanitizeUrl(endpoint),
    status,
  };
  if (error) {
    fields.error = error;
  }
  return fields;
}

export interface LoggerOptions {
  level: LogLevel;
  redactPii: boolean;
  /** Secret values to scrub from every emitted string. */
  secrets?: string[];
  /** Receives one JSON line per event. Default: console.log. */
  sink?: (line: string) => void;
  /** Fields added to every event (request id, identity tag). */
  base?: Record<string, unknown>;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_KEYS: ReadonlySet<string> = new Set(['timestamp', 'level', 'event']);
const MAX_DEPTH = 6;
const MAX_ERROR_MESSAGE = 300;

/**
 * Make a value safe to serialize and safe to read: strings lose secrets,
 * nested objects get the same PII rules as the top level, and an Error is
 * reduced to its name and a bounded message. The stack is dropped, as upstream
 * logs only the exception type: parser errors quote the body they choked on.
 */
function toLoggable(value: unknown, redactPii: boolean, secrets: readonly string[], depth: number): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, secrets);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    const message = redactSecrets(String(value.message), secrets);
    return {
      name: redactSecrets(String(value.name), secrets),
      message: message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}...` : message,
    };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => toLoggable(item, redactPii, secrets, depth + 1));
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }
  return loggableObject(value as Record<string, unknown>, redactPii, secrets, depth + 1);
}

function loggableObject(
  fields: Record<string, unknown>,
  redactPii: boolean,
  secrets: readonly string[],
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sanitized = sanitizeContext(fields, redactPii);
  for (const [key, value] of Object.entries(sanitized)) {
    const converted = toLoggable(value, redactPii, secrets, depth);
    if (converted !== undefined) {
      out[redactSecrets(key, secrets)] = converted;
    }
  }
  return out;
}

/**
 * A logger that writes one JSON object per line. `security` events are always
 * written; the others are filtered by `level`. Nothing passed in can make the
 * logger throw.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[opts.level] ?? LEVEL_ORDER.info;
  const secrets = (opts.secrets ?? []).filter((secret) => typeof secret === 'string' && secret !== '');
  const sink = opts.sink ?? ((line: string): void => console.log(line));
  const base = opts.base ?? {};

  const emit = (level: LogLevel | 'security', event: string, fields?: Record<string, unknown>): void => {
    try {
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        level,
        event: redactSecrets(String(event), secrets),
      };
      const extra = loggableObject({ ...base, ...(fields ?? {}) }, opts.redactPii, secrets, 1);
      for (const [key, value] of Object.entries(extra)) {
        if (!RESERVED_KEYS.has(key)) {
          record[key] = value;
        }
      }
      sink(JSON.stringify(record));
    } catch {
      // Logging must never take a request down; a line that cannot be built is dropped.
    }
  };

  const leveled =
    (level: LogLevel) =>
    (event: string, fields?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] >= threshold) {
        emit(level, event, fields);
      }
    };

  return {
    debug: leveled('debug'),
    info: leveled('info'),
    warn: leveled('warn'),
    error: leveled('error'),
    security: (event, fields) => emit('security', event, fields),
  };
}
