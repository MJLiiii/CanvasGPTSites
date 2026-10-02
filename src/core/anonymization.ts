// Ports upstream src/canvas_mcp/core/anonymization.py, plus _anonymize_for_endpoint from src/canvas_mcp/core/client.py.
import type { AnonymizationTier } from '../types';
import { dataTypeForPath } from './anonymization-tiers';
import { hmacSha256Hex, sha256Hex } from './hash';

// ---------------------------------------------------------------------------
// Field policy for the recursive identity scrubber
// ---------------------------------------------------------------------------

/**
 * Person-name fields that are unambiguous: whenever one of these keys is
 * present it holds a human's name/handle, never a file or object label.
 */
export const STRICT_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'short_name',
  'sortable_name',
  'user_name',
  'author_name',
  'assessor_name',
  'grader_name',
  'email',
  'primary_email',
  'unconfirmed_email',
  'contact_info',
  'login_id',
]);

/** Keys whose pseudonym is rendered as an email address rather than a bare `Student_<hash>`. */
export const EMAIL_SHAPED_FIELDS: ReadonlySet<string> = new Set([
  'email',
  'primary_email',
  'unconfirmed_email',
  'contact_info',
]);

/**
 * Name fields Canvas also uses for courses, groups, modules, pages and file
 * attachments. Rewritten only when the containing record is corroborated as a
 * person. `full_name` is here rather than strict because it is exactly the
 * field the `free_text` tier preserves.
 */
export const AMBIGUOUS_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'display_name',
  'full_name',
  'unique_id',
]);

export const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  ...STRICT_IDENTITY_FIELDS,
  ...AMBIGUOUS_IDENTITY_FIELDS,
]);

/**
 * Direct identifiers and imagery, nulled outright. A pseudonym for a pronoun
 * set or a pronunciation guide would be nonsense, so the value is dropped.
 */
export const NULL_FIELDS: ReadonlySet<string> = new Set([
  'sis_user_id',
  'integration_id',
  'sis_login_id',
  'avatar_url',
  'avatar_image_url',
  'bio',
  'pronouns',
  'pronunciation',
]);

/**
 * Nulled only on records that look like a person. Courses, terms, accounts
 * and calendar events carry the same keys with institutional values.
 */
export const USER_ONLY_NULL_FIELDS: ReadonlySet<string> = new Set(['time_zone', 'locale', 'address']);

/**
 * Keys searched, in order, for the id a record's identity fields are keyed to.
 * The record's own `id` is used only when the record itself looks like a user.
 */
export const USER_ID_KEYS: readonly string[] = ['user_id', 'author_id', 'assessor_id', 'grader_id'];

/** Presence of any of these keys corroborates "this record describes a person". */
export const USER_SIGNAL_FIELDS: ReadonlySet<string> = new Set([
  'sortable_name',
  'short_name',
  'login_id',
  'email',
  'sis_user_id',
  'sis_login_id',
  'avatar_url',
  'avatar_image_url',
  'enrollments',
]);

/**
 * Keys that positively identify a record as NOT a person. Course objects carry
 * an `enrollments` list too, which would otherwise corroborate them as a user.
 */
export const NON_USER_MARKER_FIELDS: ReadonlySet<string> = new Set([
  'course_code',
  'sis_course_id',
  'enrollment_term_id',
]);

/**
 * Keys whose value is by convention a user record. Children reached through
 * one inherit user context without needing their own corroborating signal.
 */
export const USER_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'user',
  'author',
  'assessor',
  'grader',
  'editor',
  'submitter',
  'participant',
  'student',
  'observed_user',
  'communication_channels',
  'pseudonyms',
]);

/** Free-text fields that get PII regex scrubbing wherever they are found. */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'message',
  'comment',
  'comments',
  'body',
  'last_message',
  'last_authored_message',
]);

/**
 * data_type values the refinement router knows. A value outside this set
 * falls back to duck-typing; a value inside it suppresses duck-typing.
 */
export const KNOWN_DATA_TYPES: ReadonlySet<string> = new Set(['users', 'discussions', 'submissions', 'assignments']);

/** Submission fields that hold what the student handed in. */
export const SUBMISSION_CONTENT_FIELDS: readonly string[] = ['body', 'url', 'attachments'];

/** Assignment descriptions longer than this many characters are replaced. */
export const LONG_DESCRIPTION_LIMIT = 1000;

