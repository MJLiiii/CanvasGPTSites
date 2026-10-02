// Ports the raw_dates block cases of tests/tools/test_raw_dates.py against the pure helpers. The
// request-contract and default-output cases there exercise the assignment and discussion tools and
// belong with those tools' tests.
//
// Fixture provenance: test/fixtures/canvas_raw_dates.json is a REAL Canvas API response captured with
// read-only GETs and de-identified (see `_provenance` inside the file). Its date values, nulls and the
// checkpoint structure are exactly what Canvas returned. Tests that add keys to it (an injected
// `submission` object, a checkpoint override) say so where they do it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ASSIGNMENT_DATE_FIELDS,
  CHECKPOINTED_NOTE,
  TOPIC_ALL_DATES_NOTE,
  assignmentRawDates,
  renderRawDates,
  topicRawDates,
} from '../../src/core/raw-dates';

type Json = Record<string, any>;

// The path goes through `.href` because the Workers and Node typings disagree on the global URL type.
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/canvas_raw_dates.json', import.meta.url).href);
const FIXTURE: Json = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Json;
const CHECKPOINTED: Json = FIXTURE.checkpointed;
const GRADED: Json = FIXTURE.graded_discussion;
const MARKER = 'Raw dates (JSON';
const HEADER = '\n\nRaw dates (JSON, values exactly as Canvas returned them; null means Canvas returned null):\n';

// Every key the block may contain anywhere. Anything else is a leak.
const ALLOWED_KEYS = new Set([
  'assignments', 'assignment_id', 'due_at', 'unlock_at', 'lock_at', 'updated_at',
  'all_dates', 'id', 'base', 'set_type', 'set_id', 'has_sub_assignments',
  'checkpoints', 'tag', 'only_visible_to_overrides', 'overrides',
  'course_section_id', 'group_id', 'note', 'notes', 'topic_id',
  'delayed_post_at', 'todo_date', 'is_checkpointed', 'assignment',
]);
const FORBIDDEN_KEYS = new Set([
  'submission', 'submissions', 'score', 'grade', 'entered_grade', 'user_id',
  'user', 'student_ids', 'students', 'needs_grading_count',
  'graded_submissions_exist', 'has_submitted_submissions', 'points_possible',
  'name', 'title', 'description', 'message', 'author', 'display_name',
]);

// Hand-transcribed from the fixture's real checkpoint data.
const EXPECTED_CHECKPOINTS = [
  {
    tag: 'reply_to_topic', due_at: '2026-08-15T04:59:59Z', unlock_at: null,
    lock_at: null, only_visible_to_overrides: false, overrides: [],
  },
  {
    tag: 'reply_to_entry', due_at: '2026-08-16T04:59:59Z', unlock_at: null,
    lock_at: null, only_visible_to_overrides: false, overrides: [],
  },
];
const EXPECTED_ALL_DATES = [
  { base: true, due_at: '2026-08-15T04:59:59Z', unlock_at: null, lock_at: null },
  { base: true, due_at: '2026-08-16T04:59:59Z', unlock_at: null, lock_at: null },
];

/** The JSON block of a rendered tool output, parsed back (upstream's `_block`). */
function block(text: string): Json {
  expect(text).toContain(MARKER);
  const afterMarker = text.slice(text.indexOf(MARKER) + MARKER.length);
  return JSON.parse(afterMarker.slice(afterMarker.indexOf('\n') + 1)) as Json;
}

function allKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) for (const key of allKeys(item)) keys.add(key);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      for (const nested of allKeys(inner)) keys.add(nested);
    }
  }
  return keys;
}

function expectOnlyAllowedKeys(value: unknown): void {
  const keys = [...allKeys(value)];
  expect(keys.filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);
  expect(keys.filter((key) => FORBIDDEN_KEYS.has(key))).toEqual([]);
}

/** What list_assignments appends with raw_dates: one block entry per assignment. */
function renderList(items: Json[]): string {
  return renderRawDates({ assignments: items.map((item) => assignmentRawDates(item)) });
}

function listItems(): Json[] {
  return [structuredClone(CHECKPOINTED.list_item), structuredClone(GRADED.list_item)];
}

