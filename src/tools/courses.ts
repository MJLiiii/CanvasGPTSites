// Ports the first three read tools in canvas_mcp/tools/courses.py.
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { formatDate } from '../core/dates';
import { sha256Hex } from '../core/hash';
import { stripHtmlTags } from '../core/html';
import { fenceUntrusted } from '../core/untrusted-content';
import { defineTool } from '../mcp/define-tool';
import type { Params } from '../types';
import { COURSE_IDENTIFIER, READ_ONLY, capCharacters, field, ownRoles, record } from './read-helpers';

export const listCourses = defineTool({
  name: 'list_courses', title: 'List courses', module: 'courses', role: 'shared', effect: 'read', canvasScope: 'aggregate',
  description: `List courses for the authenticated user.

Args:
    include_concluded: Include concluded/past enrollments in the results.
    include_all: Include all enrollments instead of only current active ones.`,
  params: {
    include_concluded: { kind: 'bool', default: false, description: 'Include concluded/past enrollments in the results.' },
    include_all: { kind: 'bool', default: false, description: 'Include all enrollments instead of only current active ones.' },
  },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (args, ctx) => {
    const params: Params = { 'include[]': ['term', 'teachers', 'total_students'], per_page: 100,
      'state[]': args.include_concluded ? ['available', 'completed'] : ['available'] };
    if (!args.include_all) {
      params.enrollment_state = 'active';
      if (ctx.config.role === 'educator') params.enrollment_type = 'teacher';
    }
    const courses = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/courses`, params, { label: 'courses' });
    if (isFailure(courses)) return `Error fetching courses: ${courses.error}`;
    const notice = ctx.canvas.disclose(courses);
    if (courses.items.length === 0) return 'No courses found.' + notice;
    return 'Courses:\n\n' + courses.items.map((course) => {
      const roles = ownRoles(course);
      return `Code: ${field(course, 'course_code', 'No code')}\nName: ${field(course, 'name', 'Unnamed course')}\nID: ${field(course, 'id', null)}\n${roles.length ? `Your role: ${roles.join(', ')}\n` : ''}`;
    }).join('\n') + notice;
  },
});

export const getCourseDetails = defineTool({
  name: 'get_course_details', title: 'Get course details', module: 'courses', role: 'shared', effect: 'read', canvasScope: 'single',
  description: `Get detailed information about a specific course.

Args:
    course_identifier: Course code or Canvas ID`,
  params: { course_identifier: COURSE_IDENTIFIER }, annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (args, ctx) => {
    const id = await ctx.canvas.courses.resolveId(args.course_identifier);
    if (isFailure(id)) return `Error fetching course details: ${id.error}`;
    const response = await ctx.canvas.request('get', canvasPath`/courses/${id}`);
    if (isFailure(response)) return `Error fetching course details: ${response.error}`;
    const course = record(response);
    const roles = ownRoles(course);
    const details = [
      `Code: ${field(course, 'course_code')}`, `Name: ${field(course, 'name')}`,
      `Start Date: ${formatDate(course.start_at as string | null, ctx.config.timezone)}`,
      `End Date: ${formatDate(course.end_at as string | null, ctx.config.timezone)}`,
      `Time Zone: ${field(course, 'time_zone')}`, `Default View: ${field(course, 'default_view')}`,
      `Public: ${field(course, 'is_public', false)}`, `Blueprint: ${field(course, 'blueprint', false)}`,
      roles.length ? `Your role: ${roles.join(', ')}` : 'Your role: You have no enrollment in this course',
    ];
    return `Course Details for ${field(course, 'course_code', args.course_identifier)}:\n\n` + details.join('\n');
  },
});

export const getSyllabus = defineTool({
  name: 'get_syllabus', title: 'Get syllabus', module: 'courses', role: 'shared', effect: 'read', canvasScope: 'single',
  description: `Get the complete Canvas Syllabus tab content for a course, untruncated.

Unlike get_course_content_overview (which returns only a ~1000-char
preview), this returns the full syllabus body so later sections such as
grading policies, weighting, and final-exam details remain accessible.

Args:
    course_identifier: Course code or Canvas ID
    output_format: "text" (plain text, default), "html" (raw HTML body),
        or "both" (plain text followed by raw HTML)
    max_chars: Optional positive cap on the returned characters per
        section. When exceeded, the content is truncated with an explicit
        "[truncated...]" marker. Defaults to None (no truncation).`,
  params: {
    course_identifier: COURSE_IDENTIFIER,
    output_format: { kind: 'string', default: 'text', description: '"text" (plain text, default), "html" (raw HTML body), or "both" (plain text followed by raw HTML)' },
    max_chars: { kind: 'int', optional: true, description: 'Optional positive cap on the returned characters per section.' },
  },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'fenced',
  handler: async (args, ctx) => {
    const format = (args.output_format || 'text').toLowerCase();
    if (!['text', 'html', 'both'].includes(format)) return `Error: invalid output_format '${args.output_format}'. Use 'text', 'html', or 'both'.`;
    if (args.max_chars !== undefined && args.max_chars <= 0) return 'Error: max_chars must be a positive integer (or omitted for no limit).';
    const id = await ctx.canvas.courses.resolveId(args.course_identifier);
    if (isFailure(id)) return `Error fetching syllabus: ${id.error}`;
    const response = await ctx.canvas.request('get', canvasPath`/courses/${id}`, { params: { 'include[]': 'syllabus_body' } });
    if (isFailure(response)) return `Error fetching syllabus: ${response.error}`;
    const course = record(response);
    const display = field(course, 'course_code', args.course_identifier);
    const body = typeof course.syllabus_body === 'string' ? course.syllabus_body : '';
    if (!body.trim()) return `No syllabus content found for course ${display}.`;
    const sections = [`Syllabus for Course ${display}:\nBody SHA-256 (pass as expect_body_sha256 to update_syllabus): ${sha256Hex(body)}`];
    if (format === 'text' || format === 'both') sections.push((format === 'both' ? '\n--- Plain Text ---\n' : '\n') + fenceUntrusted(capCharacters(stripHtmlTags(body), args.max_chars), 'course syllabus'));
    if (format === 'html' || format === 'both') sections.push((format === 'both' ? '\n--- Raw HTML ---\n' : '\n') + fenceUntrusted(capCharacters(body, args.max_chars), 'course syllabus'));
    return sections.join('\n');
  },
});
