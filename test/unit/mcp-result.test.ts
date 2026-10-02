// Ports canvas-mcp tests/core/test_tool_results.py, plus the size-limit and truncation-backstop cases.
import { describe, expect, it } from 'vitest';
import { FENCE_TEXT_END, fenceUntrusted, fenceUntrustedInline } from '../../src/core/untrusted-content';
import {
  NARROW_REQUEST_HINT,
  errorResult,
  mapToolOutput,
  textIsError,
  toToolResult,
  undisclosedTruncationNotice,
  utf8Length,
  withTruncationDisclosure,
} from '../../src/mcp/result';
import type { TruncationRecord } from '../../src/mcp/result';

const ROOMY = { maxBytes: 200_000 };

describe('toToolResult (upstream tool result contract)', () => {
  it.each(['Error: invalid course', '❌ Submission blocked', JSON.stringify({ error: 'invalid course' })])(
    'text error conventions set isError without rewriting: %j',
    (payload) => {
      const result = toToolResult(payload, ROOMY);
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.text).toBe(payload);
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it('a top-level dict error keeps the structured payload and sets isError', () => {
    const result = toToolResult({ error: 'boom', nothing_sent: true }, ROOMY);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'boom', nothing_sent: true });
  });

  it('success text and a nested error field remain successful', () => {
    expect(toToolResult('No errors found', ROOMY).isError).toBe(false);
    expect(toToolResult({ success: true, detail: { error: 'quoted example' } }, ROOMY).isError).toBe(false);
  });

  it('a string result has one text surface and no structured duplicate', () => {
    const result = toToolResult('single copy', ROOMY);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'single copy' }]);
  });

  it('a dictionary result carries its JSON text and structured content', () => {
    const payload = { success: true, detail: { error: 'quoted example' } };
    const result = toToolResult(payload, ROOMY);
    expect(result.structuredContent).toEqual(payload);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(payload) }]);
  });

  it('an existing validation failure text is an error', () => {
    expect(toToolResult('Error: max_chars must be a positive integer', ROOMY).isError).toBe(true);
  });
});

describe('textIsError', () => {
  it('ignores leading whitespace the way Python lstrip does', () => {
    expect(textIsError('  \n\t Error: x')).toBe(true);
    expect(textIsError('\u00a0\u2003❌ blocked')).toBe(true);
    expect(textIsError('\u001c\u0085Error')).toBe(true);
    expect(textIsError(' \n {"error": "x"}')).toBe(true);
  });

  it('does not strip characters Python does not treat as whitespace', () => {
    // U+FEFF is whitespace to JS trimStart but not to Python.
    expect(textIsError('\ufeffError: x')).toBe(false);
    expect(textIsError('\u200bError: x')).toBe(false);
  });

  it('matches the prefix, as upstream does', () => {
    expect(textIsError('Errors found: 0')).toBe(true);
    expect(textIsError('error: lower case')).toBe(false);
    expect(textIsError('No Error here')).toBe(false);
    expect(textIsError('⚠️ Warning only')).toBe(false);
  });

  it('treats only a JSON object with a top-level error key as an error', () => {
    expect(textIsError('{"error": null}')).toBe(true);
    expect(textIsError('{"error": "x", "other": 1}  \n')).toBe(true);
    expect(textIsError('{"errors": ["x"]}')).toBe(false);
    expect(textIsError('{"detail": {"error": "x"}}')).toBe(false);
    expect(textIsError('[{"error": "x"}]')).toBe(false);
    expect(textIsError('"error"')).toBe(false);
    expect(textIsError('{"error": "unterminated')).toBe(false);
    expect(textIsError('{error: "not json"}')).toBe(false);
    expect(textIsError('')).toBe(false);
  });
});

describe('errorResult', () => {
  it('is a failed result with exactly the given text', () => {
    expect(errorResult('Not available')).toEqual({ content: [{ type: 'text', text: 'Not available' }], isError: true });
  });
});

