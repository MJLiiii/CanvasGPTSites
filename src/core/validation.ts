// Ports canvas-mcp src/canvas_mcp/core/validation.py (driven by ParamSpecs instead of Python type hints).
import { canvasId } from '../canvas/path';
import type { InferArgs, ParamSpec, ParamSpecs } from '../types';

// Boolean string constants
const TRUTHY_VALUES: ReadonlySet<string> = new Set(['true', 'yes', '1', 't', 'y']);
const FALSY_VALUES: ReadonlySet<string> = new Set(['false', 'no', '0', 'f', 'n']);

/** Format an error response consistently. */
export function formatError(message: string, details?: string | null): { error: string; details?: string } {
  const result: { error: string; details?: string } = { error: message };
  if (details) {
    result.details = details;
  }
  return result;
}

/** True when the response is an object carrying an `error` key (upstream: a dict with "error"). */
export function isErrorResponse(response: unknown): response is Record<string, unknown> & { error: unknown } {
  return isPlainObject(response) && 'error' in response;
}

/**
 * Return a Canvas ID's canonical digit string, or null if it is not one.
 *
 * `id` parameters accept any string, and these values end up in request paths.
 * Canvas object IDs are plain ASCII digits, so anything else is rejected at the
 * boundary rather than sanitized. (Course identifiers are the exception: they
 * legitimately accept course codes and `sis_course_id:` forms and go through
 * the course resolver instead.)
 *
 * This is upstream's `coerce_canvas_id` shape (null instead of an exception)
 * over the one rule in canvas/path.ts, so the two can never disagree.
 */
export function coerceCanvasId(value: string | number): string | null {
  try {
    return canvasId(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/** A parameter with a default can be left out even when it is not marked optional. */
function isRequired(spec: ParamSpec): boolean {
  return spec.optional !== true && defaultOf(spec) === undefined;
}

function defaultOf(spec: ParamSpec): unknown {
  return 'default' in spec ? spec.default : undefined;
}

function propertySchema(spec: ParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  switch (spec.kind) {
    case 'id':
      schema.type = ['string', 'integer'];
      break;
    case 'string':
      schema.type = 'string';
      break;
    case 'int':
      schema.type = 'integer';
      break;
    case 'float':
      schema.type = 'number';
      break;
    case 'bool':
      schema.type = 'boolean';
      break;
    case 'enum':
      schema.type = 'string';
      schema.enum = [...spec.values];
      break;
    case 'list':
      schema.type = 'array';
      schema.items =
        spec.items === 'id'
          ? { type: ['string', 'integer'] }
          : spec.items === 'object'
            ? { type: 'object' }
            : { type: 'string' };
      break;
    case 'dict':
      schema.type = 'object';
      break;
  }
  schema.description = spec.description;
  const fallback = defaultOf(spec);
  if (fallback !== undefined) {
    schema.default = fallback;
  }
  return schema;
}

/**
 * JSON Schema (draft 2020-12 compatible) for a tool's arguments. The schema
 * advertises the canonical types; `coerceArgs` additionally accepts the lenient
 * forms upstream's `validate_params` accepts.
 */
export function buildInputSchema(specs: ParamSpecs): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const name of Object.keys(specs)) {
    const spec = specs[name];
    if (spec === undefined) continue;
    properties[name] = propertySchema(spec);
    if (isRequired(spec)) {
      required.push(name);
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Type-specific conversion / validation helpers
// ---------------------------------------------------------------------------

export type Coerced<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_ECHOED_VALUE = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a rejected value is shown in an error message; bounded so a huge argument is not echoed back whole. */
function show(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_ECHOED_VALUE ? `${text.slice(0, MAX_ECHOED_VALUE)}...` : text;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const INT_STRING = /^[+-]?[0-9]+$/;
const FLOAT_STRING = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function convertToInt(name: string, value: unknown): Coerced<number> {
  const failure = fail(`Parameter '${name}' with value '${show(value)}' could not be converted to int`);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { ok: true, value } : failure;
  }
  if (typeof value === 'string') {
    // An empty string is rejected: it is not a number, and silently reading it as 0 would be wrong.
    const text = value.trim();
    if (!INT_STRING.test(text)) return failure;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : failure;
  }
  return failure;
}

function convertToFloat(name: string, value: unknown): Coerced<number> {
  const failure = fail(`Parameter '${name}' with value '${show(value)}' could not be converted to float`);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : failure;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!FLOAT_STRING.test(text)) return failure;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : failure;
  }
  return failure;
}

function convertToBool(name: string, value: unknown): Coerced<boolean> {
  if (typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    const lowered = value.toLowerCase().trim();
    if (TRUTHY_VALUES.has(lowered)) return { ok: true, value: true };
    if (FALSY_VALUES.has(lowered)) return { ok: true, value: false };
  } else if (typeof value === 'number') {
    return { ok: true, value: value !== 0 };
  }
  return fail(`Parameter '${name}' with value '${show(value)}' could not be converted to bool`);
}

function convertToString(name: string, value: unknown): Coerced<string> {
  if (typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return { ok: true, value: String(value) };
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return { ok: true, value: JSON.stringify(value) };
    } catch {
      // falls through to the failure below
    }
  }
  return fail(`Parameter '${name}' with value '${show(value)}' could not be converted to str`);
}

/** Upstream types these `str | int`: a string passes through, an integer is stringified. */
function convertToId(name: string, value: unknown): Coerced<string> {
  if (typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { ok: true, value: String(value) };
  }
  return fail(
    `Parameter '${name}' with value '${show(value)}' (type: ${typeName(value)}) ` +
      'could not be converted to any of the expected types: string, integer',
  );
}

function convertToEnum(name: string, value: unknown, allowed: readonly string[]): Coerced<string> {
  if (typeof value === 'string' && allowed.includes(value)) {
    return { ok: true, value };
  }
  const shownValue = typeof value === 'string' ? `'${show(value)}'` : show(value);
  const allowedRepr = allowed.map((entry) => `'${entry}'`).join(', ');
  return fail(`Parameter '${name}' with value ${shownValue} is not one of the allowed values: ${allowedRepr}`);
}

function convertToList(name: string, value: unknown): Coerced<unknown[]> {
  if (Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    // Try to parse as JSON array
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
    } catch {
      // not JSON; try comma-separated values
    }
    return {
      ok: true,
      value: value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    };
  }
  return fail(`Parameter '${name}' with value '${show(value)}' could not be converted to list`);
}

