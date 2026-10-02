// Replaces the register_*_tools calls in canvas-mcp src/canvas_mcp/server.py: one ordered list instead of
// registration side effects. The order here is the order of tools/list.
import type { ToolDef } from '../types';
import { hello, sitesDiagnostics } from './diagnostics';
import { getAssignmentDetails, listAssignments } from './assignments';
import { getCourseDetails, getSyllabus, listCourses } from './courses';
import { getMyEnrollments, getMyProfile } from './self-identity';
import { getMyCourseGrades, getMyTodoItems, getMyUpcomingAssignments } from './student-tools';
import { getMySubmission } from './student-write';

export const ALL_TOOLS: ReadonlyArray<ToolDef> = Object.freeze([
  hello, sitesDiagnostics, listCourses, getCourseDetails, getSyllabus,
  getMyProfile, getMyEnrollments, getMyCourseGrades, getMyTodoItems, getMyUpcomingAssignments,
  getMySubmission, listAssignments, getAssignmentDetails,
]);
