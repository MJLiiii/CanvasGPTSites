// Ports the two shared read tools in canvas_mcp/tools/assignments.py.
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { formatDate } from '../core/dates';
import { assignmentRawDates, renderRawDates } from '../core/raw-dates';
import { fenceUntrusted, fenceUntrustedInline } from '../core/untrusted-content';
import { defineTool } from '../mcp/define-tool';
import { COURSE_IDENTIFIER, READ_ONLY, field, record } from './read-helpers';

export const listAssignments = defineTool({
  name: 'list_assignments', title: 'List assignments', module: 'assignments', role: 'shared', effect: 'read', canvasScope: 'single',
  description: `List assignments for a specific course.

Args:
    course_identifier: Course code or Canvas ID
    raw_dates: Append a JSON block with each assignment's due_at,
        unlock_at, lock_at, updated_at, all_dates and checkpoint dates
        exactly as Canvas returns them (null stays null). Use it for
        due-date audits: a checkpointed discussion has a null due_at
        and its dates on the checkpoints. Default False.`,
  params: { course_identifier: COURSE_IDENTIFIER, raw_dates: { kind: 'bool', default: false, description: 'Append a JSON block with exact Canvas dates and checkpoint dates (null stays null).' } },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (args, ctx) => {
    const id = await ctx.canvas.courses.resolveId(args.course_identifier);
    if (isFailure(id)) return `Error fetching assignments: ${id.error}`;
    const assignments = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/courses/${id}/assignments`, {
      per_page: 100, 'include[]': args.raw_dates ? ['all_dates', 'submission', 'checkpoints'] : ['all_dates', 'submission'],
    }, { label: 'assignments' });
    if (isFailure(assignments)) return `Error fetching assignments: ${assignments.error}`;
    const notice = ctx.canvas.disclose(assignments);
    if (!assignments.items.length) return `No assignments found for course ${args.course_identifier}.` + notice;
    const display = await ctx.canvas.courses.resolveCode(id);
    const lines = assignments.items.map((a) => `ID: ${field(a, 'id', null)}\nName: ${fenceUntrustedInline(Object.hasOwn(a, 'name') ? a.name : 'Unnamed assignment', 'assignment name')}\nDue: ${field(a, 'due_at', 'No due date')}\nPoints: ${field(a, 'points_possible', 0)}\n`);
    let result = `Assignments for Course ${display}:\n\n` + lines.join('\n');
    if (args.raw_dates) result += renderRawDates({ assignments: assignments.items.map(assignmentRawDates) });
    return result + notice;
  },
});

export const getAssignmentDetails = defineTool({
  name: 'get_assignment_details', title: 'Get assignment details', module: 'assignments', role: 'shared', effect: 'read', canvasScope: 'single',
  description: `Get detailed information about a specific assignment.

Args:
    course_identifier: Course code or Canvas ID
    assignment_id: Canvas assignment ID
    raw_dates: Append a JSON block with due_at, unlock_at, lock_at,
        updated_at, all_dates and checkpoint dates exactly as Canvas
        returns them (null stays null). Default False.`,
  params: { course_identifier: COURSE_IDENTIFIER, assignment_id: { kind: 'id', description: 'Canvas assignment ID' },
    raw_dates: { kind: 'bool', default: false, description: 'Append a JSON block with exact Canvas dates and checkpoint dates (null stays null).' } },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (args, ctx) => {
    const id = await ctx.canvas.courses.resolveId(args.course_identifier);
    if (isFailure(id)) return `Error fetching assignment details: ${id.error}`;
    const response = await ctx.canvas.request('get', canvasPath`/courses/${id}/assignments/${args.assignment_id}`,
      args.raw_dates ? { params: { all_dates: 'true', 'include[]': ['checkpoints'] } } : undefined);
    if (isFailure(response)) return `Error fetching assignment details: ${response.error}`;
    const a = record(response);
    const display = await ctx.canvas.courses.resolveCode(id);
    const lines = [
      `Name: ${fenceUntrustedInline(Object.hasOwn(a, 'name') ? a.name : 'N/A', 'assignment name')}`,
      'Description:\n' + fenceUntrusted(a.description || 'N/A', 'assignment description'),
      `Due Date: ${formatDate(a.due_at as string | null, ctx.config.timezone)}`,
      `Points Possible: ${field(a, 'points_possible')}`,
      `Submission Types: ${Array.isArray(a.submission_types) ? a.submission_types.join(', ') : 'N/A'}`,
      `Published: ${field(a, 'published', false)}`, `Locked: ${field(a, 'locked_for_user', false)}`,
    ];
    return `Assignment Details for ID ${args.assignment_id} in course ${display}:\n\n` + lines.join('\n') + (args.raw_dates ? renderRawDates(assignmentRawDates(a)) : '');
  },
});
