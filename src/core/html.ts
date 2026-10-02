// Ports strip_html_tags, extract_embedded_media and format_media_inventory from src/canvas_mcp/tools/courses.py, plus the html.unescape used there and in core/course_policy.py.
/**
 * HTML-to-text helpers for Canvas rich content.
 *
 * Upstream leans on Python's `re`, `html.unescape` and `html.parser`. This
 * port reproduces their observable output with scanners that are linear in the
 * input: page and discussion bodies are attacker-controlled, and several of
 * upstream's patterns (`<[^>]+>`, `<script ...>.*?</script>`) are quadratic in
 * a backtracking engine. No DOM and no HTMLRewriter are involved.
 */
import { decodeHTML, decodeHTMLAttribute, replaceCodePoint } from 'entities/decode';
import { PYTHON_SPACE_CLASS, isPythonWordCharAt, pythonStrip } from './python-text';

export interface EmbeddedMedia {
  tag: string;
  src: string;
  alt: string;
}

const AMP = 0x26;
const HASH = 0x23;
const SEMICOLON = 0x3b;
const LT = 0x3c;
const GT = 0x3e;
const EQUALS = 0x3d;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const DASH = 0x2d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

// Python's `\s`, not JavaScript's.
const PY_SPACE = PYTHON_SPACE_CLASS;

// Python's IGNORECASE lets U+0130 and U+0131 match "i", U+017F match "s" and
// U+212A match "k". The `iu` flags cover the last two; "i" is spelled out.
const I = '[i\\u0130\\u0131]';

// `<\s*br\s*/?\s*>`, with the optional slash regrouped so the two whitespace
// runs cannot trade characters while backtracking.
const BR_TAG = new RegExp(`<${PY_SPACE}*br${PY_SPACE}*(?:/${PY_SPACE}*)?>`, 'giu');
const BLOCK_CLOSE_TAG = new RegExp(
  `</${PY_SPACE}*(?:p|d${I}v|h[1-6]|l${I}|ul|ol|tr|table|thead|tbody|tfoot|` +
    `sect${I}on|art${I}cle|header|footer|blockquote|pre)${PY_SPACE}*>`,
  'giu',
);
const CELL_CLOSE_TAG = new RegExp(`</${PY_SPACE}*(?:td|th)${PY_SPACE}*>`, 'giu');
const INLINE_SPACE_RUN = /[ \t\xa0]+/g;
// Linear only because INLINE_SPACE_RUN has already reduced every space run to one space.
const SPACES_AROUND_NEWLINE = / *\n */g;
const BLANK_LINE_RUN = /\n{3,}/g;

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

/**
 * Python's rules for a numeric character reference, which go one step past the
 * `entities` package: control characters and noncharacters decode to nothing.
 */
function numericReferenceText(value: number): string {
  if (value === 0 || (value >= 0x80 && value <= 0x9f)) return String.fromCodePoint(replaceCodePoint(value));
  if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) return '�';
  if (
    (value >= 0x01 && value <= 0x08) ||
    value === 0x0b ||
    (value >= 0x0e && value <= 0x1f) ||
    value === 0x7f ||
    (value >= 0xfdd0 && value <= 0xfdef) ||
    (value & 0xfffe) === 0xfffe
  ) {
    return '';
  }
  return String.fromCodePoint(value);
}

/**
 * Decode character references. Numeric references are handled here (see
 * `numericReferenceText`); the text between them goes to `decodeNamed`. A named
 * reference never contains `&` or `#`, so cutting at numeric references cannot
 * split one.
 */
