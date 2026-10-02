// Ports canvas-mcp src/canvas_mcp/core/tool_policy.py (HTTP-transport semantics only).
/**
 * Operator-controlled allowlist for tools that change anything.
 *
 * Why this exists (GHSA-hmr8-mvr2-mvw5): a student can plant instructions in
 * content the assistant later reads. Previews and confirmation tokens do not
 * stop a model that follows them, because the model receives its own token and
 * can redeem it. The boundary a prompt injection cannot talk its way past is
 * one the model has no hand in: which tools exist at all, fixed by the owner in
 * the Site's environment.
 *
 * Read tools are always available. Tools with side effects exist only when
 * `ALLOWED_WRITE_TOOLS` names them:
 *  - unset, or set but empty (blank, spaces or only commas): none
 *  - `none`: none
 *  - `all`: every Canvas-write and local-write tool, never code execution
 *  - a comma- or space-separated list of tool names: exactly those
 */
import type { Effect } from '../types';

export const ALLOWLIST_ENV = 'ALLOWED_WRITE_TOOLS';

const EFFECT_TABLE: Record<string, Effect> = {
  // --- READ (58) ---
  analyze_peer_review_quality: 'read',
  check_enrollment: 'read',
  fetch_ufixit_report: 'read',
  format_accessibility_summary: 'read',
  generate_peer_review_feedback_report: 'read',
  get_anonymization_status: 'read',
  get_assignment_analytics: 'read',
  get_assignment_details: 'read',
  get_content_migration_status: 'read',
  get_conversation_details: 'read',
  get_course_content_overview: 'read',
  get_course_details: 'read',
  get_course_structure: 'read',
  get_discussion_entry_details: 'read',
  get_discussion_topic_details: 'read',
  get_discussion_with_replies: 'read',
  get_front_page: 'read',
  get_my_course_grades: 'read',
  get_my_enrollments: 'read',
  get_my_peer_reviews_todo: 'read',
  get_my_profile: 'read',
  get_my_submission: 'read',
  get_my_submission_status: 'read',
  get_my_todo_items: 'read',
  get_my_upcoming_assignments: 'read',
  get_page_content: 'read',
  get_page_details: 'read',
  get_peer_review_assignments: 'read',
  get_peer_review_comments: 'read',
  get_peer_review_completion_analytics: 'read',
  get_peer_review_followup_list: 'read',
  get_rubric: 'read',
  get_rubric_assessment: 'read',
  get_student_analytics: 'read',
  get_syllabus: 'read',
  get_unread_count: 'read',
  identify_problematic_peer_reviews: 'read',
  list_announcements: 'read',
  list_assignments: 'read',
  list_code_api_modules: 'read',
  list_conversations: 'read',
  list_course_files: 'read',
  list_courses: 'read',
  list_discussion_entries: 'read',
  list_discussion_topics: 'read',
  list_group_discussion_topics: 'read',
  list_groups: 'read',
  list_module_items: 'read',
  list_modules: 'read',
  list_pages: 'read',
  list_peer_reviews: 'read',
  list_rubrics: 'read',
  list_submissions: 'read',
  list_users: 'read',
  parse_ufixit_violations: 'read',
  read_course_file: 'read',
  scan_course_content_accessibility: 'read',
  search_canvas_tools: 'read',
  // --- CANVAS_WRITE (41) ---
  add_module_item: 'canvas_write',
  assign_peer_review: 'canvas_write',
  associate_rubric: 'canvas_write',
  bulk_delete_announcements: 'canvas_write',
  bulk_grade_submissions: 'canvas_write',
  bulk_update_pages: 'canvas_write',
  comment_on_my_submission: 'canvas_write',
  create_announcement: 'canvas_write',
  create_assignment: 'canvas_write',
  create_content_migration: 'canvas_write',
  create_discussion_topic: 'canvas_write',
  create_module: 'canvas_write',
  create_page: 'canvas_write',
  create_rubric: 'canvas_write',
  create_rubric_from_csv: 'canvas_write',
  delete_announcement_with_confirmation: 'canvas_write',
  delete_announcements_by_criteria: 'canvas_write',
  delete_assignment_with_confirmation: 'canvas_write',
  delete_module: 'canvas_write',
  delete_module_item: 'canvas_write',
  delete_page: 'canvas_write',
  edit_page_content: 'canvas_write',
  fix_accessibility_issues: 'canvas_write',
  grade_with_rubric: 'canvas_write',
  mark_conversations_read: 'canvas_write',
  mark_module_item_done: 'canvas_write',
  post_discussion_entry: 'canvas_write',
  reply_to_discussion_entry: 'canvas_write',
  send_bulk_messages_from_list: 'canvas_write',
  send_conversation: 'canvas_write',
  send_peer_review_followup_campaign: 'canvas_write',
  send_peer_review_inbox_messages: 'canvas_write',
  submit_assignment: 'canvas_write',
  update_assignment: 'canvas_write',
  update_discussion_topic: 'canvas_write',
  update_module: 'canvas_write',
  update_module_item: 'canvas_write',
  update_page_settings: 'canvas_write',
  update_rubric: 'canvas_write',
  update_syllabus: 'canvas_write',
  upload_course_file: 'canvas_write',
  // --- LOCAL_WRITE (4) ---
  create_student_anonymization_map: 'local_write',
  download_course_file: 'local_write',
  extract_peer_review_dataset: 'local_write',
  generate_peer_review_report: 'local_write',
  // --- CODE_EXEC (1) ---
  execute_typescript: 'code_exec',
};

/**
 * Every upstream tool, classified by what it can change. The object has no
 * prototype, so indexing it with an arbitrary name (`constructor`, `__proto__`)
 * can only ever yield a classified tool or undefined.
 */