export const DEFAULT_PSEUDONYM_PREFIX = 'Student';

export const PLACEHOLDERS = {
  ssn: '[SSN_REDACTED]',
  email: '[EMAIL_REDACTED]',
  phone: '[PHONE_REDACTED]',
  /** Identity value on a record with no id to key a pseudonym to. */
  redacted: '[REDACTED]',
  /** Non-string submission content (attachment lists). */
  content: '[CONTENT_REDACTED]',
  longDescription: '[LONG_DESCRIPTION_REDACTED_FOR_PRIVACY]',
  emailDomain: '@example.edu',
} as const;

function contentRedactedFor(anonymousId: string): string {
  return `[CONTENT_REDACTED_FOR_${anonymousId}]`;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PseudonymOptions {
  /** HMAC key for pseudonyms; null (or empty) keeps upstream's unsalted SHA-256. */
  salt: string | null;
  /** Per-request memo of `prefix:id` to pseudonym. Never shared across requests. */
  memo: Map<string, string>;
}

export interface AnonymizeOptions extends PseudonymOptions {
  tier: AnonymizationTier;
  /** Final requested pathname with the API base removed; selects the typed refinement. */
  path: string;
}

export interface ScrubOptions {
  /** When false, leave FREE_TEXT_FIELDS untouched (the `identity` tier). Default true. */
  scrubText?: boolean;
  /**
   * When false, leave AMBIGUOUS_IDENTITY_FIELDS and bare-string user containers
   * untouched (the `free_text` tier). Strict and null fields still apply. Default true.
   */
  scrubDisplayNames?: boolean;
  /** Id of an enclosing user record, for a node that carries a name but no id. */
  inheritedId?: unknown;
  /** True when the node is known to be a user record. */
  userContext?: boolean;
}

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKey(record: JsonRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

function getKey(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Python `value in (None, '')`. Note that 0 and false are real values here. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Python truthiness for JSON values. */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** Python `str(value)` for the values an id can take, so hashes match upstream byte for byte. */
function idString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return 'None';
  }
  return JSON.stringify(value) ?? String(value);
}

/** Whether `text` has more than `limit` code points (Python `len`), without counting when the answer is already known. */
function exceedsCodePoints(text: string, limit: number): boolean {
  if (text.length <= limit) {
    return false;
  }
  if (text.length > limit * 2) {
    return true;
  }
  let count = 0;
  for (const _ of text) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Free-text redaction
// ---------------------------------------------------------------------------

// Python's `\w`, `\d` and `\b` are Unicode-aware on str patterns; JavaScript's
// are ASCII-only even with the `u` flag. These spell out the Python classes so
// full-width or Arabic-Indic digits are still redacted, and so "é" next to a
// number still counts as a word character.
const WORD = '[\\p{L}\\p{N}_]';
const DIGIT = '\\p{Nd}';
const NOT_AFTER_WORD = `(?<!${WORD})`;
const NOT_BEFORE_WORD = `(?!${WORD})`;
const WORD_BOUNDARY = `(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`;

// A leading `\b` before a digit, or a trailing `\b` after a digit or ASCII
// letter, reduces to the one-sided lookaround. The email local part may start
// with a non-word character (".", "%", "+", "-"), so it needs the full boundary.
const SSN_SOURCE = `${NOT_AFTER_WORD}${DIGIT}{3}-${DIGIT}{2}-${DIGIT}{4}${NOT_BEFORE_WORD}`;
const EMAIL_SOURCE = `${WORD_BOUNDARY}[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}${NOT_BEFORE_WORD}`;
const PHONE_SOURCE = `${NOT_AFTER_WORD}${DIGIT}{3}[-.]?${DIGIT}{3}[-.]?${DIGIT}{4}${NOT_BEFORE_WORD}`;

export interface FreeTextRedaction {
  kind: 'ssn' | 'email' | 'phone';
  /** Pattern source; compile with the `u` flag. */
  source: string;
  placeholder: string;
}

/**
 * Redaction passes in the order upstream applies them: SSN, then email, then
 * phone. The order matters: an SSN is also a run of digits a later pass could
 * partly match.
 */
export const FREE_TEXT_REDACTIONS: readonly FreeTextRedaction[] = [
  { kind: 'ssn', source: SSN_SOURCE, placeholder: PLACEHOLDERS.ssn },
  { kind: 'email', source: EMAIL_SOURCE, placeholder: PLACEHOLDERS.email },
  { kind: 'phone', source: PHONE_SOURCE, placeholder: PLACEHOLDERS.phone },
];

const SSN_RE = new RegExp(SSN_SOURCE, 'gu');
const PHONE_RE = new RegExp(PHONE_SOURCE, 'gu');
// Sticky forms: `lastIndex` is set before every use, so they carry no state.
const EMAIL_AT = new RegExp(EMAIL_SOURCE, 'uy');
const WORD_BOUNDARY_AT = new RegExp(WORD_BOUNDARY, 'uy');

/** Whether a UTF-16 code unit is in the email local-part class `[A-Za-z0-9._%+-]`. */
function isLocalPartCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x25 ||
    code === 0x2b ||
    code === 0x2d
  );
}