function decodeReferences(text: string, decodeNamed: (segment: string) => string): string {
  if (!text.includes('&')) return text;
  const n = text.length;
  const pieces: string[] = [];
  let last = 0;
  let i = text.indexOf('&#');
  while (i >= 0) {
    let j = i + 2;
    const marker = text.charCodeAt(j);
    const hex = marker === 0x78 || marker === 0x58;
    if (hex) j += 1;
    const digitsStart = j;
    let value = 0;
    for (; j < n; j += 1) {
      const code = text.charCodeAt(j);
      let digit: number;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
      else if (hex && code >= 0x61 && code <= 0x66) digit = code - 0x57;
      else if (hex && code >= 0x41 && code <= 0x46) digit = code - 0x37;
      else break;
      // Saturate: anything past U+10FFFF decodes to U+FFFD whatever its size.
      value = Math.min(value * (hex ? 16 : 10) + digit, 0x110000);
    }
    if (j === digitsStart) {
      i = text.indexOf('&#', i + 2);
      continue;
    }
    if (j < n && text.charCodeAt(j) === SEMICOLON) j += 1;
    if (i > last) pieces.push(decodeNamed(text.slice(last, i)));
    pieces.push(numericReferenceText(value));
    last = j;
    i = text.indexOf('&#', j);
  }
  if (last < n) pieces.push(decodeNamed(text.slice(last)));
  return pieces.join('');
}

/**
 * Decode HTML character references the way Python's `html.unescape` does:
 * named (with the HTML5 legacy no-semicolon forms), decimal and hex.
 */
export function decodeEntities(text: string): string {
  if (!text) return '';
  return decodeReferences(text, decodeHTML);
}

/** Attribute-value variant: a legacy named reference followed by `=` or an alphanumeric is left alone. */
function decodeAttributeValue(value: string): string {
  return decodeReferences(value, decodeHTMLAttribute);
}

// ---------------------------------------------------------------------------
// strip_html_tags
// ---------------------------------------------------------------------------

/** Fold a code unit the way Python's IGNORECASE compares it against a lower-case ASCII literal. */
function foldForLiteral(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code === 0x130 || code === 0x131) return 0x69;
  if (code === 0x17f) return 0x73;
  if (code === 0x212a) return 0x6b;
  return code;
}

/** Python's simple lower-casing of one code unit, which is what a case-insensitive backreference compares. */
function lowerForBackreference(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code === 0x130) return 0x69;
  return code;
}

function matchLiteral(text: string, pos: number, lowerWord: string): number {
  if (pos + lowerWord.length > text.length) return -1;
  for (let k = 0; k < lowerWord.length; k += 1) {
    if (foldForLiteral(text.charCodeAt(pos + k)) !== lowerWord.charCodeAt(k)) return -1;
  }
  return pos + lowerWord.length;
}

/**
 * Linear equivalent of `re.sub(r'(?is)<(script|style)\b[^>]*>.*?</\1>', '', text)`.
 *
 * The regex rescans to the end of the input from every unclosed opener. Here a
 * failed search for a closer is remembered, so each distinct closer is looked
 * for to the end of the input at most once.
 */
function dropScriptAndStyleBlocks(text: string): string {
  const n = text.length;
  const missingClosers = new Set<string>();
  let pieces: string[] | null = null;
  let last = 0;
  // Position of the next `>`, kept across openers so a pile of openers ahead
  // of one `>` does not rescan the same stretch each time.
  let openEnd = -1;
  let i = text.indexOf('<');
  while (i >= 0) {
    let nameEnd = matchLiteral(text, i + 1, 'script');
    if (nameEnd < 0) nameEnd = matchLiteral(text, i + 1, 'style');
    if (nameEnd < 0 || (nameEnd < n && isPythonWordCharAt(text, nameEnd))) {
      i = text.indexOf('<', i + 1);
      continue;
    }
    if (openEnd < nameEnd) openEnd = text.indexOf('>', nameEnd);
    // Without a `>` ahead, neither this opener nor any later one can match.
    if (openEnd < 0) break;

    let closer = '';
    for (let k = i + 1; k < nameEnd; k += 1) closer += String.fromCharCode(lowerForBackreference(text.charCodeAt(k)));
    let matchEnd = -1;
    if (!missingClosers.has(closer)) {
      let j = text.indexOf('</', openEnd + 1);
      while (j >= 0) {
        const afterName = j + 2 + closer.length;
        if (text.charCodeAt(afterName) === GT) {
          let same = true;
          for (let k = 0; k < closer.length; k += 1) {
            if (lowerForBackreference(text.charCodeAt(j + 2 + k)) !== closer.charCodeAt(k)) {
              same = false;
              break;
            }
          }
          if (same) {
            matchEnd = afterName + 1;
            break;
          }
        }
        j = text.indexOf('</', j + 2);
      }
      if (matchEnd < 0) missingClosers.add(closer);
    }
    if (matchEnd < 0) {
      i = text.indexOf('<', i + 1);
      continue;
    }
    if (pieces === null) pieces = [];
    pieces.push(text.slice(last, i));
    last = matchEnd;
    i = text.indexOf('<', matchEnd);
  }
  if (pieces === null) return text;
  pieces.push(text.slice(last));
  return pieces.join('');
}

