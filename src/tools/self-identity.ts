// Ports canvas_mcp/tools/self_identity.py: only the authenticated caller's own record and roles.
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { defineTool } from '../mcp/define-tool';
import type { Params } from '../types';
import { READ_ONLY, field, ownRoles, record } from './read-helpers';

export const getMyProfile = defineTool({
  name: 'get_my_profile', title: 'Get my profile', module: 'self_identity', role: 'shared', effect: 'read', canvasScope: 'aggregate',
  description: `Get YOUR own Canvas identity (user ID, name, login ID).

Answers "who am I?" — useful when a tool needs your Canvas user ID or
NetID. Reports only your own record, never anybody else's.`,
  params: {}, annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (_args, ctx) => {
    const response = await ctx.canvas.request('get', canvasPath`/users/self/profile`);
    if (isFailure(response)) return `Error fetching your profile: ${response.error}`;
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      return `Error fetching your profile: ${String(response)}`;
    }
    const profile = record(response);
    return `Your Canvas profile:\n\nUser ID: ${field(profile, 'id')}\nName: ${field(profile, 'name')}\nLogin ID: ${field(profile, 'login_id')}`;
  },
});

export const getMyEnrollments = defineTool({
  name: 'get_my_enrollments', title: 'Get my enrollments', module: 'self_identity', role: 'shared', effect: 'read', canvasScope: 'aggregate',
  description: `List the courses YOU are enrolled in, with your role in each.

Use this — not check_enrollment — for any question about your own
enrollment. check_enrollment reads the course roster, which requires
roster-admin rights your token probably does not have.

Args:
    include_concluded: Also include concluded/completed courses
        (default False = active courses only).`,
  params: { include_concluded: { kind: 'bool', default: false, description: 'Also include concluded/completed courses (default False = active courses only).' } },
  annotations: READ_ONLY, budget: { tier: 'S' }, fencing: 'safe',
  handler: async (args, ctx) => {
    const params: Params = { 'state[]': ['available', 'unpublished'], 'include[]': ['term'], per_page: 100 };
    if (args.include_concluded) params['state[]'] = ['available', 'unpublished', 'completed'];
    else params.enrollment_state = 'active';
    const courses = await ctx.canvas.fetchAll<Record<string, unknown>>(canvasPath`/courses`, params, { label: 'courses' });
    if (isFailure(courses)) return `Error fetching your enrollments: ${courses.error}`;
    const notice = ctx.canvas.disclose(courses);
    if (courses.items.length === 0) return `You have no${args.include_concluded ? '' : ' active'} course enrollments visible to this Canvas token.` + notice;
    const lines = courses.items.map((course) =>
      `Code: ${field(course, 'course_code', 'No code')}\nName: ${field(course, 'name', 'Unnamed course')}\nID: ${field(course, 'id', null)}\nYour role: ${ownRoles(course).join(', ') || 'no enrollment reported'}\n`);
    const footer = args.include_concluded ? '' : '\nScope: active enrollments in available or unpublished courses. Pass include_concluded=true to also list concluded courses.';
    return 'Your enrollments:\n\n' + lines.join('\n') + footer + notice;
  },
});
