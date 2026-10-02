// Shared output conventions from upstream's read tools. No Canvas data is cached here.
import { pythonTextOrEmpty } from '../core/python-text';

export const READ_ONLY = Object.freeze({
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const);

export const COURSE_IDENTIFIER = Object.freeze({ kind: 'id', description: 'Course code or Canvas ID' } as const);

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
}

/** Python f-string values: an explicit null stays None; a missing key takes its default. */
export function field(obj: Record<string, unknown>, key: string, fallback: unknown = 'N/A'): string {
  const value = Object.hasOwn(obj, key) ? obj[key] : fallback;
  return value === null || value === undefined ? 'None' : pythonTextOrEmpty(value);
}

/** Ports self_identity._own_roles: long-form role first, stable de-duplication. */
export function ownRoles(course: Record<string, unknown>): string[] {
  const roles = records(course.enrollments).map((entry) => entry.role || entry.type).filter(Boolean).map(String);
  return [...new Set(roles)];
}

/** Python slices count Unicode code points rather than UTF-16 code units. */
export function capCharacters(text: string, max: number | undefined): string {
  if (max === undefined) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('') + `\n\n...[truncated at ${max} characters]`;
}

/** Python .1f rounds exact ties to even; only quarter fractions are exact binary ties at this precision. */
export function oneDecimal(value: number): string {
  const absolute = Math.abs(value);
  const fraction = absolute % 1;
  if (fraction !== 0.25 && fraction !== 0.75) return Object.is(value, -0) ? '-0.0' : value.toFixed(1);
  const lower = Math.floor(absolute * 10);
  const rounded = (lower % 2 === 0 ? lower : lower + 1) / 10;
  return (value < 0 ? '-' : '') + rounded.toFixed(1);
}
