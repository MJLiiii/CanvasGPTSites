// Pins the port of canvas_mcp/core/write_outcome.py and the error text of
// make_canvas_request (core/client.py), including Python's rendering of the parsed body.
import { describe, expect, it } from 'vitest';
import {
  NO_WRITE_STATUSES,
  failureToWire,
  httpFailure,
  isFailure,
  isThrottled,
  makeFailure,
  notDispatched,
  pythonRepr,
  requestFailed,
} from '../../src/canvas/errors';
import type { RequestFailure } from '../../src/types';

describe('NO_WRITE_STATUSES', () => {
  it('is exactly 400, 401, 403, 404, 422', () => {
    expect([...NO_WRITE_STATUSES].sort((a, b) => a - b)).toEqual([400, 401, 403, 404, 422]);
  });
});

describe('makeFailure', () => {
  it('builds the failure shape', () => {
    expect(makeFailure('boom', 'rejected')).toEqual({ error: 'boom', outcome: 'rejected' });
    expect(Object.keys(makeFailure('boom', 'rejected'))).toEqual(['error', 'outcome']);
  });

  it('carries the optional evidence fields', () => {
    expect(makeFailure('x', 'may_have_written', { status: 429, throttled: true })).toEqual({
      error: 'x',
      outcome: 'may_have_written',
      status: 429,
      throttled: true,
    });
    expect(makeFailure('x', 'not_dispatched', { budgetExhausted: true })).toEqual({
      error: 'x',
      outcome: 'not_dispatched',
      budgetExhausted: true,
    });
  });

  it('never lets extra fields replace the message or the outcome', () => {
    const extra = { error: 'forged', outcome: 'rejected', status: 500 } as unknown as { status: number };
    expect(makeFailure('real', 'may_have_written', extra)).toEqual({
      error: 'real',
      outcome: 'may_have_written',
      status: 500,
    });
  });
});

