// Ports src/canvas_mcp/core/raw_dates.py.
/**
 * Machine-readable date blocks for the `raw_dates` option (upstream issue 418).
 *
 * The formatted read tools keep one date and drop the rest, so an agent cannot
 * tell "no due date" from "the date lives in a field the summary does not
 * show". These helpers copy date fields exactly as Canvas returned them: ISO
 * 8601 strings, with null kept as JSON `null`.
 *
 * Field names were measured against a live checkpointed discussion (fixture:
 * `test/fixtures/canvas_raw_dates.json`):
 *
 * - `has_sub_assignments` and `checkpoints` appear on the assignments list and
 *   single-assignment endpoints only with `include[]=checkpoints`.
 * - Each checkpoint carries `tag` (`reply_to_topic` / `reply_to_entry`),
 *   `due_at`, `unlock_at`, `lock_at`, `only_visible_to_overrides`, `overrides`,
 *   `name` and `points_possible`.
 * - The single-assignment endpoint returns `all_dates` only with the boolean
 *   query parameter `all_dates=true`; `include[]=all_dates` is ignored there.
 * - A discussion topic's embedded `assignment` already carries
 *   `has_sub_assignments` and `checkpoints` but never `all_dates`.
 *
 * The block is metadata only. It is built from an explicit allowlist, so the
 * `submission` object that `list_assignments` requests, grading counts and any
 * user field never reach it. Author-controlled text (checkpoint `name`, the
 * section or group `title` in `all_dates`) is left out too, so nothing in the
 * block needs an untrusted-content fence.
 */
import { escapeNonAsciiJson } from './python-text';

export type RawDatesBlock = Record<string, unknown>;

export const ASSIGNMENT_DATE_FIELDS: readonly string[] = ['due_at', 'unlock_at', 'lock_at', 'updated_at'];
const ALL_DATES_ENTRY_FIELDS: readonly string[] = ['id', 'base', 'set_type', 'set_id', 'due_at', 'unlock_at', 'lock_at'];
const CHECKPOINT_FIELDS: readonly string[] = ['tag', 'due_at', 'unlock_at', 'lock_at', 'only_visible_to_overrides'];
// Every checkpoint in the live capture had `overrides: []`, so the override
// shape is doc-derived, unverified. The allowlist keeps dates and the target
// ids, and drops `student_ids` and any override title.
const CHECKPOINT_OVERRIDE_FIELDS: readonly string[] = [
  'id',
  'set_type',
  'set_id',
  'course_section_id',
  'group_id',
  'due_at',
  'unlock_at',
  'lock_at',
];
const TOPIC_DATE_FIELDS: readonly string[] = ['delayed_post_at', 'lock_at', 'todo_date'];

export const CHECKPOINTED_NOTE =
  'Checkpointed discussion: the parent due_at is null by design. The due dates are on the checkpoints.';
export const TOPIC_ALL_DATES_NOTE =
  'The discussion-topic endpoint does not return all_dates. For section and ' +
  'override dates call get_assignment_details with raw_dates=True.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy only the listed keys Canvas actually returned (absent stays absent). */
function pick(source: Record<string, unknown>, fields: readonly string[]): RawDatesBlock {
  const out: RawDatesBlock = {};
  for (const key of fields) {
    // A key present with no value cannot come from JSON; write it as null rather than lose it on output.
    if (Object.hasOwn(source, key)) out[key] = source[key] ?? null;
  }
  return out;
}

/** Date metadata for one assignment, values exactly as Canvas returned them. */
export function assignmentRawDates(assignment: Record<string, unknown>): RawDatesBlock {
  const block: RawDatesBlock = { assignment_id: assignment.id ?? null };
  for (const field of ASSIGNMENT_DATE_FIELDS) {
    // These four are always present on Canvas assignment objects; a missing
    // one is reported as null rather than dropped.
    block[field] = assignment[field] ?? null;
  }

  const allDates = assignment.all_dates;
  if (Array.isArray(allDates)) {
    block.all_dates = allDates.filter(isRecord).map((entry) => pick(entry, ALL_DATES_ENTRY_FIELDS));
  }

  if (Object.hasOwn(assignment, 'has_sub_assignments')) {
    block.has_sub_assignments = assignment.has_sub_assignments ?? null;
  }

  const checkpoints = assignment.checkpoints;
  if (Array.isArray(checkpoints)) {
    const entries: RawDatesBlock[] = [];
    for (const checkpoint of checkpoints) {
      if (!isRecord(checkpoint)) continue;
      const entry = pick(checkpoint, CHECKPOINT_FIELDS);
      const overrides = checkpoint.overrides;
      if (Array.isArray(overrides)) {
        entry.overrides = overrides.filter(isRecord).map((override) => pick(override, CHECKPOINT_OVERRIDE_FIELDS));
      }
      entries.push(entry);
    }
    block.checkpoints = entries;
  }

  if (assignment.has_sub_assignments === true && (assignment.due_at ?? null) === null) {
    block.note = CHECKPOINTED_NOTE;
  }
  return block;
}

/** Date metadata for a discussion topic and, if graded, its assignment. */
export function topicRawDates(topic: Record<string, unknown>, topicId: string | number): RawDatesBlock {
  const block: RawDatesBlock = { topic_id: Object.hasOwn(topic, 'id') ? (topic.id ?? null) : topicId };
  Object.assign(block, pick(topic, TOPIC_DATE_FIELDS));
  if (Object.hasOwn(topic, 'is_checkpointed')) block.is_checkpointed = topic.is_checkpointed ?? null;

  const assignment = topic.assignment;
  const assignmentId = topic.assignment_id ?? null;
  if (isRecord(assignment)) {
    block.assignment = assignmentRawDates(assignment);
    block.notes = [TOPIC_ALL_DATES_NOTE];
  } else if (assignmentId !== null) {
    block.assignment = null;
    block.notes = [
      `Graded topic (assignment_id ${String(assignmentId)}), but Canvas did not ` +
        'embed the assignment in this response. Call get_assignment_details ' +
        'with raw_dates=True for its dates.',
    ];
  } else {
    block.assignment = null;
    block.notes = ['Ungraded topic: there is no assignment, so no assignment dates.'];
  }
  return block;
}

/** Render the block appended to a tool's text output. */
export function renderRawDates(payload: Record<string, unknown>): string {
  // Python's json.dumps escapes everything outside printable ASCII; JSON.stringify does not.
  const json = escapeNonAsciiJson(JSON.stringify(payload, null, 2));
  return `\n\nRaw dates (JSON, values exactly as Canvas returned them; null means Canvas returned null):\n${json}`;
}
