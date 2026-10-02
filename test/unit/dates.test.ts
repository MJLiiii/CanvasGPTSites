// Ports tests/core/test_dates.py. The parity tables hold values produced by upstream's parse_date,
// format_date and truncate_text on CPython 3.14.
import { describe, it, expect } from 'vitest';
import {
  ParsedDate,
  createDateFormatter,
  formatDate,
  isValidTimeZone,
  parseDate,
  truncateText,
} from '../../src/core/dates';

describe('formatDate (upstream test_dates.py)', () => {
  it('returns N/A for a missing value', () => {
    expect(formatDate(null)).toBe('N/A');
    expect(formatDate(undefined)).toBe('N/A');
    expect(formatDate('')).toBe('N/A');
    expect(formatDate('', 'America/Chicago')).toBe('N/A');
  });

  it('defaults to UTC with a Z suffix', () => {
    expect(formatDate('2026-05-28T23:59:00Z')).toBe('2026-05-28T23:59:00Z');
    expect(formatDate('2026-05-28T23:59:00Z', null)).toBe('2026-05-28T23:59:00Z');
    expect(formatDate('2026-05-28T23:59:00Z', '')).toBe('2026-05-28T23:59:00Z');
  });

  it('uses Z when the timezone is explicitly UTC', () => {
    expect(formatDate('2026-05-28T23:59:00Z', 'UTC')).toBe('2026-05-28T23:59:00Z');
    expect(formatDate('2026-05-28T23:59:00Z', ' utc ')).toBe('2026-05-28T23:59:00Z');
    // A zone that merely has a zero offset at that instant is written the same way.
    expect(formatDate('2026-01-15T12:00:00Z', 'Europe/London')).toBe('2026-01-15T12:00:00Z');
  });

  it('converts to the given timezone', () => {
    // 23:59 UTC on 2026-05-28 == 18:59 CDT (UTC-5). Upstream's test expects
    // "-0500", but Python's isoformat() really prints "-05:00" (the test is
    // skipped upstream unless the tzdata package is installed).
    expect(formatDate('2026-05-28T23:59:00Z', 'America/Chicago')).toBe('2026-05-28T18:59:00-05:00');
  });

  it('honours an existing offset, then converts', () => {
    // The same instant expressed with an explicit offset.
    expect(formatDate('2026-05-29T00:59:00+0100', 'America/Chicago')).toBe('2026-05-28T18:59:00-05:00');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(formatDate('2026-05-28T23:59:00Z', 'Not/AZone')).toBe('2026-05-28T23:59:00Z');
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('returns the original value when it cannot be parsed', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
    expect(formatDate('not-a-date', 'America/Chicago')).toBe('not-a-date');
  });
});

describe('parseDate (upstream test_dates.py)', () => {
  it('assumes UTC for values without an offset', () => {
    // The "%Y-%m-%d %H:%M:%S" format carries no offset; the parser backfills UTC.
    const parsed = parseDate('2026-05-28 23:59:00');
    expect(parsed).not.toBeNull();
    expect(parsed?.utcOffsetSeconds).toBe(0);
    expect(parsed?.getTime()).toBe(Date.UTC(2026, 4, 28, 23, 59, 0));
  });

  it('preserves an explicit offset', () => {
    const parsed = parseDate('2026-05-28T18:59:00-0500');
    expect(parsed).not.toBeNull();
    expect(parsed?.utcOffsetSeconds).toBe(-5 * 3600);
    expect(parsed?.getTime()).toBe(Date.UTC(2026, 4, 28, 23, 59, 0));
  });
});

describe('parseDate', () => {
  it('returns null for missing or empty input', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
    expect(parseDate(20260528 as unknown as string)).toBeNull();
  });

  it('returns a Date that compares and sorts by instant', () => {
    const early = parseDate('2026-05-28T18:59:00-0500');
    const late = parseDate('2026-05-29T00:00:00Z');
    expect(early).toBeInstanceOf(Date);
    expect(early).toBeInstanceOf(ParsedDate);
    expect((early as ParsedDate) < (late as ParsedDate)).toBe(true);
    expect((early as ParsedDate).toISOString()).toBe('2026-05-28T23:59:00.000Z');
    expect((early as ParsedDate) < new Date(Date.UTC(2026, 4, 29))).toBe(true);
  });

  // [input, isoformat() of upstream's parse_date result, or null]
  const cases: Array<[string, string | null]> = [
    // One example per upstream format, in upstream's order.
    ['2023-01-15T14:30:00Z', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15T14:30:00.000Z', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15T14:30:00+0000', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15T14:30:00.000+0000', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15 14:30:00', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15', '2023-01-15T00:00:00+00:00'],
    ['01/15/2023 14:30:00', '2023-01-15T14:30:00+00:00'],
    ['01/15/2023', '2023-01-15T00:00:00+00:00'],
    // Offsets are kept as written.
    ['2026-05-29T00:59:00+0100', '2026-05-29T00:59:00+01:00'],
    ['2026-05-28T18:59:00-0500', '2026-05-28T18:59:00-05:00'],
    ['2023-01-15T14:30:00.5-05:00', '2023-01-15T14:30:00.500000-05:00'],
    ['2023-01-15T14:30:00+23:59', '2023-01-15T14:30:00+23:59'],
    ['2023-01-15T14:30:00+05:30:15.5', '2023-01-15T14:30:00+05:30:15.500000'],
    ['2023-01-15T14:30:00.5+05:30:15.25', '2023-01-15T14:30:00.500000+05:30:15.250000'],
    ['2023-01-15T14:30:00-00:00:00.5', '2023-01-15T14:30:00-00:00:00.500000'],
    ['2023-01-15T14:30:00-00:00', '2023-01-15T14:30:00+00:00'],
    ['2023-01-15T14:30:00.999999Z', '2023-01-15T14:30:00.999999+00:00'],
    ['1969-12-31T23:59:59.5Z', '1969-12-31T23:59:59.500000+00:00'],
    // strptime leniency: surrounding whitespace, case, short and space-padded fields, any whitespace run.
    ['  2023-01-15T14:30:00Z  ', '2023-01-15T14:30:00+00:00'],
    ['\u001c2023-01-15\u0085', '2023-01-15T00:00:00+00:00'],
    ['2023-01-15t14:30:00z', '2023-01-15T14:30:00+00:00'],
    ['2023-1-5T4:3:0Z', '2023-01-05T04:03:00+00:00'],
    ['2023-01- 5T 4:03:00Z', '2023-01-05T04:03:00+00:00'],
    ['2023-01-15   14:30:00', '2023-01-15T14:30:00+00:00'],
    ['1/5/2023', '2023-01-05T00:00:00+00:00'],
    // Range limits and calendar checks.
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00+00:00'],
    ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59+00:00'],
    ['0001-01-01T00:00:00+05:00', '0001-01-01T00:00:00+05:00'],
    ['2024-02-29', '2024-02-29T00:00:00+00:00'],
    ['2000-02-29', '2000-02-29T00:00:00+00:00'],
    ['2023-02-29', null],
    ['1900-02-29', null],
    ['2023-02-30', null],
    ['0000-02-03', null],
    ['2023-13-01', null],
    ['2023-01-15T24:30:00Z', null],
    ['2023-01-15 14:30:60', null],
    ['2023-01-15T14:30:00.1234567Z', null],
    // Offset forms strptime rejects.
    ['2023-01-15T14:30:00+24:00', null],
    ['2023-01-15T14:30:00+05:3015', null],
    ['2023-01-15T14:30:00+0530:15', null],
    // Not whitespace to Python; trailing or embedded junk.
    ['\ufeff2023-01-15', null],
    ['2023-01-15T14:30:00 Z', null],
    ['2023-01-15T14:30:00Zjunk', null],
    ['not-a-date', null],
  ];
  it.each(cases)('%j -> %j', (input, expected) => {
    const parsed = parseDate(input);
    expect(parsed === null ? null : parsed.isoformat()).toBe(expected);
  });

  it('reports the offset and the sub-second part', () => {
    const parsed = parseDate('2023-01-15T14:30:00.5+05:30');
    expect(parsed?.utcOffsetSeconds).toBe(5 * 3600 + 30 * 60);
    expect(parsed?.microsecond).toBe(500000);
    expect(parsed?.getTime()).toBe(Date.UTC(2023, 0, 15, 9, 0, 0, 500));
  });

  it('places dates before 1970 and before year 100 correctly', () => {
    expect(parseDate('1969-12-31T23:59:59.5Z')?.getTime()).toBe(-500);
    const yearOne = new Date(0);
    yearOne.setUTCFullYear(1, 0, 1);
    yearOne.setUTCHours(0, 0, 0, 0);
    expect(parseDate('0001-01-01')?.getTime()).toBe(yearOne.getTime());
    expect(parseDate('0099-03-01')?.toISOString()).toBe('0099-03-01T00:00:00.000Z');
  });

  it('handles a long hostile string quickly', () => {
    const inputs = ['2'.repeat(200_000), `2023-01-15${' '.repeat(200_000)}x`, `2023-01-15T14:30:00.${'1'.repeat(200_000)}`];
    const start = performance.now();
    for (const input of inputs) {
      expect(parseDate(input)).toBeNull();
      expect(formatDate(input, 'America/Chicago')).toBe(input);
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('formatDate', () => {
  // [input, timezone, upstream format_date output]
  const cases: Array<[string, string, string]> = [
    ['2026-05-28T23:59:00Z', 'Asia/Kolkata', '2026-05-29T05:29:00+05:30'],
    ['2026-05-28T23:59:00Z', 'Asia/Kathmandu', '2026-05-29T05:44:00+05:45'],
    ['2026-05-28T23:59:00Z', 'Australia/Lord_Howe', '2026-05-29T10:29:00+10:30'],
    ['2026-05-28T23:59:00Z', 'Europe/London', '2026-05-29T00:59:00+01:00'],
    ['2023-06-15T00:00:00Z', 'Europe/London', '2023-06-15T01:00:00+01:00'],
    ['2023-01-15', 'UTC', '2023-01-15T00:00:00Z'],
    ['2023-01-15', 'America/Chicago', '2023-01-14T18:00:00-06:00'],
    ['2023-01-15', 'Europe/London', '2023-01-15T00:00:00Z'],
    ['01/15/2023 14:30:00', 'Asia/Kolkata', '2023-01-15T20:00:00+05:30'],
    ['2024-02-29', 'America/Chicago', '2024-02-28T18:00:00-06:00'],
    // Either side of both 2026 US daylight-saving changes.
    ['2026-03-08T07:59:59Z', 'America/Chicago', '2026-03-08T01:59:59-06:00'],
    ['2026-03-08T08:00:00Z', 'America/Chicago', '2026-03-08T03:00:00-05:00'],
    ['2026-11-01T06:59:59Z', 'America/Chicago', '2026-11-01T01:59:59-05:00'],
    ['2026-11-01T07:00:00Z', 'America/Chicago', '2026-11-01T01:00:00-06:00'],
    // Output is truncated, not rounded, to the second; a fractional input offset still lands on the right second.
    ['2023-01-15T14:30:00.999999Z', 'UTC', '2023-01-15T14:30:00Z'],
    ['2023-01-15T14:30:00.5+05:30:15.25', 'UTC', '2023-01-15T08:59:45Z'],
    ['2023-01-15T14:30:00.5+05:30:15.25', 'Asia/Kathmandu', '2023-01-15T14:44:45+05:45'],
    ['1969-12-31T23:59:59.5Z', 'UTC', '1969-12-31T23:59:59Z'],
    ['1969-12-31T23:59:59.5Z', 'Europe/London', '1970-01-01T00:59:59+01:00'],
    ['2023-01-15T14:30:00+23:59', 'UTC', '2023-01-14T14:31:00Z'],
    // Local mean time before standard zones: the offset carries seconds.
    ['1850-06-01T12:00:00Z', 'America/Chicago', '1850-06-01T06:09:24-05:50:36'],
    ['1850-06-01T12:00:00Z', 'Asia/Kolkata', '1850-06-01T17:53:28+05:53:28'],
    // The edges of the supported range.
    ['0001-01-01T00:00:00Z', 'UTC', '0001-01-01T00:00:00Z'],
    ['0001-01-01T00:00:00Z', 'Asia/Kolkata', '0001-01-01T05:53:28+05:53:28'],
    ['9999-12-31T23:59:59Z', 'UTC', '9999-12-31T23:59:59Z'],
    ['9999-12-31T23:59:59Z', 'America/Chicago', '9999-12-31T17:59:59-06:00'],
  ];
  it.each(cases)('%j in %s', (input, timezone, expected) => {
    expect(formatDate(input, timezone)).toBe(expected);
  });

  it('returns the input when the converted time leaves years 1 to 9999', () => {
    // Upstream raises OverflowError for these; the port hands the text back instead.
    expect(formatDate('0001-01-01T00:00:00Z', 'America/Chicago')).toBe('0001-01-01T00:00:00Z');
    expect(formatDate('9999-12-31T23:59:59Z', 'Asia/Kolkata')).toBe('9999-12-31T23:59:59Z');
    expect(formatDate('0001-01-01T00:00:00+05:00', 'UTC')).toBe('0001-01-01T00:00:00+05:00');
    expect(formatDate('0001-01-01T00:00:00+05:00', 'Asia/Kolkata')).toBe('0001-01-01T00:00:00+05:00');
    expect(formatDate('9999-12-31T23:59:59-05:00', 'America/Chicago')).toBe('9999-12-31T23:59:59-05:00');
  });

  it('passes a non-string value through as text', () => {
    expect(formatDate(0 as unknown as string)).toBe('N/A');
    expect(formatDate(20260528 as unknown as string)).toBe('20260528');
  });
});

describe('createDateFormatter', () => {
  it('formats many values with one resolved zone', () => {
    const format = createDateFormatter('America/Chicago');
    expect(format('2026-05-28T23:59:00Z')).toBe('2026-05-28T18:59:00-05:00');
    expect(format('2026-01-28T23:59:00Z')).toBe('2026-01-28T17:59:00-06:00');
    expect(format(null)).toBe('N/A');
    expect(format('not-a-date')).toBe('not-a-date');
  });

  it('treats a missing, empty or unknown zone as UTC', () => {
    for (const zone of [undefined, null, '', '   ', 'UTC', 'utc', 'Not/AZone']) {
      expect(createDateFormatter(zone)('2026-05-28T18:59:00-0500')).toBe('2026-05-28T23:59:00Z');
    }
  });
});

describe('isValidTimeZone', () => {
  it('accepts UTC, the empty default and known zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('utc')).toBe(true);
    expect(isValidTimeZone('')).toBe(true);
    expect(isValidTimeZone(null)).toBe(true);
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone(' Asia/Kolkata ')).toBe(true);
  });

  it('rejects unknown zones', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('')).toBe('');
    expect(truncateText('abc')).toBe('abc');
    expect(truncateText('x'.repeat(100))).toBe('x'.repeat(100));
    expect(truncateText('abcdef', 6)).toBe('abcdef');
  });

  it('cuts to the limit including the ellipsis', () => {
    expect(truncateText('x'.repeat(101))).toBe(`${'x'.repeat(97)}...`);
    expect(truncateText('y'.repeat(150))).toHaveLength(100);
    expect(truncateText('héllo wörld', 8)).toBe('héllo...');
    expect(truncateText('abcdef', 5)).toBe('ab...');
  });

  it('counts code points, as Python does', () => {
    const face = '😀';
    expect(truncateText(face.repeat(10), 10)).toBe(face.repeat(10));
    expect(truncateText(face.repeat(11), 10)).toBe(`${face.repeat(7)}...`);
  });

  it("follows Python's slice arithmetic for tiny limits", () => {
    expect(truncateText('abcdef', 3)).toBe('...');
    expect(truncateText('abcdef', 2)).toBe('abcde...');
    expect(truncateText('abcdef', 0)).toBe('abc...');
    expect(truncateText('abcdef', -5)).toBe('...');
  });

  it('passes a missing value through', () => {
    expect(truncateText(null as unknown as string)).toBeNull();
    expect(truncateText(undefined as unknown as string)).toBeUndefined();
  });
});