describe('list_assignments raw dates', () => {
  it('reports checkpointed discussion dates', () => {
    const entries = block(renderList(listItems())).assignments as Json[];
    const cp = entries[0] as Json;
    expect(cp.assignment_id).toBe(5001);
    expect(cp.due_at).toBeNull();
    expect(cp.unlock_at).toBeNull();
    expect(cp.lock_at).toBeNull();
    expect(cp.updated_at).toBe('2026-08-13T17:30:26Z');
    expect(cp.has_sub_assignments).toBe(true);
    expect(cp.checkpoints).toEqual(EXPECTED_CHECKPOINTS);
    expect(cp.all_dates).toEqual(EXPECTED_ALL_DATES);
    expect(cp.note).toContain('null by design');
  });

  it('gives a plain graded discussion no checkpoint note', () => {
    const plain = (block(renderList(listItems())).assignments as Json[])[1] as Json;
    expect(plain.due_at).toBe('2021-02-01T05:59:59Z');
    expect(plain.has_sub_assignments).toBe(false);
    expect(plain.checkpoints).toEqual([]);
    expect(plain.all_dates).toEqual([
      { base: true, due_at: '2021-02-01T05:59:59Z', unlock_at: null, lock_at: null },
    ]);
    expect('note' in plain).toBe(false);
  });

  it('writes null as JSON null, never None or N/A', () => {
    const rendered = renderList(listItems());
    const raw = rendered.slice(rendered.indexOf(MARKER) + MARKER.length);
    expect(raw).toContain('"due_at": null');
    for (const bad of ['None', 'N/A', 'No due date', 'undefined']) expect(raw).not.toContain(bad);
  });

  it('carries no submission, grade or user fields', () => {
    const items = listItems();
    // Injected (not captured): the shape include[]=submission adds per item.
    for (const item of items) {
      item.submission = {
        id: 1, user_id: 4242, score: 9.5, grade: '9.5',
        entered_grade: '9.5', submitted_at: '2026-08-14T10:00:00Z',
        workflow_state: 'graded',
      };
    }
    const rendered = renderList(items);
    expectOnlyAllowedKeys(block(rendered));
    const raw = rendered.slice(rendered.indexOf(MARKER) + MARKER.length);
    expect(raw).not.toContain('4242');
    expect(raw).not.toContain('2026-08-14T10:00:00Z');
  });
});

describe('get_assignment_details raw dates', () => {
  it('builds the block', () => {
    const result = block(renderRawDates(assignmentRawDates(structuredClone(CHECKPOINTED.assignment))));
    expect(result).toEqual({
      assignment_id: 5001,
      due_at: null,
      unlock_at: null,
      lock_at: null,
      updated_at: '2026-08-13T17:30:26Z',
      all_dates: EXPECTED_ALL_DATES,
      has_sub_assignments: true,
      checkpoints: EXPECTED_CHECKPOINTS,
      note: 'Checkpointed discussion: the parent due_at is null by design. The due dates are on the checkpoints.',
    });
    // Key order is part of the rendered output.
    expect(Object.keys(result)).toEqual([
      'assignment_id', 'due_at', 'unlock_at', 'lock_at', 'updated_at',
      'all_dates', 'has_sub_assignments', 'checkpoints', 'note',
    ]);
  });

  it('drops student fields from a checkpoint override', () => {
    // Doc-derived, unverified: every checkpoint in the live capture had
    // overrides == []. This injected override checks the allowlist only.
    const single = structuredClone(CHECKPOINTED.assignment);
    single.checkpoints[0].overrides = [
      {
        id: 77, assignment_id: 5001, title: '2 students',
        student_ids: [4242, 4343], due_at: '2026-08-20T04:59:59Z',
        unlock_at: null, lock_at: null,
      },
    ];
    const override = block(renderRawDates(assignmentRawDates(single))).checkpoints[0].overrides[0];
    expect(override).toEqual({ id: 77, due_at: '2026-08-20T04:59:59Z', unlock_at: null, lock_at: null });
  });

  it('keeps the override target ids', () => {
    const single = structuredClone(CHECKPOINTED.assignment);
    single.checkpoints[1].overrides = [
      { id: 78, set_type: 'CourseSection', set_id: 12, course_section_id: 12, group_id: null, due_at: null, title: 'Section B' },
    ];
    expect(assignmentRawDates(single).checkpoints).toEqual([
      EXPECTED_CHECKPOINTS[0],
      {
        ...EXPECTED_CHECKPOINTS[1],
        overrides: [{ id: 78, set_type: 'CourseSection', set_id: 12, course_section_id: 12, group_id: null, due_at: null }],
      },
    ]);
  });
});

