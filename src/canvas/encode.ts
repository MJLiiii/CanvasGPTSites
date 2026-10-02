// Ports the query and form encoding of canvas_mcp/core/client.py (make_canvas_request,
// GET/POST/PUT/DELETE branches) together with the httpx value rules those branches rely on.
import type { FormBody, Params, Scalar } from '../types';

/** httpx `primitive_value_to_str`: True/False become "true"/"false", None becomes "". */
function scalarToString(value: Scalar): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null) return '';
  return String(value);
}

function appendValue(out: URLSearchParams, key: string, value: Scalar | Scalar[] | undefined): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    // A list becomes one pair per item, in order; an empty list sends nothing.
    for (const item of value) {
      if (item !== undefined) out.append(key, scalarToString(item));
    }
    return;
  }
  out.append(key, scalarToString(value));
}

/** Query string for GET and DELETE, without the leading "?". Empty when there is nothing to send. */
export function buildQuery(params?: Params): string {
  const out = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      appendValue(out, key, value);
    }
  }
  return out.toString();
}

/**
 * `application/x-www-form-urlencoded` body for POST and PUT with `useFormData`.
 * A tuple list keeps its order and its duplicate keys, which is how repeated
 * fields such as `module[prerequisite_module_ids][]` are sent.
 */
export function buildFormBody(body: FormBody): URLSearchParams {
  const out = new URLSearchParams();
  if (Array.isArray(body)) {
    for (const [key, value] of body) {
      appendValue(out, key, value);
    }
    return out;
  }
  for (const [key, value] of Object.entries(body)) {
    appendValue(out, key, value);
  }
  return out;
}
