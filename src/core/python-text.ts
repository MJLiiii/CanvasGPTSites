// No single upstream file: the places where Python's text handling differs from JavaScript's and the
// port has to reproduce Python's (str.isspace, str.strip, the `\s` of str patterns, json.dumps escaping).

/**
 * Python's `\s` for str patterns (`str.isspace`) as a character class, for
 * building a RegExp. JavaScript's `\s` differs: it has U+FEFF and lacks
 * U+001C to U+001F and U+0085.
 */
export const PYTHON_SPACE_CLASS = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

/** Python's `str.isspace()` for one UTF-16 code unit. Every such character is in the BMP. */
export function isPythonSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Python `str.lstrip()`. */
export function pythonLstrip(text: string): string {
  let start = 0;
  while (start < text.length && isPythonSpace(text.charCodeAt(start))) start += 1;
  return start === 0 ? text : text.slice(start);
}

/** Python `str.strip()`. */
export function pythonStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPythonSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isPythonSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * Rewrite `JSON.stringify` output the way Python's `json.dumps` writes it with
 * its default `ensure_ascii`: every code unit outside printable ASCII, DEL
 * included, becomes `\uXXXX`. Control characters below U+0020 are already
 * escaped by `JSON.stringify`, and so are lone surrogates.
 */
export function escapeNonAsciiJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Python's `\w` for str patterns: `str.isalnum()` or underscore.
const PYTHON_WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Whether the code point at `pos` is a word character in Python's sense (`\w`). False past the end. */
export function isPythonWordCharAt(text: string, pos: number): boolean {
  const codePoint = text.codePointAt(pos);
  return codePoint !== undefined && PYTHON_WORD_CHAR.test(String.fromCodePoint(codePoint));
}

/**
 * A value as the text upstream would print for it, with one difference: null
 * and undefined become the empty string, not "None". Booleans are written as
 * Python writes them (`True`, `False`); a value that cannot be stringified
 * becomes empty.
 */
export function pythonTextOrEmpty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  try {
    return String(value);
  } catch {
    return '';
  }
}
