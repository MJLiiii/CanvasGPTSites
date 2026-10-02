// Ports canvas-mcp tests/security/test_input_validation.py, plus the ParamSpec-driven schema and argument coercion.
import { describe, expect, it } from 'vitest';
import {
  buildInputSchema,
  coerceArgs,
  coerceCanvasId,
  coerceValue,
  formatError,
  isErrorResponse,
} from '../../src/core/validation';
import type { ParamSpec, ParamSpecs } from '../../src/types';

const INT: ParamSpec = { kind: 'int', description: 'n' };
const FLOAT: ParamSpec = { kind: 'float', description: 'x' };
const STR: ParamSpec = { kind: 'string', description: 's' };
const BOOL: ParamSpec = { kind: 'bool', description: 'b' };
const ID: ParamSpec = { kind: 'id', description: 'i' };
const LIST: ParamSpec = { kind: 'list', items: 'string', description: 'l' };
const ID_LIST: ParamSpec = { kind: 'list', items: 'id', description: 'l' };
const OBJECT_LIST: ParamSpec = { kind: 'list', items: 'object', description: 'l' };
const DICT: ParamSpec = { kind: 'dict', description: 'd' };
const LEVEL: ParamSpec = { kind: 'enum', values: ['names', 'signatures', 'full'], description: 'e' };

function value(name: string, spec: ParamSpec, input: unknown): unknown {
  const result = coerceValue(name, spec, input);
  if (!result.ok) throw new Error(`expected a value, got: ${result.error}`);
  return result.value;
}

function error(name: string, spec: ParamSpec, input: unknown): string {
  const result = coerceValue(name, spec, input);
  if (result.ok) throw new Error(`expected an error, got: ${JSON.stringify(result.value)}`);
  return result.error;
}

function argsError(specs: ParamSpecs, raw: unknown): string {
  const result = coerceArgs(specs, raw);
  if (result.ok) throw new Error(`expected an error, got: ${JSON.stringify(result.value)}`);
  return result.error;
}

describe('parameter validation (TC-5.1)', () => {
  it('rejects a string that cannot convert to int', () => {
    expect(error('course_id', INT, 'not_a_number')).toBe(
      "Parameter 'course_id' with value 'not_a_number' could not be converted to int",
    );
  });

  it('rejects None for a required parameter', () => {
    expect(error('required_param', STR, null)).toBe("Parameter 'required_param' cannot be None");
    expect(error('required_param', STR, undefined)).toBe("Parameter 'required_param' cannot be None");
  });

  it('handles boundary integers', () => {
    const large = 2 ** 31;
    expect(value('id', INT, String(large))).toBe(large);
    expect(value('id', INT, '-1')).toBe(-1);
    expect(value('id', INT, '+7')).toBe(7);
    expect(value('id', INT, ' 42 ')).toBe(42);
    expect(value('id', INT, 42)).toBe(42);
  });

  it('passes special characters through unchanged', () => {
    const special = "'; DROP TABLE students; --";
    expect(value('text', STR, special)).toBe(special);
  });

  it('accepts an empty string for str but not for int or float', () => {
    expect(value('optional', STR, '')).toBe('');
    expect(error('required', INT, '')).toBe("Parameter 'required' with value '' could not be converted to int");
    expect(error('required', INT, '   ')).toContain('could not be converted to int');
    expect(error('required', FLOAT, '')).toBe("Parameter 'required' with value '' could not be converted to float");
  });

  it('validates enum values', () => {
    for (const v of ['names', 'signatures', 'full']) {
      expect(value('detail_level', LEVEL, v)).toBe(v);
    }
    expect(error('detail_level', LEVEL, 'invalid')).toBe(
      "Parameter 'detail_level' with value 'invalid' is not one of the allowed values: 'names', 'signatures', 'full'",
    );
    expect(error('detail_level', LEVEL, 'Names')).toContain('allowed values');
    expect(error('detail_level', LEVEL, 3)).toContain('with value 3 is not one of the allowed values');
  });
});