function convertListItems(
  name: string,
  list: unknown[],
  items: 'string' | 'id' | 'object',
): Coerced<string[] | Array<Record<string, unknown>>> {
  if (items === 'object') {
    const out: Array<Record<string, unknown>> = [];
    for (const [index, item] of list.entries()) {
      if (!isPlainObject(item)) {
        return fail(
          `Parameter '${name}' item ${index} with value '${show(item)}' could not be converted to dict`,
        );
      }
      out.push(item);
    }
    return { ok: true, value: out };
  }
  const out: string[] = [];
  for (const [index, item] of list.entries()) {
    const isText = typeof item === 'string';
    const isNumber = typeof item === 'number' && (items === 'id' ? Number.isSafeInteger(item) : Number.isFinite(item));
    if (!isText && !isNumber) {
      const expected = items === 'id' ? 'any of the expected types: string, integer' : 'str';
      return fail(
        `Parameter '${name}' item ${index} with value '${show(item)}' (type: ${typeName(item)}) ` +
          `could not be converted to ${expected}`,
      );
    }
    out.push(String(item));
  }
  return { ok: true, value: out };
}

function convertToDict(name: string, value: unknown): Coerced<Record<string, unknown>> {
  if (isPlainObject(value)) {
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail(`Parameter '${name}' with value '${show(value)}' could not be parsed as JSON dict`);
    }
    if (isPlainObject(parsed)) {
      return { ok: true, value: parsed };
    }
    return fail(`Parameter '${name}' parsed as JSON but is not a dict`);
  }
  return fail(`Parameter '${name}' with value '${show(value)}' could not be converted to dict`);
}

/**
 * Validate and convert one present, non-null value against its spec
 * (upstream `validate_parameter`). Absence, null and defaults are handled by
 * `coerceArgs`.
 */
export function coerceValue(name: string, spec: ParamSpec, value: unknown): Coerced<unknown> {
  if (value === null || value === undefined) {
    return fail(`Parameter '${name}' cannot be None`);
  }
  switch (spec.kind) {
    case 'id':
      return convertToId(name, value);
    case 'string':
      return convertToString(name, value);
    case 'int':
      return convertToInt(name, value);
    case 'float':
      return convertToFloat(name, value);
    case 'bool':
      return convertToBool(name, value);
    case 'enum':
      return convertToEnum(name, value, spec.values);
    case 'list': {
      const list = convertToList(name, value);
      return list.ok ? convertListItems(name, list.value, spec.items) : list;
    }
    case 'dict':
      return convertToDict(name, value);
  }
}

/**
 * Validate a tool call's arguments against its ParamSpecs and convert them to
 * the handler's types (upstream `validate_params`). The first problem found is
 * returned as an error string; nothing is thrown.
 *
 * - an absent optional parameter, or an explicit null for one, takes its
 *   default (or stays undefined)
 * - null for a required parameter, a missing required parameter and an unknown
 *   key are errors
 */
export function coerceArgs<P extends ParamSpecs>(
  specs: P,
  raw: unknown,
): { ok: true; value: InferArgs<P> } | { ok: false; error: string } {
  let input: Record<string, unknown>;
  if (raw === undefined || raw === null) {
    input = {};
  } else if (isPlainObject(raw)) {
    input = raw;
  } else {
    return fail(`Arguments must be an object (got ${typeName(raw)})`);
  }

  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(specs, key));
  if (unknown.length > 0) {
    const names = unknown.map((key) => `'${show(key)}'`).join(', ');
    return fail(unknown.length === 1 ? `Unknown parameter ${names}` : `Unknown parameters: ${names}`);
  }

  const missing = Object.keys(specs).filter((name) => {
    const spec = specs[name];
    return spec !== undefined && isRequired(spec) && !Object.hasOwn(input, name);
  });
  if (missing.length > 0) {
    const names = missing.map((name) => `'${name}'`).join(', ');
    return fail(missing.length === 1 ? `Missing required parameter ${names}` : `Missing required parameters: ${names}`);
  }

  const out: Record<string, unknown> = {};
  for (const name of Object.keys(specs)) {
    const spec = specs[name];
    if (spec === undefined) continue;
    const value: unknown = Object.hasOwn(input, name) ? input[name] : undefined;

    if (value === undefined || value === null) {
      const fallback = defaultOf(spec);
      if (fallback !== undefined) {
        out[name] = fallback;
      } else if (isRequired(spec)) {
        return fail(`Parameter '${name}' cannot be None`);
      }
      continue;
    }

    const converted = coerceValue(name, spec, value);
    if (!converted.ok) {
      return converted;
    }
    out[name] = converted.value;
  }
  return { ok: true, value: out as InferArgs<P> };
}