describe('size limit', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'.'.repeat(40)}`);
  const longText = lines.join('\n');

  it('leaves output at the limit untouched', () => {
    const mapped = mapToolOutput('abcd', { maxBytes: 4 });
    expect(mapped.cut).toBe(false);
    expect(mapped.result.content[0]?.text).toBe('abcd');
  });

  it('cuts oversized text at a line boundary, under the limit, with an explicit notice', () => {
    const maxBytes = 2000;
    const mapped = mapToolOutput(longText, { maxBytes });
    const text = mapped.result.content[0]?.text ?? '';
    expect(mapped.cut).toBe(true);
    expect(mapped.refused).toBe(false);
    expect(mapped.result.isError).toBe(false);
    expect(utf8Length(text)).toBeLessThanOrEqual(maxBytes);

    const [kept, notice] = text.split('\n\n⚠️ ');
    expect(notice).toBe(
      `Output truncated: the full result is ${utf8Length(longText)} bytes and the limit is ${maxBytes} bytes, ` +
        `so the end is missing. ${NARROW_REQUEST_HINT}`,
    );
    // Every kept line is a whole line of the original.
    const keptLines = (kept ?? '').split('\n');
    expect(keptLines.length).toBeGreaterThan(5);
    expect(keptLines).toEqual(lines.slice(0, keptLines.length));
  });

  it('keeps the error flag of a cut error text', () => {
    const mapped = mapToolOutput(`Error: too much\n${longText}`, { maxBytes: 1500 });
    expect(mapped.cut).toBe(true);
    expect(mapped.result.isError).toBe(true);
  });

  it('closes a block fence left open by the cut, before the notice', () => {
    const fenced = `Header\n${fenceUntrusted(longText, 'page body')}\nFooter`;
    const text = mapToolOutput(fenced, { maxBytes: 2500 }).result.content[0]?.text ?? '';
    expect(utf8Length(text)).toBeLessThanOrEqual(2500);
    const endAt = text.indexOf(FENCE_TEXT_END);
    const noticeAt = text.indexOf('Output truncated');
    expect(endAt).toBeGreaterThan(0);
    expect(noticeAt).toBeGreaterThan(endAt);
    expect(text.split(FENCE_TEXT_END)).toHaveLength(2);
  });

  it('closes an inline fence left open by the cut', () => {
    const label = fenceUntrustedInline('y'.repeat(5000), 'title');
    const text = mapToolOutput(`Title: ${label}`, { maxBytes: 1200 }).result.content[0]?.text ?? '';
    const noticeAt = text.indexOf('\n\n⚠️ Output truncated');
    expect(noticeAt).toBeGreaterThan(0);
    expect(text.slice(0, noticeAt).endsWith('>>>')).toBe(true);
  });

  it('does not add a fence terminator when the cut falls outside any fence', () => {
    const text = mapToolOutput(longText, { maxBytes: 2000 }).result.content[0]?.text ?? '';
    expect(text).not.toContain(FENCE_TEXT_END);
  });

  it('never splits a multi-byte character when there is no line break to cut at', () => {
    const emoji = '\u{1F600}'.repeat(2000);
    const text = mapToolOutput(emoji, { maxBytes: 1001 }).result.content[0]?.text ?? '';
    expect(utf8Length(text)).toBeLessThanOrEqual(1001);
    expect(text).not.toContain('�');
    const kept = text.slice(0, text.indexOf('\n\n'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toBe('\u{1F600}'.repeat(kept.length / 2));
  });

  it('never splits a surrogate pair inside a fence, and still closes the fence', () => {
    // One long line of astral characters: every one is a surrogate pair in UTF-16 and four bytes in UTF-8.
    const fenced = fenceUntrusted('\u{1F4DA}'.repeat(3000), 'page body');
    for (const maxBytes of [1500, 1501, 1502, 1503]) {
      const text = mapToolOutput(fenced, { maxBytes }).result.content[0]?.text ?? '';
      expect(utf8Length(text)).toBeLessThanOrEqual(maxBytes);
      expect(text).not.toContain('�');
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      const noticeAt = text.indexOf('\n\n⚠️ Output truncated');
      const beforeNotice = text.slice(0, noticeAt);
      expect(beforeNotice.endsWith(`\n${FENCE_TEXT_END}`)).toBe(true);
      // The long line is kept up to the cut instead of being dropped for the sake of a line boundary.
      const books = beforeNotice.match(/\u{1F4DA}/gu) ?? [];
      expect(books.length).toBeGreaterThan(100);
    }
  });

  it('prefers a line boundary only when it keeps most of what fits', () => {
    const shortThenLong = `intro\n${'z'.repeat(5000)}`;
    const text = mapToolOutput(shortThenLong, { maxBytes: 1000 }).result.content[0]?.text ?? '';
    expect(utf8Length(text)).toBeLessThanOrEqual(1000);
    const kept = text.slice(0, text.indexOf('\n\n⚠️ Output truncated'));
    expect(kept.startsWith('intro\nzzz')).toBe(true);
    expect(kept.length).toBeGreaterThan(500);
  });

  it('returns only the notice when the limit is too small for any content', () => {
    const text = mapToolOutput(longText, { maxBytes: 20 }).result.content[0]?.text ?? '';
    expect(text.startsWith('⚠️ Output truncated')).toBe(true);
  });

  it('never cuts an oversized object: it is refused with an error', () => {
    const payload = { rows: Array.from({ length: 300 }, (_, i) => ({ id: i, text: 'x'.repeat(20) })) };
    const mapped = mapToolOutput(payload, { maxBytes: 1000 });
    expect(mapped.refused).toBe(true);
    expect(mapped.cut).toBe(false);
    expect(mapped.result.isError).toBe(true);
    expect(mapped.result.structuredContent).toBeUndefined();
    const text = mapped.result.content[0]?.text ?? '';
    expect(text).toMatch(/^Error: the result is too large to return \(\d+ bytes; the limit is 1000 bytes\)/);
    expect(text).toContain(NARROW_REQUEST_HINT);
    expect(text).not.toContain('"rows"');
  });

  it.each([
    ['a pretty-printed object', JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => `row ${i}`) }, null, 2)],
    ['an array', JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i })))],
  ])('never cuts an oversized JSON string (%s)', (_label, json) => {
    const mapped = mapToolOutput(json, { maxBytes: 1000 });
    expect(mapped.refused).toBe(true);
    expect(mapped.result.isError).toBe(true);
    expect(mapped.result.content[0]?.text).toMatch(/^Error: the result is too large/);
  });

  it('cuts oversized text that merely starts with a bracket', () => {
    const mapped = mapToolOutput(`[Course 1] notes\n${longText}`, { maxBytes: 1500 });
    expect(mapped.cut).toBe(true);
    expect(mapped.refused).toBe(false);
  });

  it('reports a value that cannot be serialized as an error', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const mapped = mapToolOutput(cyclic, ROOMY);
    expect(mapped.result.isError).toBe(true);
    expect(mapped.result.structuredContent).toBeUndefined();
  });

  it('reports a non-object, non-string output as an error', () => {
    expect(mapToolOutput(undefined as unknown as string, ROOMY).result.isError).toBe(true);
    expect(mapToolOutput([] as unknown as Record<string, unknown>, ROOMY).result.isError).toBe(true);
  });
});

describe('undisclosed truncation backstop', () => {
  const pages: TruncationRecord = { label: 'assignments', reason: 'max_pages', disclosed: false };
  const budget: TruncationRecord = { label: 'submissions', reason: 'budget', disclosed: false };
  const told: TruncationRecord = { label: 'modules', reason: 'deadline', disclosed: true };

  it('says nothing when every truncation was disclosed', () => {
    expect(undisclosedTruncationNotice([told])).toBe('');
    expect(withTruncationDisclosure('text', [told])).toBe('text');
    expect(withTruncationDisclosure({ a: 1 }, [])).toEqual({ a: 1 });
  });

  it('names each undisclosed list once, with the reason and the hint', () => {
    const notice = undisclosedTruncationNotice([pages, budget, told, pages]);
    expect(notice.split('\n')).toEqual([
      '⚠️ Results truncated: the list of assignments is incomplete because the page limit was reached; ' +
        `more exist in Canvas. ${NARROW_REQUEST_HINT}`,
      '⚠️ Results truncated: the list of submissions is incomplete because the request budget for this ' +
        `tool call ran out; more exist in Canvas. ${NARROW_REQUEST_HINT}`,
    ]);
  });

  it('appends the notice to text output', () => {
    const out = withTruncationDisclosure('Assignments:\n- one', [pages]);
    expect(out).toBe(`Assignments:\n- one\n\n${undisclosedTruncationNotice([pages])}`);
  });

  it('adds "truncated": true to object output without touching the original', () => {
    const original = { items: [1, 2] };
    expect(withTruncationDisclosure(original, [pages])).toEqual({ items: [1, 2], truncated: true });
    expect(original).toEqual({ items: [1, 2] });
  });

  it("keeps a tool's own truncation details and corrects a wrong false", () => {
    const detailed = { items: [], truncated: { shown: 10, total: 30 } };
    expect(withTruncationDisclosure(detailed, [pages])).toBe(detailed);
    expect(withTruncationDisclosure({ items: [], truncated: false }, [pages])).toEqual({ items: [], truncated: true });
  });

  it('adds the flag to a JSON-object string so that it stays JSON, keeping its indentation', () => {
    const pretty = JSON.stringify({ reviews: [1] }, null, 2);
    const outPretty = withTruncationDisclosure(pretty, [pages]) as string;
    expect(JSON.parse(outPretty)).toEqual({ reviews: [1], truncated: true });
    expect(outPretty).toBe(JSON.stringify({ reviews: [1], truncated: true }, null, 2));

    const compact = withTruncationDisclosure('{"reviews":[1]}', [pages]);
    expect(compact).toBe('{"reviews":[1],"truncated":true}');
  });

  it('appends the notice to a JSON-array string, which has nowhere to put a flag', () => {
    const out = withTruncationDisclosure('[1,2]', [pages]) as string;
    expect(out.startsWith('[1,2]\n\n⚠️ Results truncated')).toBe(true);
  });
});