describe('injection prevention (TC-5.2)', () => {
  it.each([
    "'; DROP TABLE students; --",
    "1' OR '1'='1",
    "admin'--",
    "' OR 1=1--",
    '; ls -la',
    '| cat /etc/passwd',
    '&& rm -rf /',
    '`whoami`',
    '$(whoami)',
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    '/etc/passwd',
    'C:\\Windows\\System32',
    './../...//..//etc/passwd',
    "<script>alert('XSS')</script>",
    "<img src=x onerror=alert('XSS')>",
    "javascript:alert('XSS')",
    "<iframe src='javascript:alert(1)'>",
    "'-alert(1)-'",
  ])('treats %j as a literal string', (attempt) => {
    expect(value('param', STR, attempt)).toBe(attempt);
  });
});

describe('parameter sanitization', () => {
  it('keeps whitespace in strings', () => {
    expect(value('param', STR, '  value  ')).toBe('  value  ');
  });

  it.each(['Hello 世界', 'Привет мир', 'مرحبا العالم', '🎉🚀💯'])('keeps the Unicode string %j', (text) => {
    expect(value('text', STR, text)).toBe(text);
  });

  it('handles a very long string', () => {
    const long = 'A'.repeat(1_000_000);
    expect(value('text', STR, long)).toHaveLength(1_000_000);
  });

  it('does not echo a huge rejected value back whole', () => {
    const message = error('n', INT, 'x'.repeat(5000));
    expect(message.length).toBeLessThan(400);
    expect(message).toContain('could not be converted to int');
  });
});

