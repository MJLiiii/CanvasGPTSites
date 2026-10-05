// Ports canvas-mcp src/canvas_mcp/core/config.py (reshaped: a pure parse of the Worker env; fail-closed rules are recorded as data).
import { isValidTimeZone } from './core/dates';
import { redactSecretsDeep } from './core/logging';
import { TOOL_EFFECTS, PORT_TOOL_EFFECTS, describeEntries, resolveToolPolicy, splitEntries } from './core/tool-policy';
import type { AuthMode, CanvasConnection, Config, ConfigError, Env, LogLevel, McpBackend, Role, Secrets } from './types';

/**
 * Canonical names of the student write tools an owner may enable through
 * STUDENT_WRITE_TOOLS. Quiz-taking is deliberately absent: it is an
 * academic-integrity decision, not something this allowlist can switch on.
 */
export const STUDENT_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'submit_assignment',
  'comment_on_my_submission',
  'mark_module_item_done',
]);

/** Canonical checker names accepted in ACCESSIBILITY_CHECKERS, with aliases. */
export const ACCESSIBILITY_CHECKER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ufixit: 'ufixit',
  udoit: 'ufixit',
});

const MIN_CONFIRMATION_SECRET_LENGTH = 32;
const MAX_ECHOED_VALUE = 40;
/** Submission claims are held for 330 s; a tool call must be certain to finish well before that. */
const MAX_RUNTIME_MS = 300_000;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function connectionEntries(env: Env): unknown[] | null {
  if (typeof env.CANVAS_CONNECTIONS !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(env.CANVAS_CONNECTIONS);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    // JSON parser messages can quote credentials. Never expose them.
    return null;
  }
}

function connectionRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseConnections(env: Env, errors: ConfigError[]): CanvasConnection[] {
  const entries = connectionEntries(env);
  const invalid = (): void => {
    errors.push({ code: 'canvas_connections_invalid', blocks: 'invocation',
      message: 'CANVAS_CONNECTIONS must be a non-empty JSON array with unique IDs. IDs must start with a lowercase letter and use lowercase letters, digits, underscores or hyphens (maximum 64 characters).' });
  };
  if (entries === null) { invalid(); return []; }
  const ids = new Set<string>();
  const connections: CanvasConnection[] = [];
  for (const entry of entries) {
    const row = connectionRecord(entry);
    if (row === null || typeof row.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) || ids.has(row.id)) {
      invalid(); return [];
    }
    ids.add(row.id);
    const issues: string[] = [];
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (name === '' || /[\u0000-\u001f\u007f]/.test(name)) issues.push('A non-empty display name without control characters is required.');
    const url = normalizeCanvasUrl(typeof row.url === 'string' ? row.url : '');
    if (url.error !== null || url.apiUrl === null) issues.push('A valid HTTPS Canvas URL is required.');
    const token = typeof row.token === 'string' ? row.token.trim() : '';
    const hasToken = token !== '' && isSendableToken(token);
    if (!hasToken) issues.push('A valid Canvas token is required.');
    connections.push({ id: row.id, name: name || row.id, apiUrl: url.apiUrl, origin: url.origin, hasToken, errors: issues });
  }
  const cleaned = redactSecretsDeep(connections, secretValuesForRedaction(env));
  for (let i = 0; i < connections.length; i++) {
    if (cleaned[i]!.id !== connections[i]!.id) { invalid(); return []; }
    if (cleaned[i]!.apiUrl !== connections[i]!.apiUrl || cleaned[i]!.origin !== connections[i]!.origin) {
      cleaned[i]!.apiUrl = null;
      cleaned[i]!.origin = null;
      cleaned[i]!.errors.push('Canvas URL must not contain credentials.');
    }
  }
  return cleaned;
}