/** Linear equivalent of `re.sub(r'<[^>]+>', ' ', text)`, which rescans from every `<` when no `>` follows. */
function replaceTagsWithSpace(text: string): string {
  let pieces: string[] | null = null;
  let last = 0;
  let i = text.indexOf('<');
  while (i >= 0) {
    const close = text.indexOf('>', i + 1);
    if (close < 0) break;
    if (close === i + 1) {
      // `<>` has nothing between the brackets; the pattern needs at least one character.
      i = text.indexOf('<', i + 1);
      continue;
    }
    if (pieces === null) pieces = [];
    pieces.push(text.slice(last, i), ' ');
    last = close + 1;
    i = text.indexOf('<', last);
  }
  if (pieces === null) return text;
  pieces.push(text.slice(last));
  return pieces.join('');
}

/**
 * Convert HTML to readable plain text.
 *
 * Block-level elements (headings, paragraphs, list items, table rows, `<br>`,
 * etc.) become line breaks so adjacent blocks don't run together: e.g.
 * `<h3>Grading</h3><p>Final exam...</p>` yields `Grading\nFinal exam...`.
 * Inline tags become a space. HTML entities are decoded and excess whitespace
 * collapsed (intra-line runs to a single space; blank-line runs to at most one).
 */
export function stripHtmlTags(html: string | null | undefined): string {
  if (!html) return '';

  // Drop <script>/<style> blocks entirely so their contents don't leak into the text.
  let text = dropScriptAndStyleBlocks(html);

  // Normalize <br> and block-level boundaries to newlines so content across
  // tag boundaries is separated instead of concatenated.
  text = text.replace(BR_TAG, '\n');
  text = text.replace(BLOCK_CLOSE_TAG, '\n');
  // Separate table cells within a row.
  text = text.replace(CELL_CLOSE_TAG, '\t');

  // Remove all remaining tags. Use a space so inline tags don't join words.
  text = replaceTagsWithSpace(text);

  text = decodeEntities(text);

  // Collapse intra-line whitespace but preserve line breaks. U+00A0 (decoded
  // from &nbsp;) is normalized to a regular space.
  text = text.replace(INLINE_SPACE_RUN, ' ');
  text = text.replace(SPACES_AROUND_NEWLINE, '\n');
  text = text.replace(BLANK_LINE_RUN, '\n\n');

  return pythonStrip(text);
}

// ---------------------------------------------------------------------------
// extract_embedded_media
// ---------------------------------------------------------------------------

const MEDIA_TAGS: ReadonlySet<string> = new Set(['img', 'iframe', 'video', 'audio', 'embed', 'object']);
// Elements whose content Python's HTMLParser treats as raw text up to the matching end tag.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'textarea',
  'title',
]);

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** The tokenizer's whitespace: tab, LF, FF, CR, space (not vertical tab). */
function isTagSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

interface MediaAttributes {
  src: string | null;
  data: string | null;
  alt: string | null;
  title: string | null;
}

interface ScannedTag {
  end: number;
  selfClosing: boolean;
}

/**
 * Scan a start or end tag whose name begins at `nameStart`, following Python
 * 3.14's `html.parser` (`locatetagend` / `attrfind_tolerant`). Returns null
 * when the tag is never closed by `>`, which makes HTMLParser discard the rest
 * of the input. When `attrs` is given, the four attributes the media list
 * needs are recorded (a repeated attribute keeps its last value, as upstream's
 * dict does).
 */
