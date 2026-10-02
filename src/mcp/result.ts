// Ports canvas-mcp src/canvas_mcp/core/tool_results.py (the isError contract). Size limiting and the truncation backstop are new.
import { NARROW_REQUEST_HINT, TRUNCATION_REASON_TEXT } from '../canvas/truncation';
import { pythonLstrip } from '../core/python-text';
import { FENCE_TEXT_END, closeOpenFence } from '../core/untrusted-content';
import type { ToolOutput, ToolResult, TruncationRecord } from '../types';

export interface ToToolResultOptions {
  /** Largest text block, in UTF-8 bytes, that may be returned (MAX_TOOL_RESULT_BYTES). */
  maxBytes: number;
}

export interface MappedOutput {
  result: ToolResult;
  /** Text output was cut at a line boundary to fit `maxBytes`. */
  cut: boolean;
  /** JSON output was over `maxBytes` and was replaced by an error asking for a narrower request. */
  refused: boolean;
}

export { NARROW_REQUEST_HINT };
export type { TruncationRecord };

const WARNING_SIGN = '⚠️';
const CROSS_MARK = '❌';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON value a text holds, or undefined. Only texts that open an object or array are parsed. */
function parseJsonContainer(text: string): unknown {
  const candidate = pythonLstrip(text);
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return undefined;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Upstream `_text_is_error`: a text result is a failure when, after leading
 * whitespace, it starts with "Error" or the cross mark, or when it is a JSON
 * object with a top-level "error" key.
 */
export function textIsError(text: string): boolean {
  // Python's lstrip, which differs from JS `trimStart` at the edges.
  const candidate = pythonLstrip(text);
  if (candidate.startsWith('Error') || candidate.startsWith(CROSS_MARK)) {
    return true;
  }
  // Only an object can carry the key, so nothing else needs parsing.
  if (!candidate.startsWith('{')) return false;
  const parsed = parseJsonContainer(candidate);
  return isPlainObject(parsed) && Object.hasOwn(parsed, 'error');
}

/** A failed tool result with exactly this text. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function sizeNotice(total: number, maxBytes: number): string {
  return (
    `\n\n${WARNING_SIGN} Output truncated: the full result is ${total} bytes and the limit is ${maxBytes} bytes, ` +
    `so the end is missing. ${NARROW_REQUEST_HINT}`
  );
}

/**
 * Cut `text` to fit `maxBytes` including the notice: at the last line break
 * that fits, else at a character boundary (the cut is made on UTF-8 bytes, so
 * a surrogate pair is kept or dropped whole). A fence left open by the cut is
 * closed before the notice, so the notice never reads as Canvas content.
 */
function cutText(text: string, total: number, maxBytes: number): string {
  const notice = sizeNotice(total, maxBytes);
  const room = maxBytes - utf8Length(notice) - utf8Length(FENCE_TEXT_END) - 1;
  if (room <= 0) {
    return notice.trimStart();
  }
  const bytes = encoder.encode(text);
  let end = Math.min(room, bytes.length);
  // `end` is the first byte left out; a continuation byte there means a split character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  // A negative start index would count from the end of the array, so 0 is handled apart.
  const lineBreak = end > 0 ? bytes.lastIndexOf(0x0a, end - 1) : -1;
  // A line boundary is preferred, but not at the price of most of the room: one
  // very long line (minified HTML inside a fence) would leave only the fence header.
  if (lineBreak > 0 && lineBreak >= end / 2) end = lineBreak;
  const kept = new TextDecoder().decode(bytes.subarray(0, end));
  return closeOpenFence(kept) + notice;
}

function tooLargeResult(total: number, maxBytes: number): ToolResult {
  return errorResult(
    `Error: the result is too large to return (${total} bytes; the limit is ${maxBytes} bytes). ` +
      'It is JSON, which is never cut short because a partial document cannot be read. ' +
      `${NARROW_REQUEST_HINT} If the tool has a limit parameter, lower it.`,
  );
}

/**
 * Map a handler's output to an MCP tool result.
 *
 * - a string becomes one text block and no `structuredContent`
 * - an object becomes its JSON text plus `structuredContent`
 * - `isError` follows upstream's CanvasToolResultMiddleware
 * - text over `maxBytes` is cut at a line boundary with an explicit notice;
 *   JSON over `maxBytes` (an object, or a string holding a JSON document) is
 *   refused instead, because tools are responsible for trimming their arrays
 */
export function mapToolOutput(output: ToolOutput, opts: ToToolResultOptions): MappedOutput {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : 0;

  if (typeof output === 'string') {
    const isError = textIsError(output);
    const total = utf8Length(output);
    if (total <= maxBytes) {
      return { result: { content: [{ type: 'text', text: output }], isError }, cut: false, refused: false };
    }
    if (parseJsonContainer(output) !== undefined) {
      return { result: tooLargeResult(total, maxBytes), cut: false, refused: true };
    }
    return {
      result: { content: [{ type: 'text', text: cutText(output, total, maxBytes) }], isError },
      cut: true,
      refused: false,
    };
  }

  if (!isPlainObject(output)) {
    return { result: errorResult('Error: the tool returned no usable output.'), cut: false, refused: false };
  }
  let text: string;
  try {
    text = JSON.stringify(output);
  } catch {
    return {
      result: errorResult('Error: the tool returned a value that cannot be written as JSON.'),
      cut: false,
      refused: false,
    };
  }
  const total = utf8Length(text);
  if (total > maxBytes) {
    return { result: tooLargeResult(total, maxBytes), cut: false, refused: true };
  }
  return {
    result: {
      content: [{ type: 'text', text }],
      structuredContent: output,
      isError: Object.hasOwn(output, 'error'),
    },
    cut: false,
    refused: false,
  };
}

export function toToolResult(output: ToolOutput, opts: ToToolResultOptions): ToolResult {
  return mapToolOutput(output, opts).result;
}

/**
 * The notice for truncated lists a tool did not disclose itself (empty when
 * there are none). Tools normally call `canvas.disclose`; this is the backstop
 * that keeps a forgotten call from presenting a partial list as complete.
 */
export function undisclosedTruncationNotice(records: ReadonlyArray<TruncationRecord>): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.disclosed) continue;
    const reason = TRUNCATION_REASON_TEXT[record.reason] ?? 'a limit was reached';
    const line =
      `${WARNING_SIGN} Results truncated: the list of ${record.label} is incomplete because ${reason}; ` +
      `more exist in Canvas. ${NARROW_REQUEST_HINT}`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.join('\n');
}

function markTruncated(obj: Record<string, unknown>): Record<string, unknown> {
  // A tool's own truncation details are kept; only an absent flag or a wrong `false` is set.
  if (Object.hasOwn(obj, 'truncated') && obj.truncated !== false) return obj;
  return { ...obj, truncated: true };
}

/**
 * Add the undisclosed-truncation disclosure to a handler's output: the notice
 * for text, `"truncated": true` for an object. A string that holds a JSON
 * object gets the flag too (re-serialized, keeping its indentation style), so
 * that it stays a JSON document.
 */
export function withTruncationDisclosure(output: ToolOutput, records: ReadonlyArray<TruncationRecord>): ToolOutput {
  const notice = undisclosedTruncationNotice(records);
  if (notice === '') return output;
  if (typeof output !== 'string') {
    return isPlainObject(output) ? markTruncated(output) : output;
  }
  const parsed = parseJsonContainer(output);
  if (isPlainObject(parsed)) {
    return JSON.stringify(markTruncated(parsed), null, output.includes('\n') ? 2 : undefined);
  }
  return `${output}\n\n${notice}`;
}