describe('type coercion', () => {
  it('converts integer strings safely', () => {
    expect(value('id', INT, '12345')).toBe(12345);
    expect(error('id', INT, 'not_a_number')).toContain('could not be converted to int');
  });

  it('rejects non-integers, booleans and containers for int', () => {
    for (const bad of ['3.5', '1e3', '0x10', '1_000', 3.5, Number.NaN, Number.POSITIVE_INFINITY, true, [], {}]) {
      expect(coerceValue('n', INT, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(error('n', INT, '99999999999999999999')).toContain('could not be converted to int');
  });

  it('converts numeric strings to float', () => {
    expect(value('x', FLOAT, '3.5')).toBe(3.5);
    expect(value('x', FLOAT, ' -2 ')).toBe(-2);
    expect(value('x', FLOAT, '1e3')).toBe(1000);
    expect(value('x', FLOAT, '.5')).toBe(0.5);
    expect(value('x', FLOAT, 7)).toBe(7);
    expect(error('x', FLOAT, 'abc')).toBe("Parameter 'x' with value 'abc' could not be converted to float");
    for (const bad of ['inf', 'nan', 'Infinity', '1,5', true, null, Number.NaN]) {
      expect(coerceValue('x', FLOAT, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps strings that look like other types as strings', () => {
    for (const input of ['[object Object]', 'true', 'null']) {
      expect(value('param', STR, input)).toBe(input);
    }
  });

  it('converts a non-string to a string for str', () => {
    expect(value('param', STR, { __proto__: 'malicious' })).toBeTypeOf('string');
    expect(value('param', STR, { a: 1 })).toBe('{"a":1}');
    expect(value('param', STR, 12)).toBe('12');
    expect(value('param', STR, false)).toBe('false');
  });
});

describe('ids', () => {
  it('delivers ids as strings', () => {
    expect(value('course_identifier', ID, '12345')).toBe('12345');
    expect(value('course_identifier', ID, 12345)).toBe('12345');
    expect(value('course_identifier', ID, 'CS101_2026')).toBe('CS101_2026');
    expect(value('course_identifier', ID, 'sis_course_id:ABC')).toBe('sis_course_id:ABC');
  });

  it('rejects booleans, fractions and containers', () => {
    expect(error('assignment_id', ID, true)).toBe(
      "Parameter 'assignment_id' with value 'true' (type: boolean) could not be converted to any of the expected types: string, integer",
    );
    for (const bad of [false, 1.5, Number.NaN, 2 ** 60, [], {}, ['1']]) {
      expect(coerceValue('assignment_id', ID, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts only ASCII digits as a Canvas object id', () => {
    expect(coerceCanvasId('123')).toBe('123');
    expect(coerceCanvasId(123)).toBe('123');
    expect(coerceCanvasId(' 42 ')).toBe('42');
    for (const bad of ['123/submissions/456?', '12a', '', ' ', '-1', '1.0', '１２３', '%2e%2e', '..', 'self', '1 2']) {
      expect(coerceCanvasId(bad), bad).toBeNull();
    }
    expect(coerceCanvasId(1.5)).toBeNull();
    expect(coerceCanvasId(-3)).toBeNull();
  });
});

describe('bool conversion', () => {
  it('passes booleans through', () => {
    expect(value('flag', BOOL, true)).toBe(true);
    expect(value('flag', BOOL, false)).toBe(false);
  });

  it.each(['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', '1', 't', 'T', 'y', 'Y'])('reads %j as true', (text) => {
    expect(value('flag', BOOL, text)).toBe(true);
  });

  it.each(['false', 'False', 'FALSE', 'no', 'No', 'NO', '0', 'f', 'F', 'n', 'N'])('reads %j as false', (text) => {
    expect(value('flag', BOOL, text)).toBe(false);
  });

  it('trims whitespace before matching', () => {
    expect(value('flag', BOOL, '  true  ')).toBe(true);
    expect(value('flag', BOOL, '\tfalse\n')).toBe(false);
  });

  it.each(['maybe', '2', '', 'truthy', 'nope', 'on', 'off'])('rejects the string %j', (text) => {
    expect(error('flag', BOOL, text)).toBe(`Parameter 'flag' with value '${text}' could not be converted to bool`);
  });

  it('coerces numbers: zero is false, anything else is true', () => {
    expect(value('flag', BOOL, 0)).toBe(false);
    expect(value('flag', BOOL, 1)).toBe(true);
    expect(value('flag', BOOL, -1)).toBe(true);
    expect(value('flag', BOOL, 42)).toBe(true);
    expect(value('flag', BOOL, 0.0)).toBe(false);
    expect(value('flag', BOOL, 1.5)).toBe(true);
  });

  it('rejects unsupported types', () => {
    for (const bad of [[], {}]) {
      expect(error('flag', BOOL, bad)).toContain('could not be converted to bool');
    }
    expect(coerceValue('flag', BOOL, null).ok).toBe(false);
  });
});

describe('list conversion', () => {
  it('passes lists through', () => {
    expect(value('ids', ID_LIST, [1, 2, 3])).toEqual(['1', '2', '3']);
    expect(value('names', LIST, ['alice', 'bob'])).toEqual(['alice', 'bob']);
    expect(value('ids', LIST, [])).toEqual([]);
  });

  it('parses JSON array strings', () => {
    expect(value('ids', ID_LIST, '[1, 2, 3]')).toEqual(['1', '2', '3']);
    expect(value('names', LIST, '["alice", "bob"]')).toEqual(['alice', 'bob']);
    expect(value('ids', LIST, '[]')).toEqual([]);
  });

  it('falls through to a comma split when the string is not a JSON array', () => {
    expect(value('data', LIST, '{"key": "val"}')).toEqual(['{"key": "val"}']);
    expect(value('ids', LIST, '1,2,3')).toEqual(['1', '2', '3']);
    expect(value('ids', LIST, ' a , b , c ')).toEqual(['a', 'b', 'c']);
    expect(value('ids', LIST, 'hello')).toEqual(['hello']);
    expect(value('ids', LIST, '')).toEqual([]);
    expect(value('ids', LIST, 'a,,b,')).toEqual(['a', 'b']);
  });

  it('rejects values that are neither a list nor a string', () => {
    for (const bad of [123, 4.5, true, {}]) {
      expect(error('ids', LIST, bad)).toContain('could not be converted to list');
    }
    expect(coerceValue('ids', LIST, null).ok).toBe(false);
  });

  it('delivers string and id items as strings and rejects other item types', () => {
    expect(value('tags', LIST, ['a', 1, 2.5])).toEqual(['a', '1', '2.5']);
    expect(error('tags', LIST, ['a', { b: 1 }])).toBe(
      "Parameter 'tags' item 1 with value '{\"b\":1}' (type: object) could not be converted to str",
    );
    expect(error('tags', LIST, '[[1, 2], [3, 4]]')).toContain("item 0 with value '[1,2]' (type: array)");
    expect(error('ids', ID_LIST, [1, true])).toBe(
      "Parameter 'ids' item 1 with value 'true' (type: boolean) could not be converted to any of the expected types: string, integer",
    );
    expect(coerceValue('ids', ID_LIST, [1.5]).ok).toBe(false);
    expect(coerceValue('ids', LIST, [null]).ok).toBe(false);
  });

  it('accepts only objects in an object list', () => {
    expect(value('rows', OBJECT_LIST, [{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(value('rows', OBJECT_LIST, '[{"a": 1}]')).toEqual([{ a: 1 }]);
    expect(error('rows', OBJECT_LIST, [{ a: 1 }, 'x'])).toBe(
      "Parameter 'rows' item 1 with value 'x' could not be converted to dict",
    );
    expect(coerceValue('rows', OBJECT_LIST, 'a,b').ok).toBe(false);
    expect(coerceValue('rows', OBJECT_LIST, [[1]]).ok).toBe(false);
    expect(coerceValue('rows', OBJECT_LIST, [null]).ok).toBe(false);
  });
});

describe('dict conversion', () => {
  it('accepts an object or a JSON object string', () => {
    expect(value('data', DICT, { a: 1 })).toEqual({ a: 1 });
    expect(value('data', DICT, '{"a": {"b": [1, 2]}}')).toEqual({ a: { b: [1, 2] } });
  });

  it("uses upstream's wording for each failure", () => {
    expect(error('data', DICT, '[1, 2]')).toBe("Parameter 'data' parsed as JSON but is not a dict");
    expect(error('data', DICT, 'null')).toBe("Parameter 'data' parsed as JSON but is not a dict");
    expect(error('data', DICT, 'not json')).toBe(
      "Parameter 'data' with value 'not json' could not be parsed as JSON dict",
    );
    expect(error('data', DICT, 5)).toBe("Parameter 'data' with value '5' could not be converted to dict");
    expect(error('data', DICT, [1])).toBe("Parameter 'data' with value '[1]' could not be converted to dict");
  });
});

describe('error helpers', () => {
  it('formats errors consistently', () => {
    expect(formatError('Invalid course ID', 'Course 12345 not found')).toEqual({
      error: 'Invalid course ID',
      details: 'Course 12345 not found',
    });
    expect(formatError('Invalid course ID')).toEqual({ error: 'Invalid course ID' });
    expect(formatError('Invalid course ID', '')).toEqual({ error: 'Invalid course ID' });
    expect(formatError('Invalid course ID', null)).toEqual({ error: 'Invalid course ID' });
  });

  it('recognises an error response', () => {
    expect(isErrorResponse({ error: 'x' })).toBe(true);
    expect(isErrorResponse({ error: '' })).toBe(true);
    expect(isErrorResponse({ error: null })).toBe(true);
    expect(isErrorResponse({ ok: true })).toBe(false);
    expect(isErrorResponse('{"error": "x"}')).toBe(false);
    expect(isErrorResponse(['error'])).toBe(false);
    expect(isErrorResponse(null)).toBe(false);
    expect(isErrorResponse(undefined)).toBe(false);
  });

  it('keeps validation errors free of system details', () => {
    const message = error('secret_param', STR, null);
    expect(message).toContain('secret_param');
    expect(message).not.toContain('File');
    expect(message).not.toMatch(/\bat \w+ \(/);
  });
});

describe('buildInputSchema', () => {
  const specs = {
    course_identifier: { kind: 'id', description: 'The Canvas course code or ID' },
    title: { kind: 'string', description: 'Title' },
    points: { kind: 'float', description: 'Points', optional: true },
    position: { kind: 'int', description: 'Position', optional: true, default: 1 },
    published: { kind: 'bool', description: 'Publish it', optional: true, default: false },
    detail_level: { kind: 'enum', values: ['names', 'full'], description: 'Detail', optional: true, default: 'names' },
    tags: { kind: 'list', items: 'string', description: 'Tags', optional: true },
    user_ids: { kind: 'list', items: 'id', description: 'Users' },
    rows: { kind: 'list', items: 'object', description: 'Rows', optional: true },
    settings: { kind: 'dict', description: 'Settings', optional: true },
  } as const satisfies ParamSpecs;

  it('builds an object schema that forbids unknown properties', () => {
    expect(buildInputSchema(specs)).toEqual({
      type: 'object',
      properties: {
        course_identifier: { type: ['string', 'integer'], description: 'The Canvas course code or ID' },
        title: { type: 'string', description: 'Title' },
        points: { type: 'number', description: 'Points' },
        position: { type: 'integer', description: 'Position', default: 1 },
        published: { type: 'boolean', description: 'Publish it', default: false },
        detail_level: { type: 'string', enum: ['names', 'full'], description: 'Detail', default: 'names' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        user_ids: { type: 'array', items: { type: ['string', 'integer'] }, description: 'Users' },
        rows: { type: 'array', items: { type: 'object' }, description: 'Rows' },
        settings: { type: 'object', description: 'Settings' },
      },
      required: ['course_identifier', 'title', 'user_ids'],
      additionalProperties: false,
    });
  });

  it('builds a valid empty schema for a tool with no parameters', () => {
    expect(buildInputSchema({})).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it('does not require a parameter that has a default', () => {
    const schema = buildInputSchema({ per_page: { kind: 'int', description: 'Page size', default: 50 } });
    expect(schema.required).toEqual([]);
  });

  it('returns a fresh, JSON-serializable schema each time', () => {
    const first = buildInputSchema(specs);
    const second = buildInputSchema(specs);
    expect(first).not.toBe(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    (first.properties as Record<string, { enum?: string[] }>).detail_level?.enum?.push('mutated');
    expect(specs.detail_level.values).toEqual(['names', 'full']);
  });
});

describe('coerceArgs', () => {
  const specs = {
    course_identifier: { kind: 'id', description: 'course' },
    title: { kind: 'string', description: 'title' },
    points: { kind: 'float', description: 'points', optional: true },
    position: { kind: 'int', description: 'position', optional: true, default: 1 },
    published: { kind: 'bool', description: 'published', optional: true, default: false },
    detail_level: { kind: 'enum', values: ['names', 'full'], description: 'detail', optional: true, default: 'names' },
    user_ids: { kind: 'list', items: 'id', description: 'users', optional: true },
    settings: { kind: 'dict', description: 'settings', optional: true },
  } as const satisfies ParamSpecs;

  it('converts every lenient form and applies defaults', () => {
    const result = coerceArgs(specs, {
      course_identifier: 60366,
      title: 'Week 1',
      points: '12.5',
      published: 'yes',
      user_ids: '1, 2,3',
      settings: '{"a": 1}',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        course_identifier: '60366',
        title: 'Week 1',
        points: 12.5,
        position: 1,
        published: true,
        detail_level: 'names',
        user_ids: ['1', '2', '3'],
        settings: { a: 1 },
      },
    });
    if (result.ok) {
      // The handler-facing types follow the specs.
      const course: string = result.value.course_identifier;
      const position: number = result.value.position;
      const points: number | undefined = result.value.points;
      const users: string[] | undefined = result.value.user_ids;
      expect([course, position, points, users?.length]).toEqual(['60366', 1, 12.5, 3]);
    }
  });

  it('leaves an absent optional parameter without a default undefined', () => {
    const result = coerceArgs(specs, { course_identifier: 'CS101', title: 't' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points).toBeUndefined();
      expect(result.value.settings).toBeUndefined();
      expect('points' in result.value).toBe(false);
      expect(result.value.published).toBe(false);
    }
  });

  it('treats an explicit null for an optional parameter as absent', () => {
    const result = coerceArgs(specs, { course_identifier: '1', title: 't', points: null, position: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points).toBeUndefined();
      expect(result.value.position).toBe(1);
    }
  });

  it('reports missing required parameters', () => {
    expect(argsError(specs, { title: 't' })).toBe("Missing required parameter 'course_identifier'");
    expect(argsError(specs, {})).toBe("Missing required parameters: 'course_identifier', 'title'");
    expect(argsError(specs, undefined)).toBe("Missing required parameters: 'course_identifier', 'title'");
    expect(argsError(specs, null)).toBe("Missing required parameters: 'course_identifier', 'title'");
  });

  it('rejects null for a required parameter', () => {
    expect(argsError(specs, { course_identifier: null, title: 't' })).toBe(
      "Parameter 'course_identifier' cannot be None",
    );
  });

  it('rejects unknown keys', () => {
    expect(argsError(specs, { course_identifier: '1', title: 't', extra: 1 })).toBe("Unknown parameter 'extra'");
    expect(argsError(specs, { course_identifier: '1', title: 't', a: 1, b: 2 })).toBe("Unknown parameters: 'a', 'b'");
  });

  it('does not let an inherited or prototype key through', () => {
    const polluted: unknown = JSON.parse('{"course_identifier": "1", "title": "t", "__proto__": {"admin": true}}');
    expect(argsError(specs, polluted)).toBe("Unknown parameter '__proto__'");
    expect(argsError(specs, { course_identifier: '1', title: 't', constructor: 'x' })).toBe(
      "Unknown parameter 'constructor'",
    );
    expect(argsError({ title: STR }, {})).toBe("Missing required parameter 'title'");
    const inherited: unknown = Object.create({ title: 'from the prototype' });
    expect(argsError({ title: STR }, inherited)).toBe("Missing required parameter 'title'");
  });

  it('rejects arguments that are not an object', () => {
    expect(argsError(specs, [])).toBe('Arguments must be an object (got array)');
    expect(argsError(specs, 'course_identifier=1')).toBe('Arguments must be an object (got string)');
    expect(argsError(specs, 5)).toBe('Arguments must be an object (got number)');
  });

  it("returns the first conversion error with upstream's wording", () => {
    expect(argsError(specs, { course_identifier: '1', title: 't', position: 'two', published: 'maybe' })).toBe(
      "Parameter 'position' with value 'two' could not be converted to int",
    );
    expect(argsError(specs, { course_identifier: true, title: 't' })).toContain(
      'could not be converted to any of the expected types: string, integer',
    );
    expect(argsError(specs, { course_identifier: '1', title: 't', detail_level: 'all' })).toBe(
      "Parameter 'detail_level' with value 'all' is not one of the allowed values: 'names', 'full'",
    );
  });

  it('accepts an empty argument object for a tool with no parameters', () => {
    expect(coerceArgs({}, {})).toEqual({ ok: true, value: {} });
    expect(coerceArgs({}, undefined)).toEqual({ ok: true, value: {} });
    expect(argsError({}, { anything: 1 })).toBe("Unknown parameter 'anything'");
  });

  it('never throws on hostile input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(coerceArgs({ title: STR }, { title: cyclic }).ok).toBe(false);
    expect(coerceArgs({ n: INT }, { n: cyclic }).ok).toBe(false);
    expect(coerceArgs({ n: INT }, { n: 10n }).ok).toBe(false);
  });
});
