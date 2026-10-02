// Replaces the header-based caller identification in canvas-mcp src/canvas_mcp/server.py (CanvasCredentialMiddleware):
// the caller is whoever the Sites gateway says it is, read from the gateway's headers and from nowhere else.
import type { Identity } from '../types';

export const USER_ID_HEADER = 'oai-authenticated-user-id';
export const USER_EMAIL_HEADER = 'oai-authenticated-user-email';
export const USER_FULL_NAME_HEADER = 'oai-authenticated-user-full-name';
export const USER_FULL_NAME_ENCODING_HEADER = 'oai-authenticated-user-full-name-encoding';
/** The Sign in with ChatGPT bypass token. A request that carries it has no gateway identity. */
export const BYPASS_TOKEN_HEADER = 'oai-sites-authorization';

const PERCENT_ENCODED_UTF8 = 'percent-encoded-utf-8';
const MAX_IDENTIFIER_LENGTH = 320;
const MAX_FULL_NAME_LENGTH = 200;

/**
 * Visible ASCII without a comma. `Headers.get` joins repeated headers with
 * ", ", so a gateway that appended its value to a forged one instead of
 * replacing it produces a value with a comma and a space; neither can be part
 * of an identifier accepted here.
 */
const IDENTIFIER = /^[\x21-\x2b\x2d-\x7e]+$/;

export type IdentityRejection = 'bypass_token_present' | 'user_id_invalid' | 'email_invalid';

export interface IdentityResolution {
  identity: Identity | null;
  /** Why headers that were present did not yield an identity. For the log; never carries a header value. */
  rejected?: IdentityRejection;
}

function isIdentifier(value: string): boolean {
  return value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER.test(value);
}

/**
 * The display name. It is never compared with anything, so a value that
 * cannot be decoded costs the name, not the identity.
 */
function readFullName(headers: Headers): string | null {
  const raw = headers.get(USER_FULL_NAME_HEADER);
  if (raw === null) return null;
  let name = raw;
  if ((headers.get(USER_FULL_NAME_ENCODING_HEADER) ?? '').trim().toLowerCase() === PERCENT_ENCODED_UTF8) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (name === '') return null;
  return name.length > MAX_FULL_NAME_LENGTH ? name.slice(0, MAX_FULL_NAME_LENGTH) : name;
}

/**
 * Read the caller's identity from the gateway headers.
 *
 * The id and the email are taken exactly as sent: no percent-decoding, no
 * Unicode folding. A value that is empty, non-ASCII, or contains a comma,
 * whitespace or a control character rejects the whole identity, including a
 * well-formed value in the other header. The email is lowercased (ASCII only,
 * since anything else was rejected).
 *
 * The MCP body and its `_meta` are never consulted: this function is given
 * the headers and nothing else.
 */
export function resolveIdentity(headers: Headers): IdentityResolution {
  if (headers.has(BYPASS_TOKEN_HEADER)) {
    return { identity: null, rejected: 'bypass_token_present' };
  }
  const userId = headers.get(USER_ID_HEADER);
  const rawEmail = headers.get(USER_EMAIL_HEADER);
  if (userId === null && rawEmail === null) {
    return { identity: null };
  }
  if (userId !== null && !isIdentifier(userId)) {
    return { identity: null, rejected: 'user_id_invalid' };
  }
  if (rawEmail !== null && !isIdentifier(rawEmail)) {
    return { identity: null, rejected: 'email_invalid' };
  }
  const email = rawEmail === null ? null : rawEmail.toLowerCase();
  return {
    identity: {
      key: userId !== null ? `id:${userId}` : `email:${email}`,
      userId,
      email,
      fullName: readFullName(headers),
      source: 'sites-gateway',
    },
  };
}
