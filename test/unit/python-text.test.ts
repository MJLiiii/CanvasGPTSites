// No upstream test file: the expected values were produced with CPython 3 (str.isspace, str.strip, json.dumps).
import { describe, expect, it } from 'vitest';
import {
  PYTHON_SPACE_CLASS,
  escapeNonAsciiJson,
  isPythonSpace,
  pythonLstrip,
  pythonStrip,
} from '../../src/core/python-text';

// [hex(c) for c in range(0x110000) if chr(c).isspace()]
const PYTHON_SPACES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

describe('isPythonSpace', () => {
  it('is true for exactly the code units Python calls whitespace', () => {
    const found: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      if (isPythonSpace(code)) found.push(code);
    }
    expect(found).toEqual(PYTHON_SPACES);
  });

  it('differs from JavaScript whitespace where Python does', () => {
    // JS treats U+FEFF as whitespace and U+001C..U+001F and U+0085 as not.
    expect(isPythonSpace(0xfeff)).toBe(false);
    expect(/\s/.test('\ufeff')).toBe(true);
    for (const code of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) {
      expect(isPythonSpace(code)).toBe(true);
      expect(/\s/.test(String.fromCharCode(code))).toBe(false);
    }
  });
});

describe('PYTHON_SPACE_CLASS', () => {
  it('matches the same characters as isPythonSpace', () => {
    const pattern = new RegExp(`^${PYTHON_SPACE_CLASS}$`, 'u');
    for (let code = 0; code <= 0xffff; code += 1) {
      // A lone surrogate is not a character the `u` flag can match against a class of BMP scalars.
      if (code >= 0xd800 && code <= 0xdfff) continue;
      expect(pattern.test(String.fromCharCode(code)), code.toString(16)).toBe(isPythonSpace(code));
    }
  });
});

describe('pythonStrip and pythonLstrip', () => {
  it('strip what Python strips', () => {
    expect(pythonStrip('\x1c\x85 \u3000text \u2028\t')).toBe('text');
    expect(pythonLstrip('\x1c\x85 \u3000text \u2028\t')).toBe('text \u2028\t');
    expect(pythonStrip(' \n ')).toBe('');
    expect(pythonLstrip(' \n ')).toBe('');
    expect(pythonStrip('')).toBe('');
    expect(pythonStrip('a b')).toBe('a b');
  });

  it('keep what only JavaScript strips', () => {
    expect(pythonStrip('\ufeffx\ufeff')).toBe('\ufeffx\ufeff');
    expect(pythonLstrip('\ufeffx')).toBe('\ufeffx');
  });
});

describe('escapeNonAsciiJson', () => {
  it('writes JSON as json.dumps does', () => {
    // json.dumps('a\x7fb\u00e9\U0001f600')
    expect(escapeNonAsciiJson(JSON.stringify('a\u007fb\u00e9\u{1F600}'))).toBe('"a\\u007fb\\u00e9\\ud83d\\ude00"');
    expect(escapeNonAsciiJson(JSON.stringify({ k: 'plain ~ text' }))).toBe('{"k":"plain ~ text"}');
    expect(escapeNonAsciiJson(JSON.stringify('tab\tquote"'))).toBe('"tab\\tquote\\""');
  });

  it('leaves the value unchanged for a JSON parser', () => {
    const value = { '\u043a\u043b\u044e\u0447': ['\u503c', '\u007f', '\u{1F600}'] };
    expect(JSON.parse(escapeNonAsciiJson(JSON.stringify(value)))).toEqual(value);
    expect(escapeNonAsciiJson(JSON.stringify(value))).toMatch(/^[\x20-\x7e]*$/);
  });
});
