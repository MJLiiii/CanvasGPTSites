// Ports canvas-mcp tests/security/test_pii_sanitization.py and the event-shape cases of tests/security/test_audit_logging.py.
import { describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../../src/core/hash';
import {
  createLogger,
  dataAccessFields,
  identityTag,
  redactSecrets,
  redactSecretsDeep,
  sanitizeContext,
  sanitizeUrl,
} from '../../src/core/logging';
import type { LogLevel } from '../../src/types';

const TOKEN = '7~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz01';

function capture(
  overrides: { level?: LogLevel; redactPii?: boolean; secrets?: string[]; base?: Record<string, unknown> } = {},
) {
  const lines: string[] = [];
  const log = createLogger({
    level: overrides.level ?? 'debug',
    redactPii: overrides.redactPii ?? true,
    secrets: overrides.secrets,
    base: overrides.base,
    sink: (line) => lines.push(line),
  });
  const events = (): Array<Record<string, unknown>> => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, events };
}

describe('PII sanitization in log context', () => {
  it('redacts PII keys', () => {
    const context = {
      user_id: 12345,
      email: 'student@university.edu',
      name: 'Jane Doe',
      login_id: 'jdoe2',
      sis_user_id: 'U00012345',
      student_id: 99999,
      value: 'some sensitive data',
    };
    const result = sanitizeContext(context, true);
    for (const key of Object.keys(context)) {
      expect(result[key], `${key} should be redacted`).toBe('[REDACTED]');
    }
  });

  it('truncates ID keys to the last 4 characters, prefixed with ***', () => {
    const result = sanitizeContext(
      { course_id: 123456, topic_id: 78901, assignment_id: 55555, entry_id: 42, submission_id: 9999999 },
      true,
    );
    expect(result.course_id).toBe('***3456');
    expect(result.topic_id).toBe('***8901');
    expect(result.assignment_id).toBe('***5555');
    // entry_id "42" is <= 4 chars, passes through as-is
    expect(result.entry_id).toBe('42');
    expect(result.submission_id).toBe('***9999');
  });

  it('preserves keys that are neither PII nor IDs', () => {
    const context = { endpoint: '/courses/123/assignments', method: 'GET', status_code: 200 };
    expect(sanitizeContext(context, true)).toEqual(context);
  });

  it('passes everything through when redaction is disabled', () => {
    const context = { user_id: 12345, email: 'student@university.edu', course_id: 123456 };
    expect(sanitizeContext(context, false)).toEqual(context);
  });

  it('does not modify the object it was given', () => {
    const context = { user_id: 12345, course_id: 123456 };
    sanitizeContext(context, true);
    expect(context).toEqual({ user_id: 12345, course_id: 123456 });
  });
});