function scanTag(text: string, nameStart: number, attrs: MediaAttributes | null): ScannedTag | null {
  const n = text.length;
  let k = nameStart + 1;
  while (k < n) {
    const code = text.charCodeAt(k);
    if (isTagSpace(code) || code === SLASH || code === GT) break;
    k += 1;
  }

  let endsWithSlash = false;
  const skipSpacesAndSlashes = (): void => {
    endsWithSlash = false;
    while (k < n) {
      const code = text.charCodeAt(k);
      if (code === SLASH) endsWithSlash = true;
      else if (isTagSpace(code)) endsWithSlash = false;
      else break;
      k += 1;
    }
  };
  skipSpacesAndSlashes();

  while (k < n) {
    if (text.charCodeAt(k) === GT) break;
    // An attribute name may only start after whitespace, a slash or a quote.
    const before = text.charCodeAt(k - 1);
    if (!(isTagSpace(before) || before === SLASH || before === DOUBLE_QUOTE || before === SINGLE_QUOTE)) break;

    const attrStart = k;
    k += 1;
    while (k < n) {
      const code = text.charCodeAt(k);
      if (isTagSpace(code) || code === SLASH || code === EQUALS || code === GT) break;
      k += 1;
    }
    const attrEnd = k;

    let value: string | null = null;
    let v = k;
    while (v < n && isTagSpace(text.charCodeAt(v))) v += 1;
    if (v < n && text.charCodeAt(v) === EQUALS) {
      const afterEquals = v + 1;
      let w = afterEquals;
      while (w < n && isTagSpace(text.charCodeAt(w))) w += 1;
      const quote = w < n ? text.charCodeAt(w) : -1;
      if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
        const close = text.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", w + 1);
        if (close >= 0) {
          value = text.slice(w + 1, close);
          k = close + 1;
        } else if (w > afterEquals) {
          // Unclosed quote after `= `: Python's pattern gives back one
          // whitespace character and takes an empty unquoted value, so the
          // quote starts the next attribute name.
          value = '';
          k = w - 1;
        }
        // Unclosed quote directly after `=`: the attribute has no value and
        // the scan resumes at the end of its name.
      } else {
        let e = w;
        while (e < n) {
          const code = text.charCodeAt(e);
          if (code === GT || isTagSpace(code)) break;
          e += 1;
        }
        value = text.slice(w, e);
        k = e;
      }
    }

    if (attrs !== null) {
      const name = text.slice(attrStart, attrEnd).toLowerCase();
      if (name === 'src' || name === 'data' || name === 'alt' || name === 'title') {
        attrs[name] = value ? decodeAttributeValue(value) : '';
      }
    }
    skipSpacesAndSlashes();
  }

  if (k < n && text.charCodeAt(k) === GT) return { end: k + 1, selfClosing: endsWithSlash };
  return null;
}

/** End index of the end tag at `pos` (`</...`), or -1 when it is unterminated. */
function scanEndTag(text: string, pos: number): number {
  const firstClose = text.indexOf('>', pos + 2);
  if (firstClose < 0) return -1;
  if (!isAsciiLetter(text.charCodeAt(pos + 2))) {
    // `</>` is ignored; anything else is a bogus comment up to the next `>`.
    return firstClose + 1;
  }
  const tag = scanTag(text, pos + 2, null);
  return tag === null ? -1 : tag.end;
}

/** Index of the `</tag` that ends a raw-text element, or -1. ASCII case-insensitive, as upstream's pattern is. */
function findRawTextEnd(text: string, from: number, tag: string): number {
  const n = text.length;
  let j = text.indexOf('</', from);
  while (j >= 0) {
    const after = j + 2 + tag.length;
    if (after < n) {
      let same = true;
      for (let k = 0; k < tag.length; k += 1) {
        let code = text.charCodeAt(j + 2 + k);
        if (code >= 0x41 && code <= 0x5a) code += 0x20;
        if (code !== tag.charCodeAt(k)) {
          same = false;
          break;
        }
      }
      if (same) {
        const next = text.charCodeAt(after);
        if (isTagSpace(next) || next === SLASH || next === GT) return j;
      }
    }
    j = text.indexOf('</', j + 2);
  }
  return -1;
}

