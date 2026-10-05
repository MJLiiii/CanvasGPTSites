// Ports the simple caller-scoped reads in canvas_mcp/tools/student_tools.py.
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { formatDate, parseDate } from '../core/dates';
import { fenceUntrustedInline } from '../core/untrusted-content';
import { defineTool } from '../mcp/define-tool';
import { READ_ONLY, field, oneDecimal, record, records } from './read-helpers';

export const getMyCourseGrades = defineTool({
  name: 'get_my_course_grades', title: 'Get my course grades', module: 'student_tools', role: 'student', effect: 'read', canvasScope: 'aggregate',
  description: 'Get your current grades across all enrolled courses.',
  params: {}, annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (_args, ctx) => {
    const courses = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/courses`, {
      enrollment_state: 'active', 'include[]': ['total_scores', 'current_grading_period_scores'], per_page: 100,
    }, { label: 'courses' });
    if (isFailure(courses)) return `Error fetching courses: ${courses.error}`;
    const notice = ctx.canvas.disclose(courses);
    if (!courses.items.length) return 'No active course enrollments found.' + notice;
    const lines = ['Your Course Grades:\n'];
    for (const course of courses.items) {
      const enrollments = records(course.enrollments);
      let grade = 'No enrollment data';
      if (enrollments.length) {
        const first = enrollments[0]!;
        grade = typeof first.computed_current_score === 'number'
          ? `${field(first, 'computed_current_grade')} (${oneDecimal(first.computed_current_score)}%)`
          : typeof first.computed_final_score === 'number' ? `${oneDecimal(first.computed_final_score)}%` : 'No grade yet';
      }
      lines.push(`• ${field(course, 'course_code', '')}: ${field(course, 'name', 'Unnamed Course')}\n  Current Grade: ${grade}\n`);
    }
    return lines.join('\n') + notice;
  },
});

export const getMyTodoItems = defineTool({
  name: 'get_my_todo_items', title: 'Get my TODO items', module: 'student_tools', role: 'student', effect: 'read', canvasScope: 'aggregate',
  description: 'Get your Canvas TODO list.', params: {}, annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (_args, ctx) => {
    const todos = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/users/self/todo`, { per_page: 100 }, { label: 'TODO items' });
    if (isFailure(todos)) return `Error fetching TODO items: ${todos.error}`;
    const notice = ctx.canvas.disclose(todos);
    if (!todos.items.length) return 'Your TODO list is empty! 🎉' + notice;
    const lines = ['Your TODO List:\n'];
    for (const item of todos.items) {
      const assignment = record(item.assignment);
      const name = assignment.name || (Object.hasOwn(item, 'title') ? item.title : 'Unnamed item');
      const due = assignment.due_at ? formatDate(String(assignment.due_at), ctx.config.timezone) : 'No due date';
      const display = item.course_id ? await ctx.canvas.courses.resolveCode(String(item.course_id)) : 'Unknown Course';
      const type = field(item, 'type', 'item').toLowerCase().replace(/(^|[^\p{L}])\p{L}/gu, (part) => part.toUpperCase());
      lines.push(`• ${fenceUntrustedInline(name, 'assignment or item title')}\n  Type: ${type}\n  Course: ${display}\n  Due: ${due}\n`);
    }
    return lines.join('\n') + notice;
  },
});

export const getMyUpcomingAssignments = defineTool({
  name: 'get_my_upcoming_assignments', title: 'Get my upcoming assignments', module: 'student_tools', role: 'student', effect: 'read', canvasScope: 'aggregate',
  description: `Get your upcoming assignments across all courses.

Args:
    days: Number of days to look ahead (default: 7)`,
  params: { days: { kind: 'int', default: 7, description: 'Number of days to look ahead (default: 7)' } },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (args, ctx) => {
    if (args.days < 1) return 'Error: days must be at least 1.';
    const start = new Date();
    const end = new Date(start.getTime() + args.days * 86_400_000);
    if (!Number.isFinite(end.getTime())) return 'Error: days is outside the supported date range.';
    const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const items = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/planner/items`, {
      start_date: iso(start), end_date: iso(end), per_page: 100,
    }, { label: 'planner items' });
    if (isFailure(items)) return `Error fetching upcoming assignments: ${items.error}`;
    const notice = ctx.canvas.disclose(items);
    const assignments: Array<{ name: unknown; due: string; time: number; course: unknown; submitted: boolean }> = [];
    for (const item of items.items) {
      const plannable = record(item.plannable);
      let due: unknown;
      if (item.plannable_type === 'assignment' || item.plannable_type === 'quiz') due = plannable.due_at || item.plannable_date;
      else if (item.plannable_type === 'discussion_topic') due = plannable.due_at;
      else continue;
      if (typeof due !== 'string') continue;
      const date = parseDate(due);
      if (date === null || date.getTime() > end.getTime()) continue;
      assignments.push({ name: Object.hasOwn(plannable, 'title') ? plannable.title : 'Unnamed Assignment',
        due, time: date.getTime(), course: item.course_id, submitted: Boolean(record(item.submissions).submitted) });
    }
    if (!assignments.length) return `No assignments due in the next ${args.days} days.` + notice;
    assignments.sort((a, b) => a.time - b.time);
    const lines = [`Upcoming Assignments (Next ${args.days} Days):\n`];
    for (const assignment of assignments) {
      const display = assignment.course ? await ctx.canvas.courses.resolveCode(String(assignment.course)) : 'Unknown Course';
      lines.push(`• ${fenceUntrustedInline(assignment.name, 'assignment title')}\n  Course: ${display}\n  Due: ${formatDate(assignment.due, ctx.config.timezone)}\n  Status: ${assignment.submitted ? '✅ Submitted' : '❌ Not Submitted'}\n`);
    }
    return lines.join('\n') + notice;
  },
});