describe('URL sanitization', () => {
  it('replaces numeric path segments', () => {
    expect(sanitizeUrl('/courses/12345/users/678')).toBe('/courses/***/users/***');
  });

  it('preserves non-numeric path segments', () => {
    expect(sanitizeUrl('/courses/assignments/submissions')).toBe('/courses/assignments/submissions');
  });

  it('sanitizes full URLs with host and path', () => {
    const result = sanitizeUrl('https://canvas.example.com/api/v1/courses/12345/users/678');
    expect(result).toBe('https://canvas.example.com/api/v1/courses/***/users/***');
    expect(result).toContain('/courses/***');
    expect(result).toContain('/users/***');
    expect(result).not.toContain('12345');
    expect(result).not.toContain('678');
  });

  it('removes embedded credentials, query and fragment', () => {
    // Presigned URL secrets must never reach request logs.
    const url =
      'https://service:password@storage.example/upload/12345' +
      '?X-Amz-Credential=ABCD1234&X-Amz-Signature=secret#fragment';
    expect(sanitizeUrl(url)).toBe('https://storage.example/upload/***');
  });

  it('strips the query and fragment from a bare path', () => {
    expect(sanitizeUrl('/courses/42/files?access_token=abc#top')).toBe('/courses/***/files');
    expect(sanitizeUrl('/upload?X-Amz-Signature=secret')).toBe('/upload');
    expect(sanitizeUrl('https://storage.example/upload?X-Amz-Credential=ABCD1234&X-Amz-Signature=secret')).toBe(
      'https://storage.example/upload',
    );
  });

  it('keeps identifiers that are not numeric', () => {
    expect(sanitizeUrl('/courses/sis_course_id:ABC/pages/week-1')).toBe('/courses/sis_course_id:ABC/pages/week-1');
  });

  it('masks digits written in other scripts, as Python does', () => {
    expect(sanitizeUrl('/courses/١٢٣/users/４５６')).toBe('/courses/***/users/***');
  });

  it('leaves the host alone (deviation: upstream also masks a host that starts with a digit)', () => {
    expect(sanitizeUrl('https://1host.example/courses/9')).toBe('https://1host.example/courses/***');
    expect(sanitizeUrl('https://user@10.0.0.1:8443/x/77?y=1')).toBe('https://10.0.0.1:8443/x/***');
  });

  it('handles the empty string', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});

describe('redactSecrets', () => {
  it('replaces a raw secret everywhere it occurs', () => {
    expect(redactSecrets(`Bearer ${TOKEN} then ${TOKEN}`, [TOKEN])).toBe('Bearer [REDACTED] then [REDACTED]');
  });

  it('replaces the URL-encoded forms of a secret', () => {
    const secret = 'p@ss word/1+2=3&x~y';
    expect(redactSecrets(`?key=${encodeURIComponent(secret)}&a=1`, [secret])).toBe('?key=[REDACTED]&a=1');
    const form = new URLSearchParams({ key: secret }).toString();
    expect(redactSecrets(form, [secret])).toBe('key=[REDACTED]');
  });

  it('catches a Canvas token whose tilde was percent-encoded', () => {
    // URLSearchParams escapes "~"; encodeURIComponent does not.
    const query = new URLSearchParams({ access_token: TOKEN }).toString();
    expect(query).toContain('7%7E');
    expect(redactSecrets(query, [TOKEN])).toBe('access_token=[REDACTED]');
  });

  it('catches a secret that was JSON-escaped inside a string', () => {
    const secret = 'quote"back\\slash-secret';
    const body = JSON.stringify({ token: secret });
    expect(redactSecrets(body, [secret])).toBe('{"token":"[REDACTED]"}');
  });

  it('ignores empty secrets and leaves other text alone', () => {
    expect(redactSecrets('nothing to hide', ['', TOKEN])).toBe('nothing to hide');
    expect(redactSecrets('abc', [''])).toBe('abc');
    expect(redactSecrets('abc', [])).toBe('abc');
    expect(redactSecrets('', [TOKEN])).toBe('');
  });

  it('removes the longer of two overlapping secrets whole', () => {
    const short = 'abcdefgh';
    const long = 'abcdefgh-and-more';
    expect(redactSecrets(`x ${long} y ${short} z`, [short, long])).toBe('x [REDACTED] y [REDACTED] z');
  });

  it('treats a secret as text, not as a pattern', () => {
    expect(redactSecrets('a.c abc', ['a.c'])).toBe('[REDACTED] abc');
    expect(redactSecrets('($^*+?)', ['($^*+?)'])).toBe('[REDACTED]');
  });

  it('survives a secret that cannot be URL-encoded', () => {
    const lone = 'bad\ud800secret';
    expect(redactSecrets(`x ${lone} y`, [lone])).toBe('x [REDACTED] y');
  });
});

describe('redactSecretsDeep', () => {
  it('redacts every string of a nested value, keys included, and reports each one', () => {
    let redacted = 0;
    const input = {
      note: `token ${TOKEN}`,
      [`key-${TOKEN}`]: 1,
      list: ['clean', { deep: encodeURIComponent(TOKEN) }],
      count: 3,
      flag: true,
      nothing: null,
    };
    const out = redactSecretsDeep(input, [TOKEN], () => {
      redacted += 1;
    });
    expect(out).toEqual({
      note: 'token [REDACTED]',
      'key-[REDACTED]': 1,
      list: ['clean', { deep: '[REDACTED]' }],
      count: 3,
      flag: true,
      nothing: null,
    });
    expect(redacted).toBe(3);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('returns a copy and leaves its input alone', () => {
    const input = { a: [TOKEN] };
    const out = redactSecretsDeep(input, [TOKEN]);
    expect(out).not.toBe(input);
    expect(input.a[0]).toBe(TOKEN);
    expect(redactSecretsDeep('plain', [TOKEN])).toBe('plain');
    expect(redactSecretsDeep(TOKEN, [TOKEN])).toBe('[REDACTED]');
  });

  it('keeps a key named __proto__ as data', () => {
    const input: unknown = JSON.parse(`{"__proto__": {"secret": "${TOKEN}"}, "x": 1}`);
    const out = redactSecretsDeep(input, [TOKEN]);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"secret":"[REDACTED]"},"x":1}');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('identityTag', () => {
  it('is the first 12 hex characters of a keyed hash', () => {
    const tag = identityTag('email:owner@example.edu', 'k'.repeat(32));
    expect(tag).toMatch(/^[0-9a-f]{12}$/);
    expect(tag).toBe(hmacSha256Hex('k'.repeat(32), 'identity-tag|email:owner@example.edu').slice(0, 12));
  });

  it('is stable for one identity and differs between identities and keys', () => {
    const key = 'k'.repeat(32);
    expect(identityTag('id:user-1', key)).toBe(identityTag('id:user-1', key));
    expect(identityTag('id:user-1', key)).not.toBe(identityTag('id:user-2', key));
    expect(identityTag('id:user-1', key)).not.toBe(identityTag('id:user-1', 'j'.repeat(32)));
  });

  it('does not contain the identity', () => {
    expect(identityTag('email:owner@example.edu', 'key')).not.toContain('owner');
  });
});

describe('dataAccessFields', () => {
  it('builds the upstream data access event with a sanitized endpoint', () => {
    expect(dataAccessFields('get', '/courses/12345/users/678', 'success')).toEqual({
      method: 'GET',
      endpoint: '/courses/***/users/***',
      status: 'success',
    });
  });

  it('carries an error only when there is one', () => {
    expect(dataAccessFields('POST', '/courses/1/pages?x=1', 'error', 'HTTP error: 404')).toEqual({
      method: 'POST',
      endpoint: '/courses/***/pages',
      status: 'error',
      error: 'HTTP error: 404',
    });
    expect('error' in dataAccessFields('GET', '/x', 'success', '')).toBe(false);
    expect('error' in dataAccessFields('GET', '/x', 'success', null)).toBe(false);
  });
});

describe('createLogger', () => {
  it('emits one JSON object per line with a timestamp, level and event', () => {
    const { log, lines, events } = capture();
    log.info('tool_call', { tool: 'list_courses', ms: 12, isError: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const [event] = events();
    expect(event).toMatchObject({ level: 'info', event: 'tool_call', tool: 'list_courses', ms: 12, isError: false });
    // ISO 8601 timestamp
    expect(event?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('filters by level and always emits security events', () => {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    for (const [index, level] of order.entries()) {
      const { log, events } = capture({ level });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      log.security('s');
      expect(events().map((event) => event.level)).toEqual([...order.slice(index), 'security']);
    }
  });

  it('adds the base fields to every event and lets call fields override them', () => {
    const { log, events } = capture({ base: { requestId: 'r-1', identity: 'abc123def456', tool: 'base' } });
    log.info('http');
    log.info('tool_call', { tool: 'get_syllabus' });
    expect(events()[0]).toMatchObject({ requestId: 'r-1', identity: 'abc123def456', tool: 'base' });
    expect(events()[1]).toMatchObject({ requestId: 'r-1', tool: 'get_syllabus' });
  });

  it('does not let a field replace the timestamp, level or event', () => {
    const { log, events } = capture();
    log.warn('real_event', { level: 'debug', event: 'spoofed', timestamp: 'never' });
    const [event] = events();
    expect(event?.level).toBe('warn');
    expect(event?.event).toBe('real_event');
    expect(event?.timestamp).not.toBe('never');
  });

  it('applies the PII rules to fields when redaction is on', () => {
    const { log, events } = capture();
    log.info('data_access', { email: 'student@university.edu', name: 'Jane Doe', course_id: 123456, method: 'GET' });
    expect(events()[0]).toMatchObject({ email: '[REDACTED]', name: '[REDACTED]', course_id: '***3456', method: 'GET' });
  });

  it('applies the PII rules to nested objects too', () => {
    const { log, lines, events } = capture();
    log.info('nested', { detail: { email: 'student@university.edu', rows: [{ name: 'Jane Doe', course_id: 123456 }] } });
    expect(lines[0]).not.toContain('Jane Doe');
    expect(lines[0]).not.toContain('student@university.edu');
    expect(events()[0]?.detail).toEqual({ email: '[REDACTED]', rows: [{ name: '[REDACTED]', course_id: '***3456' }] });
  });

  it('leaves PII keys alone when redaction is off, but still removes secrets', () => {
    const { log, lines, events } = capture({ redactPii: false, secrets: [TOKEN] });
    log.info('debugging', { email: 'student@university.edu', course_id: 123456, note: `token ${TOKEN}` });
    expect(events()[0]).toMatchObject({ email: 'student@university.edu', course_id: 123456, note: 'token [REDACTED]' });
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('removes secrets from every string: values, nested values, keys and the event name', () => {
    const confirm = 'c'.repeat(40);
    const { log, lines } = capture({ secrets: [TOKEN, confirm] });
    log.error(`failed with ${TOKEN}`, {
      url: `https://canvas.example.edu/api/v1/courses?access_token=${encodeURIComponent(TOKEN)}`,
      nested: { deep: [`Bearer ${TOKEN}`, { header: `x ${confirm}` }] },
      [`key-${confirm}`]: 1,
    });
    log.security('probe', { detail: new URLSearchParams({ t: TOKEN }).toString() });
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(confirm);
      expect(line).not.toContain('7%7E');
    }
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('removes secrets from base fields as well', () => {
    const { log, lines } = capture({ secrets: [TOKEN], base: { origin: `https://x/?t=${TOKEN}` } });
    log.info('http');
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('logs an error as its name and a bounded, scrubbed message, without the stack', () => {
    const { log, lines, events } = capture({ secrets: [TOKEN] });
    const failure = new TypeError(`"Bearer ${TOKEN}" is an invalid header value. ${'x'.repeat(1000)}`);
    log.error('tool_failed', { error: failure });
    const logged = events()[0]?.error as { name: string; message: string; stack?: string };
    expect(logged.name).toBe('TypeError');
    expect(logged.message).toContain('[REDACTED]');
    expect(logged.message.length).toBeLessThanOrEqual(303);
    expect(logged.stack).toBeUndefined();
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain('logging.test.ts');
  });

  it('serializes values JSON cannot carry and never throws', () => {
    const cyclic: Record<string, unknown> = { label: 'loop' };
    cyclic.self = cyclic;
    const { log, events } = capture();
    expect(() =>
      log.info('odd', {
        big: 10n,
        when: new Date('2026-01-02T03:04:05.000Z'),
        missing: undefined,
        fn: () => 1,
        bytes: new Uint8Array(3),
        cyclic,
      }),
    ).not.toThrow();
    const [event] = events();
    expect(event).toMatchObject({ big: '10', when: '2026-01-02T03:04:05.000Z', fn: '[function]', bytes: '[binary 3 bytes]' });
    expect(event && 'missing' in event).toBe(false);
    expect(JSON.stringify(event?.cyclic)).toContain('[Truncated]');
  });

  it('never throws when the sink fails', () => {
    const log = createLogger({
      level: 'info',
      redactPii: true,
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => log.info('x')).not.toThrow();
    expect(() => log.security('y')).not.toThrow();
  });

  it('writes to console.log by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger({ level: 'info', redactPii: true }).info('hello', { n: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line)).toMatchObject({ level: 'info', event: 'hello', n: 1 });
  });

  it('keeps no state between loggers', () => {
    const first = capture({ secrets: [TOKEN], base: { requestId: 'a' } });
    const second = capture({ base: { requestId: 'b' } });
    first.log.info('one');
    second.log.info('two', { note: TOKEN });
    expect(first.events()).toHaveLength(1);
    expect(second.events()[0]).toMatchObject({ requestId: 'b', note: TOKEN });
  });
});
