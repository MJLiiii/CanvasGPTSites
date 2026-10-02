// Ports TestStripHtmlTags and TestExtractEmbeddedMedia from tests/tools/test_courses.py. The parity tables
// hold values produced by upstream's Python functions (strip_html_tags, extract_embedded_media,
// format_media_inventory, html.unescape) on CPython 3.14.
import { describe, it, expect } from 'vitest';
import {
  decodeEntities,
  extractEmbeddedMedia,
  formatMediaInventory,
  stripHtmlTags,
  type EmbeddedMedia,
} from '../../src/core/html';

function elapsedMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const media = (tag: string, src: string, alt = ''): EmbeddedMedia => ({ tag, src, alt });

describe('stripHtmlTags', () => {
  it('strips simple tags', () => {
    expect(stripHtmlTags('<p>Hello World</p>')).toBe('Hello World');
  });

  it('strips nested tags', () => {
    expect(stripHtmlTags('<div><p>Nested <strong>content</strong></p></div>')).toBe('Nested content');
  });

  it('decodes entities', () => {
    expect(stripHtmlTags('<p>Hello&nbsp;World&amp;More</p>')).toBe('Hello World&More');
  });

  it('drops script and style blocks', () => {
    // <script>/<style> block contents must not leak into plain text.
    const result = stripHtmlTags("<style>.a{color:red}</style><p>Real content</p><script>alert('x')</script>");
    expect(result).toContain('Real content');
    expect(result).not.toContain('color:red');
    expect(result).not.toContain('alert');
  });

  it('decodes extended entities', () => {
    // Entities beyond a small hand-written table (smart quotes, dashes, hex) decode.
    expect(stripHtmlTags('<p>Weeks 1&ndash;3 use the instructor&rsquo;s &#x201C;rubric&#x201D;</p>')).toBe(
      'Weeks 1–3 use the instructor’s “rubric”',
    );
  });

  it('returns an empty string for an empty string', () => {
    expect(stripHtmlTags('')).toBe('');
  });

  it('returns an empty string for a missing value', () => {
    expect(stripHtmlTags(null)).toBe('');
    expect(stripHtmlTags(undefined)).toBe('');
  });

  it('does not concatenate block elements', () => {
    // Adjacent block elements must be separated, not run together.
    const result = stripHtmlTags('<h3>Grading</h3><p>Final exam is 40%.</p>');
    expect(result).not.toContain('GradingFinal');
    expect(result).toContain('Grading');
    expect(result).toContain('Final exam is 40%.');
    // Blocks land on separate lines.
    expect(result).toBe('Grading\nFinal exam is 40%.');
  });

  it('separates list items', () => {
    const result = stripHtmlTags('<ul><li>Homework 30%</li><li>Final 70%</li></ul>');
    expect(result).toContain('Homework 30%');
    expect(result).toContain('Final 70%');
    expect(result).not.toContain('30%Final');
  });

  describe('parity with upstream', () => {
    const cases: Array<[string, string]> = [
      ['<ul><li>Homework 30%</li><li>Final 70%</li></ul>', 'Homework 30%\nFinal 70%'],
      ['<table><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></table>', 'a b\nc'],
      ['<td>1</td><td>2</td>', '1 2'],
      ['a<br>b<br/>c<BR />d', 'a\nb\nc\nd'],
      ['a<br >b<  br/  >c<b r>d', 'a\nb\nc d'],
      ['<p>a</p >b</ p>c</p x>d', 'a\nb\nc d'],
      ['<p>one</p>\n\n\n\n<p>two</p>', 'one\n\ntwo'],
      ['x <b>bold</b>text', 'x bold text'],
      ['tab\there\u00a0and\u00a0\u00a0there', 'tab here and there'],
      [' a \n b \n\n\n c ', 'a\nb\n\nc'],
      ['<p>a&nbsp;&nbsp; b</p>', 'a b'],
      // Entities are decoded after tags are removed, so escaped markup survives as text.
      ['&lt;p&gt;not a tag&lt;/p&gt;', '<p>not a tag</p>'],
      ['&amp;lt;', '&lt;'],
      // The tag pattern is purely textual.
      ['1 < 2 and 3 > 2', '1 2'],
      ['a <> b', 'a <> b'],
      ['<>a< >b', '<>a b'],
      ['<<p>>', '>'],
      ['<img src="unterminated', '<img src="unterminated'],
      ['<!-- <img src="c.png"> --><img src="d.png">', '-->'],
      // Each pass runs on the previous pass's output.
      ['<scr<script></script>ipt>x</script>', 'x'],
      ['<p<br>>z', 'z'],
      // script/style removal: closer must repeat the opener's name, no space before `>`.
      ['<SCRIPT>x</script >y', 'x y'],
      ['<script>a</script><script>b', 'b'],
      ['<style>a<script>b</style>c</script>d', 'c d'],
      ['<scripts>a</scripts>b', 'a b'],
      ['<script-x>a</script>b', 'b'],
      // Python's IGNORECASE: U+0130/U+0131 match "i", U+017F matches "s", U+212A matches "k"...
      ['a</dıv>b', 'a\nb'],
      ['a</blocKquote>b', 'a\nb'],
      ['<scrİpt>x</script>y', 'y'],
      // ...but a backreference compares lower-cased text, and U+017F does not lower-case to "s".
      ['<ſcript>x</script>y', 'x y'],
      ['<ſcript>x</ſcript>y', 'y'],
      // Python's \s has U+0085 and not U+FEFF; str.strip() follows the same set.
      ['a</p\u0085>b', 'a\nb'],
      ['a</p\ufeff>b', 'a b'],
      ['a<br\u2003/\u00a0>b', 'a\nb'],
      [' \u0085\u001c<p>x</p>\ufeff ', 'x\n\ufeff'],
      ['\ufeff<p>x</p>\ufeff', '\ufeff x\n\ufeff'],
      // Numeric references: astral, dropped controls, CR, Windows-1252 remap.
      [
        '&#x1F600; &#128512; &#xFDD0; &#11; &#13; &#x9F; &#x81; &#127;',
        '😀 😀 \r Ÿ \u0081',
      ],
      [
        '<br<img src=b.png alt=x></scrıpt>&#0;></textarea></dİv><!x</P >&amp&nGt;&#',
        '�>\n<!x\n&≫⃒&#',
      ],
      [
        '<SCRIPT src="a>b"></style></p><img src="a.png"><img alt="t" title=u><span class=x><script x</dİv>&',
        'b">\n<script x\n&',
      ],
      ['<xmp><br>&#<SCRIPT src="a>b">\u00a0&copy', '&# b"> ©'],
      [
        '&#65\u000b\r</ſcript><div><?php</ſection>&not&nbsp;src&\u001f<plaintext>&nbsp;\f</',
        'A\u000b\r \f</',
      ],
    ];
    it.each(cases)('%j', (input, expected) => {
      expect(stripHtmlTags(input)).toBe(expected);
    });
  });
});