describe('isFailure', () => {
  it.each([
    [makeFailure('x', 'not_dispatched')],
    [makeFailure('x', 'rejected')],
    [makeFailure('x', 'may_have_written')],
    [httpFailure(404, '')],
    [{ error: 'HTTP error: 500', outcome: 'may_have_written' }],
  ])('accepts %j', (value) => {
    expect(isFailure(value)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    ['HTTP error: 500'],
    [404],
    [[]],
    [[{ error: 'x', outcome: 'rejected' }]],
    [{}],
    [{ id: 1, name: 'Course' }],
    // Untyped error text carries no transport evidence (upstream: "must be treated as uncertain").
    [{ error: 'HTTP error: 400' }],
    [{ error: 'x', outcome: 'success' }],
    [{ error: 'x', outcome: null }],
    [{ error: 42, outcome: 'rejected' }],
    [{ errors: [{ message: 'x' }], outcome: 'rejected' }],
  ])('rejects %j', (value) => {
    expect(isFailure(value)).toBe(false);
  });

  it('narrows a union result', () => {
    const result: { id: number } | RequestFailure = makeFailure('x', 'rejected');
    expect(isFailure(result) ? result.outcome : 'ok').toBe('rejected');
  });
});

describe('failureToWire', () => {
  it('keeps only the public error key', () => {
    const failure = httpFailure(403, '{"status":"unauthorized"}', { throttled: true });
    expect(failureToWire(failure)).toEqual({ error: "HTTP error: 403, Details: {'status': 'unauthorized'}" });
    expect(Object.keys(failureToWire(failure))).toEqual(['error']);
  });
});

describe('httpFailure text', () => {
  it('prints a JSON body the way upstream does', () => {
    expect(
      httpFailure(404, '{"errors":[{"message":"The specified resource does not exist."}],"status":"not_found"}').error,
    ).toBe(
      "HTTP error: 404, Details: {'errors': [{'message': 'The specified resource does not exist.'}], 'status': 'not_found'}",
    );
    expect(httpFailure(403, '{"status":"unauthorized"}').error).toBe(
      "HTTP error: 403, Details: {'status': 'unauthorized'}",
    );
    expect(httpFailure(500, '{"status":"internal_server_error"}').error).toBe(
      "HTTP error: 500, Details: {'status': 'internal_server_error'}",
    );
  });

  it('prints a non-JSON body as text', () => {
    expect(httpFailure(401, 'Unauthorized').error).toBe('HTTP error: 401, Text: Unauthorized');
    expect(httpFailure(403, '403 Forbidden (Rate Limit Exceeded)').error).toBe(
      'HTTP error: 403, Text: 403 Forbidden (Rate Limit Exceeded)',
    );
    expect(httpFailure(502, '<html><body>Bad Gateway</body></html>').error).toBe(
      'HTTP error: 502, Text: <html><body>Bad Gateway</body></html>',
    );
    expect(httpFailure(500, '{"truncated": ').error).toBe('HTTP error: 500, Text: {"truncated": ');
  });

  it('prints an empty body as empty text', () => {
    expect(httpFailure(500, '').error).toBe('HTTP error: 500, Text: ');
    expect(httpFailure(302, '').error).toBe('HTTP error: 302, Text: ');
  });

  it('prints top-level JSON scalars as an f-string would', () => {
    expect(httpFailure(503, '"unavailable"').error).toBe('HTTP error: 503, Details: unavailable');
    expect(httpFailure(500, '[1, "a"]').error).toBe("HTTP error: 500, Details: [1, 'a']");
    expect(httpFailure(500, '42').error).toBe('HTTP error: 500, Details: 42');
    expect(httpFailure(500, 'null').error).toBe('HTTP error: 500, Details: None');
    expect(httpFailure(500, 'true').error).toBe('HTTP error: 500, Details: True');
    expect(httpFailure(500, '  {"a": 1}\n').error).toBe("HTTP error: 500, Details: {'a': 1}");
  });

  it('keeps the markers that upstream tools match on', () => {
    expect(httpFailure(404, '{"errors":[]}').error.startsWith('HTTP error: 404')).toBe(true);
    expect(/^HTTP error: (\d+)/.exec(httpFailure(503, 'busy').error)?.[1]).toBe('503');
    expect(httpFailure(403, '{"status":"unauthorized"}').error.toLowerCase()).toContain('unauthorized');
  });

  it('does not leak a JSON parser message into the text', () => {
    const text = httpFailure(500, '{"token": "abc", oops}').error;
    expect(text).toBe('HTTP error: 500, Text: {"token": "abc", oops}');
    expect(text).not.toMatch(/Unexpected|position|JSON/);
  });

  it('falls back to text when the body is nested too deeply to print', () => {
    const body = `${'['.repeat(200000)}${']'.repeat(200000)}`;
    const failure = httpFailure(500, body);
    expect(failure.error.startsWith('HTTP error: 500, ')).toBe(true);
    expect(failure.outcome).toBe('may_have_written');
  });
});

describe('pythonRepr', () => {
  it('matches CPython for a mixed body', () => {
    // Expected text produced by CPython: print(f"{json.loads(body)}").
    const body =
      '{"a":"it\'s","b":"say \\"hi\\"","c":"both \' and \\"","d":"tab\\there\\nnl",' +
      '"e":"caf\\u00e9 \\u00a0 \\u200b \\ud83d\\ude00 \\u0007","f":1.5e-7,"g":0.00012,"h":true,"i":null,"j":[1,2.5,[]],"k":{}}';
    expect(pythonRepr(JSON.parse(body))).toBe(
      "{'a': \"it's\", 'b': 'say \"hi\"', 'c': 'both \\' and \"', 'd': 'tab\\there\\nnl', " +
        "'e': 'café \\xa0 \\u200b 😀 \\x07', 'f': 1.5e-07, 'g': 0.00012, 'h': True, 'i': None, 'j': [1, 2.5, []], 'k': {}}",
    );
  });

  it.each([
    [null, 'None'],
    [true, 'True'],
    [false, 'False'],
    [0, '0'],
    [-7, '-7'],
    [123456789012, '123456789012'],
    [2.5, '2.5'],
    [1e-5, '1e-05'],
    [-1.25e-10, '-1.25e-10'],
    [1e-100, '1e-100'],
    ['', "''"],
    ['back\\slash', "'back\\\\slash'"],
    ['line\r\n', "'line\\r\\n'"],
    ['\u007f', "'\\x7f'"],
    ['\ud800', "'\\ud800'"],
    ['\u2028', "'\\u2028'"],
    ['\u{e0001}', "'\\U000e0001'"],
    ['日本語', "'日本語'"],
    [[], '[]'],
    [{}, '{}'],
    [{ 'a b': [{ c: null }] }, "{'a b': [{'c': None}]}"],
  ])('renders %j as %s', (value, expected) => {
    expect(pythonRepr(value)).toBe(expected);
  });
});

describe('write outcome classification', () => {
  it.each([400, 401, 403, 404, 422])('%i proves nothing was written', (status) => {
    const failure = httpFailure(status, '');
    expect(failure.outcome).toBe('rejected');
    expect(failure.status).toBe(status);
  });

  it.each([301, 302, 405, 408, 409, 410, 413, 429, 500, 502, 503, 504])('%i may have written', (status) => {
    const failure = httpFailure(status, '');
    expect(failure.outcome).toBe('may_have_written');
    expect(failure.status).toBe(status);
  });

  it('keeps a throttled 403 rejected and a 429 uncertain', () => {
    const headers = new Headers({ 'X-Rate-Limit-Remaining': '0' });
    const body = '403 Forbidden (Rate Limit Exceeded)';
    expect(isThrottled(403, body, headers)).toBe(true);
    expect(httpFailure(403, body, { throttled: true })).toEqual({
      error: 'HTTP error: 403, Text: 403 Forbidden (Rate Limit Exceeded)',
      outcome: 'rejected',
      status: 403,
      throttled: true,
    });
    expect(isThrottled(429, '', new Headers())).toBe(true);
    expect(httpFailure(429, '', { throttled: true }).outcome).toBe('may_have_written');
  });

  it('does not let extra override the real status', () => {
    expect(httpFailure(500, '', { status: 404 }).status).toBe(500);
    expect(httpFailure(500, '', { status: 404 }).outcome).toBe('may_have_written');
  });
});

describe('requestFailed', () => {
  it('uses the upstream prefix and is uncertain', () => {
    expect(requestFailed('reached the network layer')).toEqual({
      error: 'Request failed: reached the network layer',
      outcome: 'may_have_written',
    });
    expect(requestFailed('').error).toBe('Request failed: ');
  });
});

describe('notDispatched', () => {
  it('keeps the message verbatim and proves nothing was sent', () => {
    // test_local_endpoint_rejection_is_structured_without_dispatch
    const failure = notDispatched("Invalid endpoint: '?' is not allowed in a request path");
    expect(isFailure(failure)).toBe(true);
    expect(failure).toEqual({
      error: "Invalid endpoint: '?' is not allowed in a request path",
      outcome: 'not_dispatched',
    });
  });

  it('can flag budget exhaustion', () => {
    expect(notDispatched('budget', { budgetExhausted: true }).budgetExhausted).toBe(true);
  });
});

describe('isThrottled', () => {
  const none = new Headers();

  it('treats every 429 as throttled', () => {
    expect(isThrottled(429, '', none)).toBe(true);
    expect(isThrottled(429, '{"errors":[]}', new Headers({ 'X-Rate-Limit-Remaining': '700' }))).toBe(true);
  });

  it('treats a 403 with the Canvas rate-limit body as throttled', () => {
    expect(isThrottled(403, '403 Forbidden (Rate Limit Exceeded)', none)).toBe(true);
    expect(isThrottled(403, '403 Forbidden (Rate Limit Exceeded)\n', new Headers({ 'X-Rate-Limit-Remaining': '12.5' }))).toBe(
      true,
    );
  });

  it.each(['0', '0.0', '-3.25', ' 0 ', '-0'])('treats a 403 with X-Rate-Limit-Remaining %j as throttled', (remaining) => {
    expect(isThrottled(403, '{"status":"unauthorized"}', new Headers({ 'x-rate-limit-remaining': remaining }))).toBe(true);
  });

  it.each(['0.01', '599.68', '700'])('does not treat a 403 with quota %s left as throttled', (remaining) => {
    expect(isThrottled(403, '{"status":"unauthorized"}', new Headers({ 'X-Rate-Limit-Remaining': remaining }))).toBe(false);
  });

  it.each(['', 'abc', 'NaN', '-', '0x0', '1e-9', '0, 0'])('ignores the unparseable quota header %j', (remaining) => {
    expect(isThrottled(403, 'forbidden', new Headers({ 'X-Rate-Limit-Remaining': remaining }))).toBe(false);
  });

  it('does not treat an ordinary 403 as throttled', () => {
    expect(isThrottled(403, '{"status":"unauthorized","errors":[{"message":"user not authorized"}]}', none)).toBe(false);
    expect(isThrottled(403, 'rate limit exceeded', none)).toBe(false);
  });

  it.each([200, 400, 401, 404, 422, 500, 503])('never treats %i as throttled', (status) => {
    const headers = new Headers({ 'X-Rate-Limit-Remaining': '0' });
    expect(isThrottled(status, '403 Forbidden (Rate Limit Exceeded)', headers)).toBe(false);
  });
});
