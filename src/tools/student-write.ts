// Ports only the read tool from canvas_mcp/tools/student_write.py. No write handler yet.
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { formatDate } from '../core/dates';
import { fenceUntrusted, fenceUntrustedInline } from '../core/untrusted-content';
import { coerceCanvasId } from '../core/validation';
import { defineTool } from '../mcp/define-tool';
import { COURSE_IDENTIFIER, READ_ONLY, field, record, records } from './read-helpers';

export const getMySubmission = defineTool({
  name: 'get_my_submission', title: 'Get my submission', module: 'student_write', role: 'student', effect: 'read', canvasScope: 'single',
  description: `Get your own submission for an assignment, including attempts used.

Args:
    course_identifier: Course code or Canvas ID
    assignment_id: Canvas assignment ID`,
  params: { course_identifier: COURSE_IDENTIFIER, assignment_id: { kind: 'id', description: 'Canvas assignment ID' } },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (args, ctx) => {
    const assignmentId = coerceCanvasId(args.assignment_id);
    if (assignmentId === null) return 'Error: assignment_id must be a numeric Canvas assignment ID. Use list_assignments to find it.';
    const id = await ctx.canvas.courses.resolveId(args.course_identifier);
    if (isFailure(id)) return `Error fetching submission: ${id.error}`;
    const response = await ctx.canvas.request('get', canvasPath`/courses/${id}/assignments/${assignmentId}/submissions/self`, {
      params: { 'include[]': ['submission_comments', 'assignment'] },
    });
    if (isFailure(response)) return `Error fetching submission: ${response.error}`;
    const submission = record(response);
    const assignment = record(submission.assignment);
    const lines = [
      `Submission for: ${fenceUntrustedInline(Object.hasOwn(assignment, 'name') ? assignment.name : `Assignment ${assignmentId}`, 'assignment name')}`,
      `Status: ${field(submission, 'workflow_state', 'unsubmitted')}`,
      submission.submitted_at ? `Submitted: ${formatDate(String(submission.submitted_at), ctx.config.timezone)}` : 'Submitted: not yet',
    ];
    if (assignment.due_at) lines.push(`Due: ${formatDate(String(assignment.due_at), ctx.config.timezone)}`);
    if (assignment.lock_at) lines.push(`Locks: ${formatDate(String(assignment.lock_at), ctx.config.timezone)}`);
    const used = typeof submission.attempt === 'number' ? submission.attempt : 0;
    const allowed = assignment.allowed_attempts;
    if (typeof allowed !== 'number' || allowed === -1) lines.push(`Attempts: ${used} used, unlimited allowed`);
    else {
      const remaining = allowed - used;
      lines.push(`Attempts: ${used} of ${allowed} used, ${remaining} remaining.${remaining <= 1 ? '  ⚠️  This is your LAST attempt.' : ''}`);
    }
    if (submission.grade !== null && submission.grade !== undefined) lines.push(`Grade: ${field(submission, 'grade')}`);
    const comments = records(submission.submission_comments);
    if (comments.length) {
      lines.push(`\nComments (${comments.length}):`);
      for (const comment of comments) lines.push(`• ${comment.author_name ? `${fenceUntrustedInline(comment.author_name, 'comment author')}: ` : ''}${fenceUntrusted(comment.comment ?? '', 'submission comment')}`);
    }
    return lines.join('\n');
  },
});