export const TOOL_EFFECTS: Readonly<Record<string, Effect>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Effect>, EFFECT_TABLE),
);

/** Names of every tool that is not a read. */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(TOOL_EFFECTS).filter((name) => TOOL_EFFECTS[name] !== 'read'),
);

/** What the `all` keyword expands to: Canvas writes and local writes, never code execution. */
export const ALL_KEYWORD_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(TOOL_EFFECTS).filter((name) => {
    const effect = TOOL_EFFECTS[name];
    return effect === 'canvas_write' || effect === 'local_write';
  }),
);

export type ToolPolicyResult =
  | { ok: true; allowedWrites: ReadonlySet<string> }
  | { ok: false; error: string };

/** The entries of a list-valued setting: separated by commas or whitespace, blanks dropped. */
export function splitEntries(value: string): string[] {
  return value
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter((part) => part !== '');
}

// Letters, digits and underscores, at most 64 characters: what a tool name, a
// keyword or a typo of one looks like.
const NAME_SHAPED_ENTRY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * How the entries of a list-valued setting (ALLOWED_WRITE_TOOLS, DISABLED_TOOLS,
 * STUDENT_WRITE_TOOLS, ACCESSIBILITY_CHECKERS) are named in a message: sorted,
 * and echoed as upstream does only when they are shaped like a name. Anything
 * else is shown by length only. These settings are split on commas and
 * whitespace, so a secret pasted into the wrong one arrives here in pieces
 * that no redaction list would recognise; a token, a key or a URL is not
 * name-shaped and so does not come back out through the message.
 */
export function describeEntries(names: Iterable<string>): string {
  return [...names]
    .sort()
    .map((name) => (NAME_SHAPED_ENTRY.test(name) ? name : `<${name.length} characters>`))
    .join(', ');
}

/**
 * Turn the ALLOWED_WRITE_TOOLS value into the set of permitted side-effect
 * tools, or refuse clearly. `null` means the variable is unset.
 *
 * Refused: unknown tool names, read tools named as if they needed allowing,
 * and `none` or `all` combined with anything else.
 */
export function resolveToolPolicy(raw: string | null): ToolPolicyResult {
  if (raw === null) {
    return { ok: true, allowedWrites: new Set() };
  }

  const names = new Set(splitEntries(raw));
  if (names.size === 0) {
    // Set but empty is treated as none: a generated allowlist that became
    // empty must fail closed.
    return { ok: true, allowedWrites: new Set() };
  }

  const isKeyword = (name: string, keyword: string): boolean => name.toLowerCase() === keyword;
  const requested = [...names].filter((name) => !isKeyword(name, 'none') && !isKeyword(name, 'all'));
  const hasNone = [...names].some((name) => isKeyword(name, 'none'));
  const hasAll = [...names].some((name) => isKeyword(name, 'all'));

  if (hasNone) {
    const others = [...names].filter((name) => !isKeyword(name, 'none'));
    if (others.length > 0) {
      return {
        ok: false,
        error: `${ALLOWLIST_ENV}: 'none' cannot be combined with other entries (got: ${describeEntries(names)})`,
      };
    }
    return { ok: true, allowedWrites: new Set() };
  }

  const unknown = requested.filter((name) => !Object.hasOwn(TOOL_EFFECTS, name));
  if (unknown.length > 0) {
    return { ok: false, error: `${ALLOWLIST_ENV} names unknown tools: ${describeEntries(unknown)}` };
  }
  const reads = requested.filter((name) => TOOL_EFFECTS[name] === 'read');
  if (reads.length > 0) {
    return {
      ok: false,
      error:
        `${ALLOWLIST_ENV} lists read-only tools, which are always available: ` +
        `${describeEntries(reads)}. List only tools that change something.`,
    };
  }

  if (hasAll) {
    // Upstream lets `all` be extended with `execute_typescript`. This port has
    // no code execution, so a mixed value has no meaning left and is refused
    // rather than guessed at.
    if (requested.length > 0) {
      return {
        ok: false,
        error: `${ALLOWLIST_ENV}: 'all' cannot be combined with other entries (got: ${describeEntries(names)})`,
      };
    }
    return { ok: true, allowedWrites: new Set(ALL_KEYWORD_TOOLS) };
  }

  return { ok: true, allowedWrites: new Set(requested) };
}

/**
 * Tools whose upstream class is a write but which this port registers as a
 * read, because the writing half was removed. `generate_peer_review_report`
 * returns its report inline only; it stays LOCAL_WRITE in the table so an
 * upstream allowlist that names it still parses.
 */
export const READ_EFFECT_OVERRIDES: ReadonlySet<string> = new Set(['generate_peer_review_report']);

/** The effect a tool is registered with in this port, or undefined when it is unclassified. */
export function registeredEffect(name: string): Effect | undefined {
  if (!Object.hasOwn(TOOL_EFFECTS, name)) return undefined;
  return READ_EFFECT_OVERRIDES.has(name) ? 'read' : TOOL_EFFECTS[name];
}

/**
 * Whether a tool may be registered under the resolved policy.
 *
 * `effect` is the effect the tool definition declares. It is not trusted on its
 * own: a tool counts as a read only when the classification here agrees, so a
 * writer mis-declared as a read still needs the allowlist. A name missing from
 * TOOL_EFFECTS is refused whatever it declares (fail closed), and code
 * execution is refused even when named, because this port does not offer it.
 */
export function isToolAllowed(name: string, effect: Effect, allowedWrites: ReadonlySet<string>): boolean {
  const classified = registeredEffect(name);
  if (classified === undefined) return false;
  if (classified === 'code_exec' || effect === 'code_exec') return false;
  if (classified === 'read' && effect === 'read') return true;
  return allowedWrites.has(name);
}