/** End index of the comment starting at `pos` (`<!--`), or -1 when it is unterminated. */
function scanComment(text: string, pos: number): number {
  const start = pos + 4;
  // An empty comment is closed abruptly by `>` or `->`.
  if (text.charCodeAt(start) === GT) return start + 1;
  if (text.charCodeAt(start) === DASH && text.charCodeAt(start + 1) === GT) return start + 2;
  let j = text.indexOf('--', start);
  while (j >= 0) {
    const next = text.charCodeAt(j + 2);
    if (next === GT) return j + 3;
    if (next === BANG && text.charCodeAt(j + 3) === GT) return j + 4;
    j = text.indexOf('--', j + 1);
  }
  return -1;
}

/**
 * List the images, videos and embeds in a page body, in document order.
 *
 * Canvas page bodies carry course media as `<img>`/`<iframe>` markup. Any
 * plain-text rendering deletes those tags, and because they are void or
 * attribute-only elements the media vanishes without leaving so much as a
 * placeholder (upstream issue 233).
 *
 * A single forward scan that tokenizes the way Python's lenient `HTMLParser`
 * does, including its handling of the unclosed and malformed markup real
 * Canvas pages contain. `<source>` is deliberately not collected: it only
 * appears inside `<video>`/`<audio>`, which are. Duplicates (same tag and same
 * src) are collapsed, since Canvas often repeats a thumbnail and its link.
 */
export function extractEmbeddedMedia(html: string | null | undefined): EmbeddedMedia[] {
  if (!html) return [];
  const text = html;
  const n = text.length;
  const items: EmbeddedMedia[] = [];
  const seen = new Set<string>();
  let rawTextTag: string | null = null;
  let i = 0;

  while (i < n) {
    if (rawTextTag !== null) {
      const endTagStart = findRawTextEnd(text, i, rawTextTag);
      if (endTagStart < 0) break;
      const end = scanEndTag(text, endTagStart);
      if (end < 0) break;
      rawTextTag = null;
      i = end;
      continue;
    }

    const open = text.indexOf('<', i);
    if (open < 0) break;
    const next = text.charCodeAt(open + 1);

    if (isAsciiLetter(next)) {
      let nameEnd = open + 2;
      while (nameEnd < n) {
        const code = text.charCodeAt(nameEnd);
        if (isTagSpace(code) || code === SLASH || code === GT) break;
        nameEnd += 1;
      }
      const tag = text.slice(open + 1, nameEnd).toLowerCase();
      const attrs: MediaAttributes | null = MEDIA_TAGS.has(tag)
        ? { src: null, data: null, alt: null, title: null }
        : null;
      const scanned = scanTag(text, open + 1, attrs);
      // An unterminated tag swallows the rest of the document.
      if (scanned === null) break;
      if (attrs !== null) {
        // <object> uses data=, everything else src=.
        const src = attrs.src || attrs.data || '';
        const key = `${tag}\u0000${src}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ tag, src, alt: attrs.alt || attrs.title || '' });
        }
      }
      if (!scanned.selfClosing) {
        if (tag === 'plaintext') break;
        if (RAW_TEXT_TAGS.has(tag)) rawTextTag = tag;
      }
      i = scanned.end;
    } else if (next === SLASH) {
      const end = scanEndTag(text, open);
      if (end < 0) break;
      i = end;
    } else if (text.startsWith('<!--', open)) {
      const end = scanComment(text, open);
      if (end < 0) break;
      i = end;
    } else if (next === BANG || next === QUESTION) {
      // CDATA sections end at `]]>`; declarations, bogus comments and
      // processing instructions end at the next `>`.
      const close = text.startsWith('<![CDATA[', open) ? text.indexOf(']]>', open + 9) : text.indexOf('>', open + 2);
      if (close < 0) break;
      i = close + (text.startsWith('<![CDATA[', open) ? 3 : 1);
    } else {
      i = open + 1;
    }
  }
  return items;
}

/** Render an embedded-media list as a labelled section, or '' if empty. */
export function formatMediaInventory(media: readonly EmbeddedMedia[]): string {
  if (media.length === 0) return '';
  const lines = [`\n\nEmbedded media (${media.length}):`];
  for (const item of media) {
    const src = item.src || '(no src attribute)';
    let line = `- ${item.tag}: ${src}`;
    if (item.alt) line += ` — ${item.alt}`;
    lines.push(line);
  }
  return lines.join('\n');
}