describe('get_discussion_topic_details raw dates', () => {
  it('reports a checkpointed topic', () => {
    const result = block(renderRawDates(topicRawDates(structuredClone(CHECKPOINTED.topic), '7001')));
    expect(result.topic_id).toBe(7001);
    expect(result.is_checkpointed).toBe(true);
    expect(result.lock_at).toBeNull();
    expect(result.todo_date).toBeNull();
    const assignment = result.assignment as Json;
    expect(assignment.assignment_id).toBe(5001);
    expect(assignment.due_at).toBeNull();
    expect(assignment.has_sub_assignments).toBe(true);
    expect(assignment.checkpoints).toEqual(EXPECTED_CHECKPOINTS);
    expect(assignment.note).toContain('null by design');
    // The topic endpoint's embedded assignment never carries all_dates.
    expect('all_dates' in assignment).toBe(false);
    expect((result.notes as string[]).some((note) => note.includes('raw_dates=True'))).toBe(true);
    expectOnlyAllowedKeys(result);
  });

  it('shows the assignment dates of a graded topic', () => {
    const result = block(renderRawDates(topicRawDates(structuredClone(GRADED.topic), '7002')));
    expect(result.assignment.due_at).toBe('2021-02-01T05:59:59Z');
    expect(result.assignment.has_sub_assignments).toBe(false);
    expect('note' in result.assignment).toBe(false);
    expect(result.notes).toEqual([TOPIC_ALL_DATES_NOTE]);
  });

  it('reports an ungraded topic', () => {
    const topic = structuredClone(GRADED.topic);
    delete topic.assignment;
    delete topic.assignment_id;
    const result = block(renderRawDates(topicRawDates(topic, '7002')));
    expect(result.assignment).toBeNull();
    expect(result.notes[0]).toContain('Ungraded');
    expect(result.notes).toEqual(['Ungraded topic: there is no assignment, so no assignment dates.']);
  });

  it('reports a graded topic without an embedded assignment', () => {
    const topic = structuredClone(GRADED.topic);
    delete topic.assignment;
    const result = block(renderRawDates(topicRawDates(topic, '7002')));
    expect(result.assignment).toBeNull();
    expect(result.notes[0]).toContain('assignment_id 5002');
    expect(result.notes[0]).toContain('get_assignment_details');
    expect(result.notes).toEqual([
      'Graded topic (assignment_id 5002), but Canvas did not embed the assignment in this response. ' +
        'Call get_assignment_details with raw_dates=True for its dates.',
    ]);
  });

  it('falls back to the requested id only when the topic has no id key', () => {
    expect(topicRawDates({}, '7002')).toEqual({
      topic_id: '7002',
      assignment: null,
      notes: ['Ungraded topic: there is no assignment, so no assignment dates.'],
    });
    expect(topicRawDates({}, 7002).topic_id).toBe(7002);
    // Values produced by upstream topic_raw_dates for this input.
    expect(topicRawDates({ id: null, assignment: 'x', assignment_id: 0, lock_at: null, is_checkpointed: false }, 9)).toEqual({
      topic_id: null,
      lock_at: null,
      is_checkpointed: false,
      assignment: null,
      notes: [
        'Graded topic (assignment_id 0), but Canvas did not embed the assignment in this response. ' +
          'Call get_assignment_details with raw_dates=True for its dates.',
      ],
    });
  });
});