describe('decodeEntities', () => {
  // Expected values produced by Python's html.unescape.
  const cases: Array<[string, string]> = [
    ['no refs', 'no refs'],
    ['&amp', '&'],
    ['&ampx', '&x'],
    ['&amp;amp;', '&amp;'],
    ['&#38;amp;', '&amp;'],
    ['&LT', '<'],
    ['&quot;&apos;', '"\''],
    ['&nbsp;', '\u00a0'],
    ['&notit;', '¬it;'],
    ['&notin;', '∉'],
    ['&NotEqualTilde;', '≂̸'],
    ['&unknown;', '&unknown;'],
    ['& amp;', '& amp;'],
    ['&#x41', 'A'],
    ['&#X41;', 'A'],
    ['&#65', 'A'],
    ['&#;', '&#;'],
    ['&#x;', '&#x;'],
    ['&#xg;', '&#xg;'],
    ['&#0;', '�'],
    ['&#1;', ''],
    ['&#128;', '€'],
    ['&#x9F;', 'Ÿ'],
    ['&#xD800;', '�'],
    ['&#1114112;', '�'],
    ['&#99999999999999999999;', '�'],
    ['&#xFDD0;', ''],
    ['&#x1FFFE;', ''],
    ['<p>Hello&nbsp;World&amp;More</p>', '<p>Hello\u00a0World&More</p>'],
    [
      '<img src="x&amp;y=1&#38;z" alt="&lt;b&gt; &copy 2020 &notit; &amp=x">',
      '<img src="x&y=1&z" alt="<b> © 2020 ¬it; &=x">',
    ],
    ['&amp;&NotEqualTilde;</li><scrİpt>&nGt;&#xfffe;', '&≂̸</li><scrİpt>≫⃒'],
  ];
  it.each(cases)('%j', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it('returns an empty string for an empty value', () => {
    expect(decodeEntities('')).toBe('');
  });

  it('never yields a lone surrogate or out-of-range character', () => {
    // Python raises on a decimal reference past 4300 digits; the port saturates instead.
    expect(decodeEntities(`&#${'9'.repeat(5000)};`)).toBe('�');
    expect(decodeEntities(`&#x${'F'.repeat(5000)};`)).toBe('�');
    expect(decodeEntities('&#xDFFF;&#xD83D;&#xDE00;')).toBe('���');
  });
});

describe('extractEmbeddedMedia', () => {
  const MEDIA_BODY =
    '<p>Watch the intro.</p>' +
    '<iframe src="https://videos.example.edu/intro" title="Intro video"></iframe>' +
    '<p>And the diagram:</p><img src="https://files.example.edu/d.png" alt="Architecture diagram">';

  it('finds iframe and img', () => {
    const found = extractEmbeddedMedia(MEDIA_BODY);
    expect(found.map((m) => m.tag)).toEqual(['iframe', 'img']);
    expect(found[0]?.src).toBe('https://videos.example.edu/intro');
    expect(found[1]?.alt).toBe('Architecture diagram');
    expect(found).toEqual([
      media('iframe', 'https://videos.example.edu/intro', 'Intro video'),
      media('img', 'https://files.example.edu/d.png', 'Architecture diagram'),
    ]);
  });

  it('returns an empty list for an empty body', () => {
    expect(extractEmbeddedMedia('')).toEqual([]);
    expect(extractEmbeddedMedia(null)).toEqual([]);
    expect(extractEmbeddedMedia(undefined)).toEqual([]);
    expect(extractEmbeddedMedia('<p>text only</p>')).toEqual([]);
  });

  it('deduplicates the same tag and src', () => {
    expect(extractEmbeddedMedia('<img src="a.png"><img src="a.png"><img src="b.png">')).toHaveLength(2);
  });

  it('does not double count a video source', () => {
    const found = extractEmbeddedMedia('<video src="v.mp4"><source src="v.webm"></video>');
    expect(found.map((m) => m.tag)).toEqual(['video']);
  });

  it('uses the data attribute of an object', () => {
    expect(extractEmbeddedMedia('<object data="x.pdf"></object>')[0]?.src).toBe('x.pdf');
  });

  it('does not throw on malformed HTML', () => {
    const found = extractEmbeddedMedia('<img src="a.png" <p>unclosed <iframe src="b">');
    expect(Array.isArray(found)).toBe(true);
    expect(found).toEqual([media('img', 'a.png'), media('iframe', 'b')]);
  });

  it('still reports media with no src', () => {
    const found = extractEmbeddedMedia("<img alt='broken'>");
    expect(found).toHaveLength(1);
    expect(found[0]?.src).toBe('');
  });

  describe('parity with upstream', () => {
    const cases: Array<[string, EmbeddedMedia[]]> = [
      // Names are case-insensitive; values keep their case.
      ['<IMG SRC="A.PNG" ALT="Up">', [media('img', 'A.PNG', 'Up')]],
      ['<ImG sRc=x>', [media('img', 'x')]],
      // Quoting styles and whitespace around `=`.
      ["<img src='a\"b' alt=\"c'd\">", [media('img', 'a"b', "c'd")]],
      ['<img src=\n"multi\nline">', [media('img', 'multi\nline')]],
      ['<img\tsrc\t=\t"tab">', [media('img', 'tab')]],
      ['<img\fsrc=ff>', [media('img', 'ff')]],
      // A vertical tab is not tag whitespace, so the tag name is "img\vsrc=vt".
      ['<img\u000bsrc=vt>', []],
      ['<img src="8"alt="9">', [media('img', '8', '9')]],
      ['<img/src="s"/alt="t"/>', [media('img', 's', 't')]],
      ['<img src=a.png / >', [media('img', 'a.png')]],
      // An unquoted value runs to whitespace or `>`, so it keeps a trailing slash.
      ['<IMG SRC=a.png/>', [media('img', 'a.png/')]],
      ['<img src>', [media('img', '')]],
      ['<img src=>', [media('img', '')]],
      ['<img src= >', [media('img', '')]],
      ['<img src=10 =x>', [media('img', '10')]],
      ['<img =src=11>', [media('img', '')]],
      ['<img src=6 <img src=7>', [media('img', '7')]],
      // A repeated attribute keeps its last value; src wins over data, alt over title.
      ['<img src="1" src="2">', [media('img', '2')]],
      ['<img src="" data="d">', [media('img', 'd')]],
      ['<object src="s" data="d">', [media('object', 's')]],
      ['<img title="t">', [media('img', '', 't')]],
      ['<img alt="" title="t">', [media('img', '', 't')]],
      ['<embed src="e" title="T">', [media('embed', 'e', 'T')]],
      ['<audio src=a.mp3><</blockquote>', [media('audio', 'a.mp3')]],
      // The first of two duplicates is the one kept.
      ['<img src="a" alt="1"><img src="a" alt="2">', [media('img', 'a', '1')]],
      ['<video src=v></video><video src=v></video>', [media('video', 'v')]],
      // Attribute values: numeric references always decode, named ones only when exact and not followed by `=`.
      [
        '<img src="x&amp;y=1&#38;z" alt="&lt;b&gt; &copy 2020 &notit; &amp=x">',
        [media('img', 'x&y=1&z', '<b> © 2020 &notit; &amp=x')],
      ],
      ['<img src="&ampfoo">', [media('img', '&ampfoo')]],
      ['<img src="a&amp=b">', [media('img', 'a&amp=b')]],
      ['<img src="a&amp;=b">', [media('img', 'a&=b')]],
      ['<img src="&copy 1 &copy; 2 &copyx">', [media('img', '© 1 © 2 &copyx')]],
      ['<img src="&#65;&#x42&#67=">', [media('img', 'ABC=')]],
      // Raw-text elements hide their content up to the matching end tag.
      [
        '<iframe src="i"><img src="inside.png"></iframe><img src="after.png">',
        [media('iframe', 'i'), media('img', 'after.png')],
      ],
      ['<script><img src="in-script.png"></script><img src="ok.png">', [media('img', 'ok.png')]],
      ['<style><img src="s.png"></STYLE ><img src="after.png">', [media('img', 'after.png')]],
      [
        '<script><img src="s.png"></scriptx><img src="still.png"></script><img src="out.png">',
        [media('img', 'out.png')],
      ],
      ['<textarea><img src="in-ta.png"></textarea><img src="ok2.png">', [media('img', 'ok2.png')]],
      ['<title>T<img src="t.png"></title><img src="u.png">', [media('img', 'u.png')]],
      ['<plaintext><img src="p.png">', []],
      ['<noscript><img src="ns.png"></noscript>', [media('img', 'ns.png')]],
      ['<a href="x"><img src="in-a.png"></a>', [media('img', 'in-a.png')]],
      // A self-closing raw-text element does not start raw text.
      ['<iframe src="x"/><img src="y">', [media('iframe', 'x'), media('img', 'y')]],
      ['<video src="v.mp4"/><source src="s">', [media('video', 'v.mp4')]],
      // Comments, declarations, processing instructions, CDATA.
      ['<!-- <img src="c.png"> --><img src="d.png">', [media('img', 'd.png')]],
      ['<!--><img src="a1">', [media('img', 'a1')]],
      ['<!---><img src="a2">', [media('img', 'a2')]],
      ['<!-- x --!><img src="a3">', [media('img', 'a3')]],
      ['<!-- never closed <img src="a5">', []],
      ['<![CDATA[ <img src="cd.png"> ]]><img src="e.png">', [media('img', 'e.png')]],
      ['<? x ?><img src=3>', [media('img', '3')]],
      ['<!x><img src=4>', [media('img', '4')]],
      ['<!doctype html><img src=5>', [media('img', '5')]],
      // End tags are scanned like start tags, quoted attributes included.
      ['</><img src=1>', [media('img', '1')]],
      ['</ x><img src=2>', [media('img', '2')]],
      ['</iframe x="><img src=z>">', []],
      // Unterminated constructs swallow the rest of the document.
      ['<img src="unterminated', []],
      ["<img src='u", []],
      ['<img src="a6"><!', [media('img', 'a6')]],
      ['<img src="a7"></', [media('img', 'a7')]],
      ['<img src="a8"><', [media('img', 'a8')]],
      ['<img src="a9"><x', [media('img', 'a9')]],
      // Unclosed quotes: after `= ` the quote starts a new attribute name; right after `=` the tag is unterminated.
      ["<img src= 'u>", [media('img', '')]],
      ['<a b= \'c><img src="x">', [media('img', 'x')]],
      ['<a b=\'c><img src="x">', []],
      ['<a b=\'c\'><img src="x">', [media('img', 'x')]],
      [
        '<img src="a.png" <a b"=\'c></tr></pre><iframe src="https://v.example/i" title="Intro"><a"b><a b= \'c>',
        [media('img', 'a.png')],
      ],
      [
        '<scripté>"\r&#65&#65;/<object data="d" src="s"><td></title>&#128;&gt<xmp></div></ul></style>',
        [media('object', 's')],
      ],
    ];
    it.each(cases)('%j', (input, expected) => {
      expect(extractEmbeddedMedia(input)).toEqual(expected);
    });
  });
});

describe('formatMediaInventory', () => {
  it('renders nothing for an empty list', () => {
    expect(formatMediaInventory([])).toBe('');
  });

  it('renders a labelled section', () => {
    expect(
      formatMediaInventory([
        media('iframe', 'https://videos.example.edu/intro', 'Intro video'),
        media('img', 'https://files.example.edu/d.png', 'Architecture diagram'),
      ]),
    ).toBe(
      '\n\nEmbedded media (2):\n- iframe: https://videos.example.edu/intro — Intro video\n' +
        '- img: https://files.example.edu/d.png — Architecture diagram',
    );
  });

  it('labels a missing src and omits an empty alt', () => {
    expect(formatMediaInventory([media('img', '')])).toBe('\n\nEmbedded media (1):\n- img: (no src attribute)');
  });
});

describe('linear-time behaviour on adversarial input', () => {
  const size = 200_000;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(size / unit.length));
  const inputs: Record<string, string> = {
    'one run of <': '<'.repeat(size),
    'unclosed script openers': repeat('<script>'),
    'script openers without >': repeat('<script '),
    'script openers before a single >': `${repeat('<script')}>`,
    'interleaved unclosed script and style': repeat('<style><script>'),
    'script openers with the wrong closer': repeat('<script></style>'),
    '<br before a long whitespace run': `<br${' '.repeat(size)}x`,
    'unterminated <br': repeat('<br '),
    '< followed by a space': repeat('< '),
    '</p before a long whitespace run': `</p${' '.repeat(size)}x`,
    'unterminated </p': repeat('</p '),
    'bare </': repeat('</'),
    'spaces only': ' '.repeat(size),
    'spaces around newlines': repeat(' \n '),
    'mixed inline whitespace': repeat('\t\u00a0 '),
    'newlines only': '\n'.repeat(size),
    'unterminated img tags': repeat('<img src="a" '),
    'unclosed single-quoted values': repeat("<img src='"),
    'unclosed quotes after "= "': repeat('<a b= "'),
    'unclosed quotes after "="': repeat("<a b='c> "),
    'one tag with many attributes': `<img ${repeat('a=b ')}`,
    'one tag with many half-quoted attributes': `<img ${repeat("a= 'b ")}`,
    'one tag with many slashes': `<a ${'/'.repeat(size)}`,
    'comment openers': repeat('<!--'),
    'a comment full of dashes': `<!--${'-'.repeat(size)}`,
    'unclosed iframes': repeat('<iframe>'),
    'iframes with a near-miss closer': repeat('<iframe></ifram'),
    'unterminated end tags': repeat('</a '),
    'processing instructions': repeat('<?'),
    'CDATA openers': repeat('<![CDATA['),
    'ampersands only': '&'.repeat(size),
    'empty numeric references': repeat('&#x'),
    'unknown named references': repeat('&notanentity'),
    'one huge numeric reference': `&#${'9'.repeat(size)}`,
  };

  it.each(Object.keys(inputs))('%s', (name) => {
    const input = inputs[name] as string;
    expect(input.length).toBeGreaterThanOrEqual(size);
    const ms = elapsedMs(() => {
      stripHtmlTags(input);
      extractEmbeddedMedia(input);
      decodeEntities(input);
    });
    // Linear passes over 200k characters take a few milliseconds; upstream's
    // `<[^>]+>` alone needs about 2 * 10^10 steps on the first input.
    expect(ms).toBeLessThan(1000);
  });

  it('still produces upstream results at that size', () => {
    const brackets = '<'.repeat(size);
    expect(stripHtmlTags(brackets)).toBe(brackets);
    expect(stripHtmlTags(`${brackets}p>text`)).toBe('text');
    expect(stripHtmlTags(`${repeat('<script>')}x</script>tail`)).toBe('tail');
    expect(extractEmbeddedMedia(repeat('<img src="a"><img src="b">'))).toEqual([media('img', 'a'), media('img', 'b')]);
    expect(stripHtmlTags(`a${' '.repeat(size)}\n${' '.repeat(size)}b`)).toBe('a\nb');
  });
});