/**
 * Same result as replacing every match of EMAIL_SOURCE left to right, in linear
 * time. A plain global regex retries the local part from every word boundary
 * of a long "a.a.a.a…" run, which is quadratic and lets one crafted post burn
 * the Worker's CPU budget.
 *
 * A match must contain an "@" directly after its local part, so candidates are
 * found from each "@" backwards. Whether the domain matches does not depend on
 * where the local part starts, so only the leftmost boundary in the run before
 * the "@" needs to be tried.
 */
function redactEmails(text: string): string {
  let at = text.indexOf('@');
  if (at === -1) {
    return text;
  }
  let out = '';
  let pos = 0;
  while (at !== -1) {
    let runStart = at;
    while (runStart > pos && isLocalPartCode(text.charCodeAt(runStart - 1))) {
      runStart -= 1;
    }
    let matchEnd = -1;
    for (let start = runStart; start < at; start += 1) {
      WORD_BOUNDARY_AT.lastIndex = start;
      if (!WORD_BOUNDARY_AT.test(text)) {
        continue;
      }
      EMAIL_AT.lastIndex = start;
      const match = EMAIL_AT.exec(text);
      if (match !== null) {
        out += text.slice(pos, start) + PLACEHOLDERS.email;
        matchEnd = start + match[0].length;
      }
      break;
    }
    if (matchEnd === -1) {
      at = text.indexOf('@', at + 1);
    } else {
      pos = matchEnd;
      at = text.indexOf('@', matchEnd);
    }
  }
  return out + text.slice(pos);
}

/** Redact SSNs, emails and phone numbers from a free-text string. Non-strings pass through. */
export function scrubFreeText<T>(value: T): T {
  if (typeof value !== 'string' || value === '') {
    return value;
  }
  let text: string = value.replace(SSN_RE, PLACEHOLDERS.ssn);
  text = redactEmails(text);
  text = text.replace(PHONE_RE, PLACEHOLDERS.phone);
  return text as T;
}

// ---------------------------------------------------------------------------
// Pseudonyms
// ---------------------------------------------------------------------------

/**
 * A consistent pseudonym for `realId`: `<prefix>_<first 8 hex of the digest>`.
 *
 * Without a salt the digest is SHA-256 of the id's decimal string, byte for
 * byte what upstream produces. Canvas ids are small integers, so that form can
 * be reversed by brute force; with a salt the digest is HMAC-SHA256(salt, id).
 *
 * The memo is keyed by prefix and id. Upstream keys its process-wide cache by
 * id alone, so whichever prefix asks first wins and "Reviewer"/"Reviewee"
 * collapse into "Student"; that bug is not reproduced.
 */
export function generateAnonymousId(realId: unknown, prefix: string, opts: PseudonymOptions): string {
  const id = idString(realId);
  const memoKey = `${prefix}:${id}`;
  const cached = opts.memo.get(memoKey);
  if (cached !== undefined) {
    return cached;
  }
  const digest = opts.salt === null || opts.salt === '' ? sha256Hex(id) : hmacSha256Hex(opts.salt, id);
  const anonymousId = `${prefix}_${digest.slice(0, 8)}`;
  opts.memo.set(memoKey, anonymousId);
  return anonymousId;
}

// ---------------------------------------------------------------------------
// Recursive identity scrubber
// ---------------------------------------------------------------------------

/** Avatar references appear under many names (`assessor_avatar_url`, `avatar_path`); match by shape. */
function isAvatarField(keyLower: string): boolean {
  return keyLower.includes('avatar') && (keyLower.endsWith('url') || keyLower.endsWith('path'));
}