describe('assignmentRawDates', () => {
  it('exposes upstream constants', () => {
    expect(ASSIGNMENT_DATE_FIELDS).toEqual(['due_at', 'unlock_at', 'lock_at', 'updated_at']);
    expect(CHECKPOINTED_NOTE).toBe(
      'Checkpointed discussion: the parent due_at is null by design. The due dates are on the checkpoints.',
    );
    expect(TOPIC_ALL_DATES_NOTE).toBe(
      'The discussion-topic endpoint does not return all_dates. For section and override dates call ' +
        'get_assignment_details with raw_dates=True.',
    );
  });

  it('reports missing date fields as null rather than dropping them', () => {
    expect(assignmentRawDates({})).toEqual({
      assignment_id: null,
      due_at: null,
      unlock_at: null,
      lock_at: null,
      updated_at: null,
    });
  });

  it('ignores all_dates and checkpoints that are not lists, and entries that are not objects', () => {
    // Values produced by upstream assignment_raw_dates for these inputs.
    expect(
      assignmentRawDates({ id: 1, due_at: null, has_sub_assignments: true, all_dates: 'x', checkpoints: {} }),
    ).toEqual({
      assignment_id: 1,
      due_at: null,
      unlock_at: null,
      lock_at: null,
      updated_at: null,
      has_sub_assignments: true,
      note: CHECKPOINTED_NOTE,
    });

    const single = structuredClone(CHECKPOINTED.assignment);
    single.all_dates.push('junk', null, ['nested']);
    single.checkpoints.push(5, null);
    single.checkpoints[0].overrides = ['junk', null];
    const result = assignmentRawDates(single);
    expect(result.all_dates).toEqual(EXPECTED_ALL_DATES);
    expect(result.checkpoints).toEqual(EXPECTED_CHECKPOINTS);
  });

  it('adds the note only for a checkpointed parent with a null due date', () => {
    expect('note' in assignmentRawDates({ id: 1, due_at: '2026-01-01T00:00:00Z', has_sub_assignments: true })).toBe(false);
    expect('note' in assignmentRawDates({ id: 1, due_at: null, has_sub_assignments: false })).toBe(false);
    expect('note' in assignmentRawDates({ id: 1, due_at: null, has_sub_assignments: 'true' })).toBe(false);
    expect(assignmentRawDates({ id: 1, has_sub_assignments: true }).note).toBe(CHECKPOINTED_NOTE);
  });

  it('does not modify its input', () => {
    const single = structuredClone(CHECKPOINTED.assignment);
    const before = JSON.stringify(single);
    assignmentRawDates(single);
    topicRawDates(structuredClone(CHECKPOINTED.topic), '7001');
    expect(JSON.stringify(single)).toBe(before);
  });
});

describe('renderRawDates', () => {
  it('renders the header and two-space JSON exactly as upstream does', () => {
    expect(renderRawDates({ assignment_id: 1, due_at: null, checkpoints: [], all_dates: [{ base: true }], empty: {} })).toBe(
      `${HEADER}{\n  "assignment_id": 1,\n  "due_at": null,\n  "checkpoints": [],\n  "all_dates": [\n` +
        '    {\n      "base": true\n    }\n  ],\n  "empty": {}\n}',
    );
  });

  it('renders the graded fixture item exactly as upstream does', () => {
    expect(renderRawDates(assignmentRawDates(structuredClone(GRADED.list_item)))).toBe(
      `${HEADER}${[
        '{',
        '  "assignment_id": 5002,',
        '  "due_at": "2021-02-01T05:59:59Z",',
        '  "unlock_at": null,',
        '  "lock_at": null,',
        '  "updated_at": "2021-01-14T14:53:04Z",',
        '  "all_dates": [',
        '    {',
        '      "base": true,',
        '      "due_at": "2021-02-01T05:59:59Z",',
        '      "unlock_at": null,',
        '      "lock_at": null',
        '    }',
        '  ],',
        '  "has_sub_assignments": false,',
        '  "checkpoints": []',
        '}',
      ].join('\n')}`,
    );
  });

  it('escapes everything outside printable ASCII, as json.dumps does', () => {
    expect(renderRawDates({ due_at: 'café ☃ 😀 \u007f \u0001 "q" \\' })).toBe(
      `${HEADER}{\n  "due_at": "caf\\u00e9 \\u2603 \\ud83d\\ude00 \\u007f \\u0001 \\"q\\" \\\\"\n}`,
    );
  });
});
