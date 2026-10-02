// Lifted from canvas_mcp/code_api/client.ts (splitLink, nextPageUrl). Its validatePageUrl is not lifted:
// the one check a next link must pass before it is followed is isPinnedPageUrl in ./path.

/** A `Link` header or next-page URL that must not be followed. */
export class PaginationLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaginationLinkError';
  }
}

/** Split Link syntax without treating commas/semicolons inside URLs or quotes as separators. */
export function splitLink(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (!angled && char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '<') {
      if (angled) throw new PaginationLinkError('Invalid pagination link syntax');
      angled = true;
    } else if (char === '>') {
      if (!angled) throw new PaginationLinkError('Invalid pagination link syntax');
      angled = false;
    } else if (!angled && char === separator) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted || angled || escaped) throw new PaginationLinkError('Invalid pagination link syntax');
  parts.push(value.slice(start));
  return parts;
}

/**
 * The `rel="next"` target of a `Link` header, resolved against the page just
 * fetched, or null when the header names no next page. A malformed, ambiguous
 * or anchored header throws: it must not be mistaken for the last page.
 */
export function nextPageUrl(header: string | null, current: URL): URL | null {
  if (!header?.trim()) return null;
  let next: URL | null = null;
  for (const entry of splitLink(header, ',')) {
    const match = /^\s*<([^<>]*)>(.*)$/.exec(entry);
    if (!match) throw new PaginationLinkError('Invalid pagination link syntax');
    const target = match[1] ?? '';
    const fields = splitLink(match[2] ?? '', ';');
    if ((fields.shift() ?? '').trim()) throw new PaginationLinkError('Invalid pagination link parameters');
    let relation: string | undefined;
    let anchored = false;
    for (const field of fields) {
      const parameter = /^\s*([!#$%&'*+.^_`|~\w-]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^\s";,]+))?\s*$/.exec(field);
      if (!parameter) throw new PaginationLinkError('Invalid pagination link parameters');
      const name = (parameter[1] ?? '').toLowerCase();
      let value = parameter[2] ?? '';
      if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      if (name === 'anchor') anchored = true;
      if (name === 'rel') {
        if (relation !== undefined) throw new PaginationLinkError('Ambiguous pagination link relation');
        relation = value;
      }
    }
    // RFC 8288 requires a nonempty relation list; malformed metadata must
    // not masquerade as a terminal page. Extension relations are absolute URIs.
    const relations = relation?.split(/ +/);
    if (
      !relations?.length ||
      relations.some((value) => {
        if (/^[a-z][a-z0-9.-]*$/i.test(value)) return false;
        if (!/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(value)) return true;
        try {
          new URL(value);
          return false;
        } catch {
          return true;
        }
      })
    ) {
      throw new PaginationLinkError('Invalid pagination link relation');
    }
    if (!relations.some((value) => value.toLowerCase() === 'next')) continue;
    if (next || anchored) throw new PaginationLinkError('Ambiguous or anchored pagination link');
    try {
      next = new URL(target, current);
    } catch {
      throw new PaginationLinkError('Invalid pagination link URL');
    }
  }
  return next;
}