/**
 * Whether `record` describes a person rather than a course/group/file/module.
 * Corroboration is required before the ambiguous name keys are rewritten.
 */
function looksLikeUserRecord(record: JsonRecord, userContext: boolean): boolean {
  for (const field of NON_USER_MARKER_FIELDS) {
    if (hasKey(record, field)) {
      return false;
    }
  }
  if (userContext) {
    return true;
  }
  for (const field of USER_SIGNAL_FIELDS) {
    if (hasKey(record, field)) {
      return true;
    }
  }
  return USER_ID_KEYS.some((key) => !isBlank(getKey(record, key)));
}

/** The id the record's identity fields are pseudonymised against, if it has one. */
function recordIdentityId(record: JsonRecord, looksUser: boolean): unknown {
  for (const key of USER_ID_KEYS) {
    const value = getKey(record, key);
    if (!isBlank(value)) {
      return value;
    }
  }
  if (looksUser) {
    const ownId = getKey(record, 'id');
    if (!isBlank(ownId)) {
      return ownId;
    }
  }
  return null;
}

/** Replace one identity field's value, preserving null/empty as-is. */
function pseudonymiseField(keyLower: string, value: unknown, anonymousId: string | null): unknown {
  if (isBlank(value)) {
    return value;
  }
  if (anonymousId === null) {
    return PLACEHOLDERS.redacted;
  }
  if (EMAIL_SHAPED_FIELDS.has(keyLower)) {
    return `${anonymousId.toLowerCase()}${PLACEHOLDERS.emailDomain}`;
  }
  if (keyLower === 'login_id') {
    return anonymousId.toLowerCase();
  }
  return anonymousId;
}

interface ScrubContext extends PseudonymOptions {
  scrubText: boolean;
  scrubDisplayNames: boolean;
}

function scrubNode(node: unknown, inheritedId: unknown, userContext: boolean, ctx: ScrubContext): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => scrubNode(item, inheritedId, userContext, ctx));
  }
  if (!isRecord(node)) {
    return node;
  }

  const looksUser = looksLikeUserRecord(node, userContext);
  let identityId = recordIdentityId(node, looksUser);
  if (isBlank(identityId)) {
    identityId = inheritedId;
  }
  const anonymousId = isBlank(identityId) ? null : generateAnonymousId(identityId, DEFAULT_PSEUDONYM_PREFIX, ctx);

  // Built from entries so a JSON key named "__proto__" stays an own property
  // instead of becoming the result's prototype.
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(node)) {
    const keyLower = key.toLowerCase();

    if (NULL_FIELDS.has(keyLower) || isAvatarField(keyLower) || (USER_ONLY_NULL_FIELDS.has(keyLower) && looksUser)) {
      entries.push([key, null]);
      continue;
    }

    if (
      STRICT_IDENTITY_FIELDS.has(keyLower) ||
      (ctx.scrubDisplayNames && AMBIGUOUS_IDENTITY_FIELDS.has(keyLower) && looksUser)
    ) {
      entries.push([key, pseudonymiseField(keyLower, value, anonymousId)]);
      continue;
    }

    // Canvas sometimes returns a bare name string where a user object is
    // expected ("author": "Bob Smith"); that is an identity value.
    if (ctx.scrubDisplayNames && USER_CONTAINER_KEYS.has(keyLower) && typeof value === 'string') {
      entries.push([key, pseudonymiseField('name', value, anonymousId)]);
      continue;
    }

    if (ctx.scrubText && FREE_TEXT_FIELDS.has(keyLower) && typeof value === 'string') {
      entries.push([key, scrubFreeText(value)]);
      continue;
    }

    entries.push([key, scrubNode(value, identityId, USER_CONTAINER_KEYS.has(keyLower), ctx)]);
  }
  return Object.fromEntries(entries);
}

/**
 * Recursively remove personal identity from an arbitrary Canvas payload. This
 * is the baseline applied to every response the tier gate marks as sensitive;
 * it walks lists and records uniformly, so identity fields nested at any depth
 * are scrubbed.
 *
 * Invariants:
 * - It never adds a key that was not already present.
 * - Identity fields are keyed to the nearest enclosing user id, so one student
 *   maps to one pseudonym across a response.
 * - It is idempotent: scrubbed output is a fixed point.
 *
 * Returns a scrubbed copy; the input is not modified.
 */
