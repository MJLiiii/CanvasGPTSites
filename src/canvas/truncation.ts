// No upstream counterpart: canvas-mcp reports "Pagination exceeded N pages" as an error. Here a cut-off list is
// returned with a reason, and these are the words for that reason wherever it is reported.
import type { TruncationReason } from '../types';

/** What the caller can do about a truncated or oversized result. */
export const NARROW_REQUEST_HINT = 'Narrow the request (one course, a search term, or a date range).';

/** Why a list was cut short, as a clause that follows "because". */
export const TRUNCATION_REASON_TEXT: Readonly<Record<TruncationReason, string>> = Object.freeze({
  max_pages: 'the page limit was reached',
  max_items: 'the item limit was reached',
  budget: 'the request budget for this tool call ran out',
  deadline: 'the time limit for this tool call was reached',
  throttle: 'Canvas is close to rate-limiting this account',
});