/** A non-secret variable as text. Numbers and booleans are accepted because a JSON-typed variable arrives that way. */
function readVar(env: Env, name: string): string | undefined {
  const value = env[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** A variable with surrounding whitespace removed; blank counts as unset. */
function readTrimmed(env: Env, name: string): string | undefined {
  const value = readVar(env, name)?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readSecret(env: Env, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * How a rejected non-secret value is shown. Anything longer than a plausible
 * setting is shown by length only, so a token pasted into the wrong variable
 * does not come back out through a message.
 */
function shown(value: string): string {
  return value.length > MAX_ECHOED_VALUE ? `<${value.length} characters>` : `'${value}'`;
}

function splitList(value: string | undefined): string[] {
  return value === undefined ? [] : splitEntries(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * True only for the string "true" (case-insensitive), as upstream. A blank
 * value counts as unset. Any other value is false, with a warning unless it is
 * the string "false": upstream reads `=yes` or `=1` as false without saying so.
 */
function boolVar(env: Env, name: string, fallback: boolean, warnings: string[]): boolean {
  const value = readTrimmed(env, name);
  if (value === undefined) return fallback;
  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered !== 'false') {
    warnings.push(`${name} expects 'true' or 'false'; treating it as false (got ${shown(value)})`);
  }
  return false;
}

/**
 * A privacy protection that is on unless the owner turns it off. Only the
 * string "false" turns it off. A value that is neither "true" nor "false"
 * (`=yes`, `=1`) most likely meant "on", and reading it as false, as upstream
 * does, would switch the protection off without anyone noticing; it refuses
 * every request instead, and the protection stays on.
 */
function privacyFlagVar(env: Env, name: string, code: string, errors: ConfigError[]): boolean {
  const value = readTrimmed(env, name);
  if (value === undefined) return true;
  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  errors.push({
    code,
    message: `${name} expects 'true' or 'false' (got ${shown(value)})`,
    blocks: 'request',
  });
  return true;
}

interface IntRule {
  /** Values below this fall back to the default. */
  min?: number;
  /** Values outside this range are moved to the nearest bound. */
  clamp?: readonly [number, number];
}

function intVar(env: Env, name: string, fallback: number, warnings: string[], rule: IntRule = {}): number {
  const value = readTrimmed(env, name);
  if (value === undefined) return fallback;
  const parsed = /^[+-]?[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    warnings.push(`${name} expects an integer; using default value (got ${shown(value)})`);
    return fallback;
  }
  if (rule.clamp !== undefined) {
    const [low, high] = rule.clamp;
    const clamped = Math.min(high, Math.max(low, parsed));
    if (clamped !== parsed) {
      warnings.push(`${name} must be between ${low} and ${high}; using ${clamped} (got ${shown(value)})`);
    }
    return clamped;
  }
  if (rule.min !== undefined && parsed < rule.min) {
    warnings.push(`${name} expects an integer of at least ${rule.min}; using default value (got ${shown(value)})`);
    return fallback;
  }
  return parsed;
}

function positiveNumberVar(env: Env, name: string, fallback: number, warnings: string[]): number {
  const value = readTrimmed(env, name);
  if (value === undefined) return fallback;
  const parsed = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnings.push(`${name} expects a positive number; using default value (got ${shown(value)})`);
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// CANVAS_API_URL
// ---------------------------------------------------------------------------

const URL_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/;
const IPV4_LITERAL = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The only description of a CANVAS_API_URL value that may appear in a message:
 * its scheme and host when the host is an ordinary DNS name, else its length.
 * An owner may have pasted a token into this variable (as the whole value, as
 * userinfo, as a query parameter, even as the "host"), so the path, query,
 * userinfo and anything that does not look like a hostname are never shown.
 */
function describeUrlValue(value: string): string {
  const shape = URL_SHAPE.exec(value);
  if (shape !== null) {
    const scheme = (shape[1] ?? '').toLowerCase();
    const authority = shape[2] ?? '';
    const host = authority
      .slice(authority.lastIndexOf('@') + 1)
      .replace(/:[0-9]*$/, '')
      .toLowerCase();
    if (scheme.length <= 8 && DNS_NAME.test(host)) {
      return `scheme and host ${scheme}://${host}`;
    }
  }
  return `unparseable (length ${value.length})`;
}

export interface CanvasUrlOutcome {
  apiUrl: string | null;
  origin: string | null;
  error: ConfigError | null;
}

/**
 * Normalize CANVAS_API_URL to `https://host[/prefix]/api/v<N>` (upstream
 * `_normalize_canvas_url`) and refuse anything a token must not be sent to.
 *
 * Canvas REST endpoints live under `/api/v1`. Owners often enter just the base
 * host; requests without the suffix make Canvas answer 302 to its login page,
 * which looks like a bad token. An existing `/api/v<N>` segment is kept and
 * anything after it is dropped, as are the query and fragment.
 */
export function normalizeCanvasUrl(raw: string): CanvasUrlOutcome {
  const value = raw.trim();
  if (value === '') {
    return { apiUrl: null, origin: null, error: null };
  }
  const reject = (reason: string): CanvasUrlOutcome => ({
    apiUrl: null,
    origin: null,
    error: {
      code: 'canvas_url_invalid',
      message: `${reason} Configured value: ${describeUrlValue(value)}.`,
      blocks: 'request',
    },
  });

  // The URL parser repairs these instead of refusing them (a backslash becomes
  // a slash, tabs and line breaks vanish), so they are refused before parsing.
  if (/[\s\\]|[\u0000-\u001f\u007f]/.test(value)) {
    return reject('CANVAS_API_URL must not contain whitespace, backslashes or control characters.');
  }
  const shape = URL_SHAPE.exec(value);
  if (shape === null) {
    return reject("CANVAS_API_URL should start with 'https://'.");
  }
  const scheme = (shape[1] ?? '').toLowerCase();
  const authority = shape[2] ?? '';
  if (scheme === 'http') {
    return reject(
      "CANVAS_API_URL must use 'https://'. The Canvas API token is sent " +
        'on every request, so a cleartext URL exposes it on the network.',
    );
  }
  if (scheme !== 'https') {
    return reject("CANVAS_API_URL should start with 'https://'.");
  }
  if (authority === '') {
    return reject('CANVAS_API_URL is missing a hostname.');
  }
  if (authority.includes('@')) {
    return reject('CANVAS_API_URL must not contain a username or password.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('CANVAS_API_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return reject("CANVAS_API_URL should start with 'https://' and must not contain a username or password.");
  }
  if (url.hostname === '') {
    return reject('CANVAS_API_URL is missing a hostname.');
  }
  // The parser drops the default port, so anything left is a port other than 443.
  if (url.port !== '') {
    return reject('CANVAS_API_URL must not name a port other than 443.');
  }
  // The parser has already rewritten every numeric host form (decimal, hex, short) as dotted IPv4.
  if (url.hostname.startsWith('[') || IPV4_LITERAL.test(url.hostname)) {
    return reject('CANVAS_API_URL must name a host, not an IP address.');
  }
  // The host ends up on the secret-free Config and the status page. Requiring an
  // ordinary dotted DNS name keeps a token pasted in as "https://<token>" out of both.
  if (!DNS_NAME.test(url.hostname)) {
    return reject('CANVAS_API_URL must name a fully qualified host such as canvas.school.edu.');
  }

  const version = /\/api\/v[0-9]+(?=\/|$)/.exec(url.pathname);
  const path = version === null ? '/api/v1' : url.pathname.slice(0, version.index + version[0].length);
  // "canvas.school.edu." names the same host as "canvas.school.edu", but as an
  // origin the two differ, and Canvas writes its own links without the dot.
  const origin = `https://${url.hostname.replace(/\.$/, '')}`;
  return { apiUrl: `${origin}${path}`, origin, error: null };
}

// ---------------------------------------------------------------------------
// Lists and enumerations
// ---------------------------------------------------------------------------

/**
 * Normalise ACCESSIBILITY_CHECKERS to canonical checker names. "none" (or an
 * empty value) yields an empty list. Unknown names are dropped with a warning.
 */
function parseAccessibilityCheckers(raw: string, warnings: string[]): string[] {
  const known = new Set<string>();
  const unknown = new Set<string>();
  for (const entry of splitList(raw)) {
    const name = entry.toLowerCase();
    if (name === 'none') continue;
    const canonical = Object.hasOwn(ACCESSIBILITY_CHECKER_ALIASES, name)
      ? ACCESSIBILITY_CHECKER_ALIASES[name]
      : undefined;
    if (canonical === undefined) {
      unknown.add(name);
    } else {
      known.add(canonical);
    }
  }
  if (unknown.size > 0) {
    warnings.push(
      'ACCESSIBILITY_CHECKERS names unknown checkers; they will be ignored ' +
        `(known: ${Object.keys(ACCESSIBILITY_CHECKER_ALIASES).sort().join(', ')}, none): ` +
        describeEntries(unknown),
    );
  }
  return [...known].sort();
}

function parseLogLevel(env: Env, warnings: string[]): LogLevel {
  const value = readTrimmed(env, 'LOG_LEVEL');
  if (value === undefined) return 'info';
  const lowered = value.toLowerCase();
  if (lowered === 'debug' || lowered === 'info' || lowered === 'warn' || lowered === 'error') return lowered;
  if (lowered === 'warning') return 'warn';
  warnings.push(`LOG_LEVEL should be one of debug, info, warn, error; defaulting to 'info' (got ${shown(value)})`);
  return 'info';
}

function parseTimezone(env: Env, warnings: string[]): string {
  const value = readTrimmed(env, 'TIMEZONE');
  if (value === undefined) return 'UTC';
  // The same test the date formatter applies, so a zone accepted here is one it honours.
  if (isValidTimeZone(value)) return value;
  warnings.push(`TIMEZONE is not a known time zone; defaulting to 'UTC' (got ${shown(value)})`);
  return 'UTC';
}

function parseMcpPath(env: Env, warnings: string[]): string {
  const value = readTrimmed(env, 'MCP_PATH');
  if (value === undefined) return '/mcp';
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(value) || value.includes('//') || /(^|\/)\.\.?(\/|$)/.test(value)) {
    warnings.push(`MCP_PATH must be an absolute path such as /mcp; defaulting to '/mcp' (got ${shown(value)})`);
    return '/mcp';
  }
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Secret values, read straight from the env on every call. A confirmation
 * secret shorter than 32 characters and a Canvas token that could not be sent
 * in a header are returned as null, matching what `parseConfig` reports.
 */
export function parseSecrets(env: Env): Secrets {
  const token = readSecret(env, 'CANVAS_API_TOKEN');
  const confirmation = readSecret(env, 'CONFIRMATION_SECRET');
  return {
    canvasToken: env.CANVAS_CONNECTIONS === undefined && token !== null && isSendableToken(token) ? token : null,
    ...(env.CANVAS_CONNECTIONS !== undefined && {
      canvasTokens: Object.fromEntries((connectionEntries(env) ?? []).flatMap((entry) => {
        const row = connectionRecord(entry);
        if (row === null || typeof row.id !== 'string') return [];
        const value = typeof row.token === 'string' ? row.token.trim() : '';
        return [[row.id, value !== '' && isSendableToken(value) ? value : null]];
      })),
    }),
    confirmationSecret:
      confirmation !== null && confirmation.length >= MIN_CONFIRMATION_SECRET_LENGTH ? confirmation : null,
    pseudonymSalt: readSecret(env, 'PSEUDONYM_SALT'),
  };
}

/**
 * Every secret-class value present in the env, including ones `parseSecrets`
 * rejects, for the logger's redaction list. Values under 8 characters are left
 * out: redacting them would shred ordinary log text without protecting anything.
 */
export function secretValuesForRedaction(env: Env): string[] {
  const values: string[] = [];
  for (const name of ['CANVAS_API_TOKEN', 'CONFIRMATION_SECRET', 'PSEUDONYM_SALT']) {
    const value = readSecret(env, name);
    if (value !== null && value.length >= 8) {
      values.push(value);
    }
  }
  // Include rejected and unused connection tokens too, and protect the complete JSON.
  if (typeof env.CANVAS_CONNECTIONS === 'string' && env.CANVAS_CONNECTIONS !== '') values.push(env.CANVAS_CONNECTIONS);
  for (const entry of connectionEntries(env) ?? []) {
    const row = connectionRecord(entry);
    if (row !== null && typeof row.token === 'string' && row.token !== '') {
      values.push(row.token);
      if (row.token.trim() !== '') values.push(row.token.trim());
    }
  }
  return values;
}

/** A bearer token must be visible ASCII, or building the Authorization header throws with the token in the message. */
function isSendableToken(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

/**
 * Parse and validate the Worker env into a secret-free Config. Pure: no
 * caching and no globals, so two requests can never see each other's values.
 *
 * Nothing throws. A fail-closed violation is recorded in `errors` and the
 * caller refuses to serve; a tolerated problem is recorded in `warnings`.
 * Messages never contain the value of a secret-class variable.
 */
export function parseConfig(env: Env): Config {
  const errors: ConfigError[] = [];
  const warnings: string[] = [];

  // --- Mode switches ---
  const authMode: AuthMode = 'owner';
  // Retain the old owner setting, but reject unsupported modes rather than ignoring them.
  const rawAuthMode = readTrimmed(env, 'AUTH_MODE');
  if (rawAuthMode !== undefined && rawAuthMode.toLowerCase() !== 'owner') {
    errors.push({
      code: 'auth_mode_invalid',
      message: `AUTH_MODE must be owner or unset (got ${shown(rawAuthMode)})`,
      blocks: 'request',
    });
  }

  let mcpBackend: McpBackend = 'sdk';
  const rawBackend = readTrimmed(env, 'MCP_BACKEND');
  if (rawBackend !== undefined) {
    const lowered = rawBackend.toLowerCase();
    if (lowered === 'sdk' || lowered === 'native') {
      mcpBackend = lowered;
    } else {
      errors.push({
        code: 'mcp_backend_invalid',
        message: `MCP_BACKEND should be one of sdk, native (got ${shown(rawBackend)})`,
        blocks: 'request',
      });
    }
  }

  // An unknown role falls back to the narrowest one, and the request is refused anyway.
  let role: Role = 'student';
  const rawRole = readTrimmed(env, 'CANVAS_ROLE');
  if (rawRole !== undefined) {
    const lowered = rawRole.toLowerCase();
    if (lowered === 'student' || lowered === 'educator' || lowered === 'all') {
      role = lowered;
    } else {
      errors.push({
        code: 'canvas_role_invalid',
        message: `CANVAS_ROLE should be one of student, educator, all (got ${shown(rawRole)})`,
        blocks: 'request',
      });
    }
  }

  // --- Canvas endpoint and credentials ---
  const connectionsConfigured = env.CANVAS_CONNECTIONS !== undefined;
  const canvasConnections = connectionsConfigured ? parseConnections(env, errors) : [];
  const rawUrl = connectionsConfigured ? '' : readVar(env, 'CANVAS_API_URL') ?? '';
  const canvasUrl = normalizeCanvasUrl(rawUrl);
  if (canvasUrl.error !== null) {
    errors.push(canvasUrl.error);
  }

  const rawToken = connectionsConfigured ? null : readSecret(env, 'CANVAS_API_TOKEN');
  const tokenUsable = rawToken !== null && isSendableToken(rawToken);
  if (rawToken !== null && !tokenUsable) {
    errors.push({
      code: 'canvas_token_invalid',
      message:
        'CANVAS_API_TOKEN contains whitespace or characters that cannot be sent in a header ' +
        `(length ${rawToken.length})`,
      blocks: 'request',
    });
  }

  const rawConfirmation = readSecret(env, 'CONFIRMATION_SECRET');
  const hasConfirmationSecret =
    rawConfirmation !== null && rawConfirmation.length >= MIN_CONFIRMATION_SECRET_LENGTH;
  if (rawConfirmation !== null && !hasConfirmationSecret) {
    warnings.push(
      `CONFIRMATION_SECRET must be at least ${MIN_CONFIRMATION_SECRET_LENGTH} characters; ` +
        `treating it as missing (length ${rawConfirmation.length}). Tools that need a confirmation are not registered.`,
    );
  }

  const hasPseudonymSalt = readSecret(env, 'PSEUDONYM_SALT') !== null;

  // --- Owner identity ---
  let ownerEmail: string | null = null;
  const rawOwnerEmail = readTrimmed(env, 'OWNER_EMAIL');
  if (rawOwnerEmail !== undefined) {
    // Visible ASCII without a comma: Headers.get joins duplicate headers with ", ",
    // so an owner value that could equal a joined pair must not exist.
    if (/^[\x21-\x2b\x2d-\x7e]+$/.test(rawOwnerEmail)) {
      ownerEmail = rawOwnerEmail.toLowerCase();
    } else {
      errors.push({
        code: 'owner_email_invalid',
        message: `OWNER_EMAIL must be ASCII with no whitespace or comma (length ${rawOwnerEmail.length})`,
        blocks: 'request',
      });
    }
  }

  let ownerUserIdSha256: string | null = null;
  const rawOwnerHash = readTrimmed(env, 'OWNER_USER_ID_SHA256');
  if (rawOwnerHash !== undefined) {
    if (/^[0-9a-fA-F]{64}$/.test(rawOwnerHash)) {
      ownerUserIdSha256 = rawOwnerHash.toLowerCase();
    } else {
      // Dropping an unusable value would silently remove a check the owner asked for.
      errors.push({
        code: 'owner_user_id_sha256_invalid',
        message: `OWNER_USER_ID_SHA256 must be 64 hexadecimal characters (length ${rawOwnerHash.length})`,
        blocks: 'request',
      });
    }
  }

  // --- Tool policy ---
  const allowedWriteToolsRaw = readVar(env, 'ALLOWED_WRITE_TOOLS') ?? null;
  const policy = resolveToolPolicy(allowedWriteToolsRaw);
  if (!policy.ok) {
    errors.push({ code: 'allowed_write_tools_invalid', message: policy.error, blocks: 'request' });
  }

  const requestedStudentWrites = unique(splitList(readVar(env, 'STUDENT_WRITE_TOOLS')));
  const unknownStudentWrites = requestedStudentWrites.filter((name) => !STUDENT_WRITE_TOOL_NAMES.has(name));
  if (unknownStudentWrites.length > 0) {
    warnings.push(
      `STUDENT_WRITE_TOOLS names unknown tools; they will be ignored: ${describeEntries(unknownStudentWrites)}`,
    );
  }
  const studentWriteTools = requestedStudentWrites.filter((name) => STUDENT_WRITE_TOOL_NAMES.has(name)).sort();

  const disabledTools = unique(splitList(readVar(env, 'DISABLED_TOOLS'))).sort();
  const unknownDisabled = disabledTools.filter((name) => !Object.hasOwn(TOOL_EFFECTS, name) && !Object.hasOwn(PORT_TOOL_EFFECTS, name));
  if (unknownDisabled.length > 0) {
    warnings.push(`DISABLED_TOOLS names tools that are not in the tool table: ${describeEntries(unknownDisabled)}`);
  }

  // Student write policy: an unrecognized posture must fail closed, not fall
  // through to something permissive.
  let defaultPosture: 'allow' | 'deny' = 'deny';
  const rawPosture = readTrimmed(env, 'COURSE_AGENT_POLICY_DEFAULT');
  if (rawPosture !== undefined) {
    const lowered = rawPosture.toLowerCase();
    if (lowered === 'allow' || lowered === 'deny') {
      defaultPosture = lowered;
    } else {
      warnings.push(
        `COURSE_AGENT_POLICY_DEFAULT should be one of allow, deny; defaulting to 'deny' (got ${shown(rawPosture)})`,
      );
    }
  }

  // --- Limits ---
  const apiTimeoutMs = intVar(env, 'API_TIMEOUT', 15, warnings, { min: 1 }) * 1000;
  const toolDeadlineMs = intVar(env, 'TOOL_DEADLINE_MS', 25_000, warnings, { min: 1 });
  if (toolDeadlineMs + apiTimeoutMs >= MAX_RUNTIME_MS) {
    errors.push({
      code: 'runtime_bound_exceeded',
      message:
        'TOOL_DEADLINE_MS plus API_TIMEOUT must stay under 300 seconds, or a submission claim could ' +
        `expire while its tool call is still running (got ${toolDeadlineMs + apiTimeoutMs} ms)`,
      blocks: 'request',
    });
  }

  const diagnosticsEnabled = boolVar(env, 'DIAGNOSTICS_ENABLED', false, warnings);

  // --- Fail-closed combinations ---
  if (!connectionsConfigured && rawUrl.trim() === '') {
    errors.push({
      code: 'canvas_url_missing',
      message: 'CANVAS_API_URL environment variable is required',
      blocks: 'invocation',
    });
  }
  if (!connectionsConfigured && rawToken === null) {
    errors.push({
      code: 'canvas_token_missing',
      message: 'CANVAS_API_TOKEN environment variable is required',
      blocks: 'invocation',
    });
  }
  if (rawOwnerEmail === undefined) {
    errors.push({
      code: 'owner_email_missing',
      message: 'OWNER_EMAIL environment variable is required',
      blocks: 'invocation',
    });
  }
  // Presence is judged on the raw values: a token or secret this parser
  // rejects is still a credential sitting on the deployment.
  if (diagnosticsEnabled && (readSecret(env, 'CANVAS_API_TOKEN') !== null || rawConfirmation !== null || connectionsConfigured)) {
    errors.push({
      code: 'diagnostics_with_credentials',
      message:
        'DIAGNOSTICS_ENABLED=true is only allowed on a deployment that holds no credentials; ' +
        'unset CANVAS_API_TOKEN, CANVAS_CONNECTIONS and CONFIRMATION_SECRET, or turn diagnostics off',
      blocks: 'request',
    });
  }

  return {
    authMode,
    connectionsConfigured,
    canvasConnections: connectionsConfigured ? canvasConnections : [{
      id: 'default', name: readTrimmed(env, 'INSTITUTION_NAME') ?? 'Canvas',
      apiUrl: canvasUrl.apiUrl, origin: canvasUrl.origin, hasToken: tokenUsable,
      errors: canvasUrl.apiUrl !== null && tokenUsable ? [] : ['Canvas credentials are unavailable.'],
    }],
    canvasApiUrl: canvasUrl.apiUrl,
    canvasOrigin: canvasUrl.origin,
    hasCanvasToken: tokenUsable,
    ownerEmail,
    ownerUserIdSha256,
    hasConfirmationSecret,
    hasPseudonymSalt,

    serverName: readTrimmed(env, 'MCP_SERVER_NAME') ?? 'canvas-api',
    mcpPath: parseMcpPath(env, warnings),
    mcpBackend,

    role,
    allowedWriteToolsRaw,
    studentWriteTools,
    coursePolicy: {
      enabled: boolVar(env, 'COURSE_AGENT_POLICY_ENABLED', true, warnings),
      defaultPosture,
      // Denials cache longer than grants. A stale grant is a revocation window
      // on an attempt-consuming action, so it is deliberately short.
      allowTtlSeconds: intVar(env, 'COURSE_AGENT_POLICY_ALLOW_TTL', 30, warnings, { min: 0 }),
      denyTtlSeconds: intVar(env, 'COURSE_AGENT_POLICY_DENY_TTL', 300, warnings, { min: 0 }),
    },
    accessibilityCheckers: parseAccessibilityCheckers(readVar(env, 'ACCESSIBILITY_CHECKERS') ?? 'ufixit', warnings),
    disabledTools,

    anonymizationEnabled: privacyFlagVar(env, 'ENABLE_DATA_ANONYMIZATION', 'enable_data_anonymization_invalid', errors),
    logRedactPii: privacyFlagVar(env, 'LOG_REDACT_PII', 'log_redact_pii_invalid', errors),
    logAccessEvents: boolVar(env, 'LOG_ACCESS_EVENTS', true, warnings),
    logLevel: parseLogLevel(env, warnings),
    auditToD1: boolVar(env, 'AUDIT_TO_D1', true, warnings),

    timezone: parseTimezone(env, warnings),
    institutionName: readTrimmed(env, 'INSTITUTION_NAME') ?? '',

    apiTimeoutMs,
    maxConcurrentRequests: intVar(env, 'MAX_CONCURRENT_REQUESTS', 3, warnings, { clamp: [1, 4] }),
    readFileMaxBytes: Math.floor(positiveNumberVar(env, 'READ_FILE_MAX_SIZE_MB', 5, warnings) * 1024 * 1024),
    requestBudget: intVar(env, 'CANVAS_REQUEST_BUDGET', 40, warnings, { clamp: [5, 200] }),
    maxPages: intVar(env, 'CANVAS_MAX_PAGES', 10, warnings, { min: 1 }),
    toolDeadlineMs,
    maxToolResultBytes: intVar(env, 'MAX_TOOL_RESULT_BYTES', 200_000, warnings, { min: 1 }),
    maxRequestBytes: intVar(env, 'MAX_REQUEST_BYTES', 1_048_576, warnings, { min: 1 }),
    maxUploadBytes: Math.floor(positiveNumberVar(env, 'MAX_UPLOAD_MB', 5, warnings) * 1024 * 1024),
    maxBulkItems: intVar(env, 'MAX_BULK_ITEMS', 20, warnings, { min: 1 }),

    allowedHosts: unique(splitList(readVar(env, 'ALLOWED_HOSTS')).map((host) => host.toLowerCase())),
    diagnosticsEnabled,
    exportsEnabled: boolVar(env, 'EXPORTS_ENABLED', false, warnings),
    dbBootstrap: boolVar(env, 'DB_BOOTSTRAP', true, warnings),

    errors,
    warnings,
  };
}