export function scrubIdentity<T>(node: T, pseudonyms: PseudonymOptions, options: ScrubOptions = {}): T {
  const ctx: ScrubContext = {
    salt: pseudonyms.salt,
    memo: pseudonyms.memo,
    scrubText: options.scrubText ?? true,
    scrubDisplayNames: options.scrubDisplayNames ?? true,
  };
  return scrubNode(node, options.inheritedId ?? null, options.userContext ?? false, ctx) as T;
}

// ---------------------------------------------------------------------------
// Typed refinements (full tier only)
// ---------------------------------------------------------------------------

/** Redact submitted content (body/url/attachments) on a submission record. */
function redactSubmissionContent(submission: JsonRecord, pseudonyms: PseudonymOptions): JsonRecord {
  const userId = getKey(submission, 'user_id');
  if (!isTruthy(userId)) {
    return submission;
  }

  const anonymousId = generateAnonymousId(userId, DEFAULT_PSEUDONYM_PREFIX, pseudonyms);
  const redacted: JsonRecord = { ...submission };
  for (const field of SUBMISSION_CONTENT_FIELDS) {
    const value = getKey(redacted, field);
    // Upstream rewrites an already-redacted "[CONTENT_REDACTED]" attachment
    // marker into the per-student form on a second pass. Leaving it alone
    // keeps the first-pass output identical and makes the refinement a fixed point.
    if (!isTruthy(value) || value === PLACEHOLDERS.content) {
      continue;
    }
    redacted[field] = typeof value === 'string' ? contentRedactedFor(anonymousId) : PLACEHOLDERS.content;
  }
  return redacted;
}

/** Replace very long assignment descriptions, which may embed student information. */
function redactLongDescription(assignment: JsonRecord): JsonRecord {
  const description = getKey(assignment, 'description');
  if (typeof description === 'string' && exceedsCodePoints(description, LONG_DESCRIPTION_LIMIT)) {
    return { ...assignment, description: PLACEHOLDERS.longDescription };
  }
  return assignment;
}

/**
 * Which typed refinement applies to `record`. An explicit, known data type
 * always wins; duck-typing is consulted only when the caller did not state one.
 */
function resolveRecordType(record: JsonRecord, dataType: string): string {
  if (KNOWN_DATA_TYPES.has(dataType)) {
    return dataType;
  }
  if (hasKey(record, 'submitted_at')) {
    return 'submissions';
  }
  if (hasKey(record, 'due_at')) {
    return 'assignments';
  }
  if (hasKey(record, 'message')) {
    return 'discussions';
  }
  return 'general';
}

/** Record-level refinements layered on the identity scrub. Applies to top-level records only, as upstream does. */
function applyTypeRefinements(data: unknown, dataType: string, pseudonyms: PseudonymOptions): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => applyTypeRefinements(item, dataType, pseudonyms));
  }
  if (!isRecord(data)) {
    return data;
  }

  const resolved = resolveRecordType(data, dataType);
  if (resolved === 'submissions') {
    return redactSubmissionContent(data, pseudonyms);
  }
  if (resolved === 'assignments') {
    return redactLongDescription(data);
  }
  return data;
}

/**
 * Upstream `anonymize_response_data`: the recursive identity scrub, then the
 * typed refinement for `dataType`. A data type outside KNOWN_DATA_TYPES falls
 * back to duck-typing each record.
 */
export function anonymizeResponseData<T>(data: T, dataType: string, pseudonyms: PseudonymOptions): T {
  return applyTypeRefinements(scrubIdentity(data, pseudonyms), dataType, pseudonyms) as T;
}

/**
 * Apply an anonymization tier to a Canvas response.
 *
 * `identity` and `free_text` skip the typed refinements on purpose: those exist
 * for submission and assignment records, which neither /pages nor
 * /conversations returns. A tier this function does not recognise is treated
 * as `full`.
 */
export function anonymizeResponse<T>(data: T, opts: AnonymizeOptions): T {
  switch (opts.tier) {
    case 'none':
      return data;
    case 'identity':
      return scrubIdentity(data, opts, { scrubText: false });
    case 'free_text':
      return scrubIdentity(data, opts, { scrubDisplayNames: false });
    default:
      return anonymizeResponseData(data, dataTypeForPath(opts.path), opts);
  }
}
