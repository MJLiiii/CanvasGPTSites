// Ports canvas_mcp/core/cache.py (get_course_id, get_course_code, refresh_course_cache)
// without process-global state: one memo per client instance, loaded at most once.
import type { BudgetView, CanvasPath, CourseResolver, PageOptions, Paged, Params, RequestFailure } from '../types';
import { isFailure, notDispatched } from './errors';
import { canvasPath } from './path';

/** Identifier prefixes Canvas resolves itself; the value is passed through and encoded by `canvasPath`. */
export const COURSE_ID_PREFIXES: readonly string[] = [
  'sis_course_id:',
  'sis_integration_id:',
  'lti_context_id:',
  'uuid:',
];

/** The course list is read with per_page=100, so this covers 500 courses. */
export const COURSE_LIST_MAX_PAGES = 5;

const NUMERIC_ID = /^[0-9]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_ECHOED_IDENTIFIER = 100;

/** The part of the Canvas client the resolver needs. Calls made through it are metered like any other. */
export interface CourseResolverClient {
  fetchAll(path: CanvasPath, params?: Params, options?: PageOptions): Promise<Paged<unknown> | RequestFailure>;
  request(method: 'get', path: CanvasPath): Promise<unknown>;
  readonly budget: Pick<BudgetView, 'remaining'>;
}

export interface SeedableCourseResolver extends CourseResolver {
  /**
   * Add course objects the client has already fetched (`/courses`,
   * `/courses/{id}`) to the memo. It only adds entries: a filtered listing is
   * not proof that the whole course list is known.
   */
  seedCourses(courses: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(identifier: string): RequestFailure {
  const shown = identifier.replace(CONTROL_CHARACTERS, '').slice(0, MAX_ECHOED_IDENTIFIER);
  return notDispatched(`Course '${shown}' not found. Use list_courses to get the course ID.`);
}

export function createCourseResolver(client: CourseResolverClient): SeedableCourseResolver {
  const codeToId = new Map<string, string>();
  const idToCode = new Map<string, string>();
  const idLookups = new Map<string, Promise<string>>();
  let listLoad: Promise<RequestFailure | null> | null = null;

  function seedCourses(courses: unknown): void {
    const list = Array.isArray(courses) ? courses : [courses];
    for (const course of list) {
      if (!isRecord(course)) continue;
      const id = course.id;
      const code = course.course_code;
      if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') continue;
      if (typeof code !== 'string' || code === '') continue;
      codeToId.set(code, String(id));
      idToCode.set(String(id), code);
    }
  }

  /** Loads the caller's course list once; a failed load is not repeated either. */
  function loadCourseList(): Promise<RequestFailure | null> {
    listLoad ??= (async (): Promise<RequestFailure | null> => {
      try {
        const page = await client.fetchAll(
          canvasPath`/courses`,
          { per_page: 100 },
          { maxPages: COURSE_LIST_MAX_PAGES, label: 'courses' },
        );
        if (isFailure(page)) return page;
        seedCourses(page.items);
        return null;
      } catch {
        return notDispatched('The course list could not be loaded.');
      }
    })();
    return listLoad;
  }

  async function lookUpCode(id: string): Promise<string> {
    const response = await client.request('get', canvasPath`/courses/${id}`);
    if (isFailure(response) || !isRecord(response)) return id;
    const code = response.course_code;
    if (typeof code !== 'string' || code === '') return id;
    idToCode.set(id, code);
    codeToId.set(code, id);
    return code;
  }

  return {
    seedCourses,

    async resolveId(identifier: string | number): Promise<string | RequestFailure> {
      const value = String(identifier).trim();
      if (NUMERIC_ID.test(value)) return value;

      const prefix = COURSE_ID_PREFIXES.find((candidate) => value.startsWith(candidate));
      if (prefix !== undefined) {
        const rest = value.slice(prefix.length);
        if (rest === '' || CONTROL_CHARACTER.test(rest)) {
          return notDispatched(
            `Invalid course identifier: '${prefix}' must be followed by a value with no control characters.`,
          );
        }
        // Returned undecoded: canvasPath percent-encodes it, '/' and ':' included.
        return value;
      }

      if (value === '' || CONTROL_CHARACTER.test(value)) return notFound(value);

      const known = codeToId.get(value);
      if (known !== undefined) return known;

      const loadFailure = await loadCourseList();
      const loaded = codeToId.get(value);
      if (loaded !== undefined) return loaded;

      // Upstream fallback: a code-like value that is not one of the caller's
      // course codes is tried as a SIS id.
      if (value.includes('_')) return `sis_course_id:${value}`;

      if (loadFailure !== null) {
        // "Not found" would be a guess when the list was never read. Nothing
        // was written either way, so the outcome is a plain refusal.
        const { status, throttled, budgetExhausted } = loadFailure;
        return notDispatched(loadFailure.error, { status, throttled, budgetExhausted });
      }
      return notFound(value);
    },

    async resolveCode(courseId: string | number): Promise<string> {
      const id = String(courseId).trim();
      try {
        // Already a code-like string with underscores.
        if (id.includes('_')) return id;

        const known = idToCode.get(id);
        if (known !== undefined) return known;

        await loadCourseList();
        const loaded = idToCode.get(id);
        if (loaded !== undefined) return loaded;

        // Tools ask for the same course once per listed item; one lookup serves them all.
        let lookup = idLookups.get(id);
        if (lookup === undefined) {
          if (client.budget.remaining < 1) return id;
          lookup = lookUpCode(id).catch(() => id);
          idLookups.set(id, lookup);
        }
        return await lookup;
      } catch {
        return id;
      }
    },
  };
}
