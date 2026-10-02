// Ports the endpoint tier selection and data-type detection in upstream src/canvas_mcp/core/client.py (lines 99-323).
import type { AnonymizationTier } from '../types';

/** Which typed refinement the full tier layers on top of the identity scrub. */
export type AnonymizationDataType = 'users' | 'discussions' | 'submissions' | 'assignments' | 'general';

/**
 * Endpoints that describe ONLY the authenticated caller. Anonymizing them
 * corrupts the caller's own identity, so they are exempt, but only by EXACT
 * full-joined-path match. A prefix or substring rule here is how upstream
 * issues #164/#166 happened. `users/self/enrollments` is deliberately absent:
 * with `include[]=observed_users` it returns other students, and this gate
 * cannot see request parameters.
 */
export const SELF_ONLY_ENDPOINTS: ReadonlySet<string> = new Set(['users/self', 'users/self/profile']);

/** Discussion sub-routes that carry student posts and names. */
const DISCUSSION_CONTENT_SEGMENTS: ReadonlySet<string> = new Set(['entries', 'view', 'entry_list', 'replies']);

/** Route segments whose responses contain student records. */
const STUDENT_RECORD_SEGMENTS: ReadonlySet<string> = new Set(['users', 'submissions', 'enrollments', 'analytics']);

const CONVERSATION_SEGMENTS: ReadonlySet<string> = new Set(['conversations']);
const PAGE_SEGMENTS: ReadonlySet<string> = new Set(['pages']);

/** Checked in order; the first rule with a matching route segment wins. */
const DATA_TYPE_RULES: ReadonlyArray<readonly [ReadonlySet<string>, AnonymizationDataType]> = [
  [new Set(['users']), 'users'],
  [new Set(['discussion_topics', 'discussion_entries']), 'discussions'],
  [new Set(['submissions']), 'submissions'],
  [new Set(['assignments']), 'assignments'],
  [new Set(['enrollments']), 'users'],
];

/** Lower-cased, query-stripped path segments of a Canvas API path. */
function pathSegments(endpoint: string): string[] {
  const path = endpoint.toLowerCase().split('?', 1)[0] ?? '';
  return path.split('/').filter((seg) => seg !== '');
}

/**
 * Whether segments[index] is a route keyword rather than a user slug. A segment
 * directly after 'pages' is a user-controlled page slug (a page may be named
 * "users") and must never be treated as a route keyword.
 */
function isRouteSegment(segments: readonly string[], index: number): boolean {
  return !(index > 0 && segments[index - 1] === 'pages');
}

function hasRouteSegment(segments: readonly string[], names: ReadonlySet<string>): boolean {
  return segments.some((seg, i) => names.has(seg) && isRouteSegment(segments, i));
}

/**
 * Indices of 'submissions' route segments IMMEDIATELY followed by the literal
 * 'self'. A looser match ('self' anywhere) would recreate upstream's #164 bypass.
 */
function selfSubmissionIndices(segments: readonly string[]): Set<number> {
  const indices = new Set<number>();
  segments.forEach((seg, i) => {
    if (seg === 'submissions' && isRouteSegment(segments, i) && segments[i + 1] === 'self') {
      indices.add(i);
    }
  });
  return indices;
}

/** Upstream `_endpoint_anonymization_mode`, on already-split segments. */
function tierForSegments(allSegments: readonly string[]): AnonymizationTier {
  // Exact-path allowlist, checked before the sensitive-segment rules because
  // 'users' would otherwise match.
  if (SELF_ONLY_ENDPOINTS.has(allSegments.join('/'))) {
    return 'none';
  }

  // Drop only the 'submissions' segment of a /submissions/self route; every
  // other sensitive segment keeps its effect.
  const selfIndices = selfSubmissionIndices(allSegments);
  const segments = selfIndices.size > 0 ? allSegments.filter((_, i) => !selfIndices.has(i)) : allSegments;

  if (segments.includes('discussion_topics') && hasRouteSegment(segments, DISCUSSION_CONTENT_SEGMENTS)) {
    return 'full';
  }
  if (hasRouteSegment(segments, STUDENT_RECORD_SEGMENTS)) {
    return 'full';
  }
  if (hasRouteSegment(segments, CONVERSATION_SEGMENTS)) {
    return 'free_text';
  }
  // 'front_page' is a fixed Canvas route word, not a slug, so it needs no
  // route-segment guard.
  if (hasRouteSegment(segments, PAGE_SEGMENTS) || segments.includes('front_page')) {
    return 'identity';
  }
  return 'none';
}

/**
 * The segments a server that percent-decodes (and then re-splits) the path
 * would route on. Malformed UTF-8 escapes fall back to decoding ASCII escapes
 * only, which is all a route keyword can be made of.
 */
function decodedSegments(segments: readonly string[]): string[] {
  return segments.flatMap((seg) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    return decoded
      .toLowerCase()
      .split('/')
      .filter((part) => part !== '');
  });
}

/**
 * The stricter of two tiers. `identity` and `free_text` are different halves of
 * the scrubber, not points on one scale, so combining them needs both halves:
 * the only tier that provides that is `full`.
 */
export function maxTier(a: AnonymizationTier, b: AnonymizationTier): AnonymizationTier {
  if (a === b) {
    return a;
  }
  if (a === 'none') {
    return b;
  }
  if (b === 'none') {
    return a;
  }
  return 'full';
}

/**
 * Anonymization tier for the FINAL requested pathname with the API base
 * removed (e.g. "/courses/1/users"), never a path template.
 *
 * Sensitive-segment checks run before any safe-endpoint reasoning, and the
 * tiers are tested most-protective-first, so a path that matches several
 * families gets the strongest treatment. Anything unmatched is `none`.
 *
 * Upstream matches the literal segments only. A pathname can also carry a
 * percent-encoded route keyword ("%75sers"), which Canvas decodes before
 * routing, so the decoded reading is classified as well and the stricter of
 * the two results is used. This can only raise the tier.
 */
export function tierForPath(apiRelativePath: string): AnonymizationTier {
  const segments = pathSegments(apiRelativePath);
  const literal = tierForSegments(segments);
  if (!segments.some((seg) => seg.includes('%'))) {
    return literal;
  }
  return maxTier(literal, tierForSegments(decodedSegments(segments)));
}

/**
 * Upstream `_determine_data_type`. Segment-aware (query string stripped, page
 * slugs excluded) so a user-controlled slug cannot route a response into the
 * wrong typed refinement.
 */
export function dataTypeForPath(apiRelativePath: string): AnonymizationDataType {
  const segments = pathSegments(apiRelativePath);
  for (const [names, dataType] of DATA_TYPE_RULES) {
    if (hasRouteSegment(segments, names)) {
      return dataType;
    }
  }
  return 'general';
}
