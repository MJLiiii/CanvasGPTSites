import { describe, expect, it } from 'vitest';
import { TOOL_EFFECTS } from '../../src/core/tool-policy';
import { parseConfig } from '../../src/env';
import { defineTool } from '../../src/mcp/define-tool';
import { computeToolSet, summarize } from '../../src/mcp/registry';
import { ALL_TOOLS } from '../../src/tools/index';
import type { Config, Effect, Env, ToolDef, ToolGate, ToolRole } from '../../src/types';

const BASE_ENV: Env = {
  CANVAS_API_URL: 'https://canvas.example.edu',
  CANVAS_API_TOKEN: `7~${'t'.repeat(40)}`,
  OWNER_EMAIL: 'owner@example.edu',
};

function config(extra: Env = {}): Config {
  return parseConfig({ ...BASE_ENV, ...extra });
}

interface ToolOptions {
  role?: ToolRole;
  effect?: Effect;
  gate?: ToolGate;
  budget?: ToolDef['budget'];
}

function rawTool(name: string, options: ToolOptions = {}): ToolDef {
  const effect = options.effect ?? 'read';
  const readOnly = effect === 'read';
  return {
    name,
    title: name,
    description: `${name} description`,
    module: 'test',
    role: options.role ?? 'shared',
    effect,
    ...(options.gate !== undefined && { gate: options.gate }),
    params: {},
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
    budget: options.budget ?? { tier: 'S' },
    fencing: 'safe',
    handler: async () => 'ok',
  };
}

function tool(name: string, options: ToolOptions = {}): ToolDef {
  return defineTool(rawTool(name, options));
}

const SECRET = 'c'.repeat(32);

const listCourses = tool('list_courses');
const myGrades = tool('get_my_course_grades', { role: 'student' });
const listSubmissions = tool('list_submissions', { role: 'educator' });
const createAnnouncement = tool('create_announcement', { role: 'educator', effect: 'canvas_write' });
const submitAssignment = tool('submit_assignment', {
  role: 'student',
  effect: 'canvas_write',
  gate: { studentWrite: true },
});
const ufixitReport = tool('fetch_ufixit_report', { role: 'educator', gate: { accessibilityChecker: 'ufixit' } });
const deletePage = tool('delete_page', {
  role: 'educator',
  effect: 'canvas_write',
  gate: { needsD1: true, needsConfirmSecret: true },
});
const downloadFile = tool('download_course_file', { effect: 'local_write', gate: { needsR2: true } });
const peerReport = tool('generate_peer_review_report', { role: 'educator' });
const helloTool = tool('hello', { gate: { diagnostics: true } });

const CATALOG: ReadonlyArray<ToolDef> = [
  listCourses,
  myGrades,
  listSubmissions,
  createAnnouncement,
  submitAssignment,
  ufixitReport,
  deletePage,
  downloadFile,
  peerReport,
  helloTool,
];

const ALL_FEATURES = { hasD1: true, hasR2: true };
const NO_FEATURES = { hasD1: false, hasR2: false };

function names(all: ReadonlyArray<ToolDef>, cfg: Config, features = ALL_FEATURES): string[] {
  return computeToolSet(all, cfg, features).tools.map((def) => def.name);
}

function reasonFor(name: string, all: ReadonlyArray<ToolDef>, cfg: Config, features = ALL_FEATURES): string | undefined {
  return computeToolSet(all, cfg, features).skipped.find((entry) => entry.name === name)?.reason;
}

describe('computeToolSet', () => {
  it('uses a clean base configuration', () => {
    expect(config().errors).toEqual([]);
  });

  it('by default offers the shared and student reads only', () => {
    expect(names(CATALOG, config())).toEqual(['list_courses', 'get_my_course_grades']);
  });

  it('accounts for every tool exactly once, as registered or skipped', () => {
    const set = computeToolSet(CATALOG, config(), ALL_FEATURES);
    const accounted = [...set.tools.map((def) => def.name), ...set.skipped.map((entry) => entry.name)].sort();
    expect(accounted).toEqual(CATALOG.map((def) => def.name).sort());
    for (const entry of set.skipped) expect(entry.reason).not.toBe('');
  });

  describe('role gate', () => {
    it('educator role drops student tools and adds educator reads', () => {
      expect(names(CATALOG, config({ CANVAS_ROLE: 'educator' }))).toEqual([
        'list_courses',
        'list_submissions',
        'fetch_ufixit_report',
        'generate_peer_review_report',
      ]);
    });

    it('role all offers both', () => {
      expect(names(CATALOG, config({ CANVAS_ROLE: 'all' }))).toEqual([
        'list_courses',
        'get_my_course_grades',
        'list_submissions',
        'fetch_ufixit_report',
        'generate_peer_review_report',
      ]);
    });

    it('says why an educator tool is missing for a student', () => {
      expect(reasonFor('list_submissions', CATALOG, config())).toBe(
        'educator tools need CANVAS_ROLE=educator or all; it is student',
      );
    });
  });

  describe('student writes', () => {
    it('need both STUDENT_WRITE_TOOLS and the write allowlist', () => {
      expect(names(CATALOG, config({ ALLOWED_WRITE_TOOLS: 'submit_assignment' }))).not.toContain('submit_assignment');
      expect(names(CATALOG, config({ STUDENT_WRITE_TOOLS: 'submit_assignment' }))).not.toContain('submit_assignment');
      expect(
        names(CATALOG, config({ STUDENT_WRITE_TOOLS: 'submit_assignment', ALLOWED_WRITE_TOOLS: 'submit_assignment' })),
      ).toContain('submit_assignment');
    });

    it('are not opened by ALLOWED_WRITE_TOOLS=all alone', () => {
      expect(names(CATALOG, config({ ALLOWED_WRITE_TOOLS: 'all' }))).not.toContain('submit_assignment');
      expect(reasonFor('submit_assignment', CATALOG, config({ ALLOWED_WRITE_TOOLS: 'all' }))).toBe(
        'not listed in STUDENT_WRITE_TOOLS',
      );
    });
  });

  describe('accessibility checkers', () => {
    it('ufixit tools exist by default for educators', () => {
      expect(names(CATALOG, config({ CANVAS_ROLE: 'educator' }))).toContain('fetch_ufixit_report');
    });

    it('ACCESSIBILITY_CHECKERS=none removes them', () => {
      const cfg = config({ CANVAS_ROLE: 'educator', ACCESSIBILITY_CHECKERS: 'none' });
      expect(names(CATALOG, cfg)).not.toContain('fetch_ufixit_report');
      expect(reasonFor('fetch_ufixit_report', CATALOG, cfg)).toMatch(/ACCESSIBILITY_CHECKERS/);
    });
  });

  describe('feature gates', () => {
    const educatorAll = { CANVAS_ROLE: 'educator', ALLOWED_WRITE_TOOLS: 'all' };

    it('registers a guarded tool only with D1 and the confirmation secret', () => {
      expect(names(CATALOG, config({ ...educatorAll, CONFIRMATION_SECRET: SECRET }))).toContain('delete_page');
      expect(reasonFor('delete_page', CATALOG, config({ ...educatorAll, CONFIRMATION_SECRET: SECRET }), NO_FEATURES)).toBe(
        'needs the D1 database binding',
      );
      expect(reasonFor('delete_page', CATALOG, config(educatorAll))).toBe('needs CONFIRMATION_SECRET');
    });

    it('treats a confirmation secret that is too short as missing', () => {
      expect(names(CATALOG, config({ ...educatorAll, CONFIRMATION_SECRET: 'short' }))).not.toContain('delete_page');
    });

    it('registers an R2 tool only with the bucket binding', () => {
      expect(names(CATALOG, config(educatorAll))).toContain('download_course_file');
      expect(reasonFor('download_course_file', CATALOG, config(educatorAll), NO_FEATURES)).toBe(
        'needs the R2 bucket binding',
      );
    });
  });

  describe('budget', () => {
    it('skips a tool whose declared request minimum exceeds the budget', () => {
      const hungry = tool('get_course_structure', { budget: { tier: 'L', requests: 30 } });
      expect(names([hungry], config())).toEqual(['get_course_structure']);
      const cfg = config({ CANVAS_REQUEST_BUDGET: '10' });
      expect(names([hungry], cfg)).toEqual([]);
      expect(reasonFor('get_course_structure', [hungry], cfg)).toBe(
        'needs 30 requests per call; CANVAS_REQUEST_BUDGET allows 10',
      );
    });

    it('keeps a tool whose tier limit is above the budget: it runs with less', () => {
      const large = tool('get_course_structure', { budget: { tier: 'L' } });
      expect(names([large], config({ CANVAS_REQUEST_BUDGET: '10' }))).toEqual(['get_course_structure']);
    });
  });

  describe('DISABLED_TOOLS', () => {
    it('removes a tool of any effect', () => {
      const cfg = config({ CANVAS_ROLE: 'all', ALLOWED_WRITE_TOOLS: 'all', DISABLED_TOOLS: 'list_courses, create_announcement' });
      const offered = names(CATALOG, cfg);
      expect(offered).not.toContain('list_courses');
      expect(offered).not.toContain('create_announcement');
      expect(offered).toContain('list_submissions');
      expect(reasonFor('list_courses', CATALOG, cfg)).toBe('listed in DISABLED_TOOLS');
    });
  });

  describe('write policy', () => {
    const educator = { CANVAS_ROLE: 'educator' };

    it('is read-only when ALLOWED_WRITE_TOOLS is unset, empty or none', () => {
      for (const value of [undefined, '', ' , ', 'none']) {
        const cfg = config(value === undefined ? educator : { ...educator, ALLOWED_WRITE_TOOLS: value });
        expect(names(CATALOG, cfg)).not.toContain('create_announcement');
        expect(names(CATALOG, cfg)).not.toContain('download_course_file');
      }
      expect(reasonFor('create_announcement', CATALOG, config(educator))).toBe('not allowed by ALLOWED_WRITE_TOOLS');
    });

    it('registers exactly the named writes', () => {
      const offered = names(CATALOG, config({ ...educator, ALLOWED_WRITE_TOOLS: 'create_announcement' }));
      expect(offered).toContain('create_announcement');
      expect(offered).not.toContain('download_course_file');
    });

    it('all registers Canvas writes and local writes', () => {
      const offered = names(CATALOG, config({ ...educator, ALLOWED_WRITE_TOOLS: 'all' }));
      expect(offered).toContain('create_announcement');
      expect(offered).toContain('download_course_file');
    });

    it('an unreadable allowlist registers no write at all', () => {
      const cfg = config({ ...educator, ALLOWED_WRITE_TOOLS: 'create_announcement, not_a_tool' });
      expect(cfg.errors.map((error) => error.code)).toContain('allowed_write_tools_invalid');
      const offered = names(CATALOG, cfg);
      expect(offered).not.toContain('create_announcement');
      expect(offered).toContain('list_submissions');
    });

    it('registers generate_peer_review_report as a read, without the allowlist', () => {
      expect(names(CATALOG, config(educator))).toContain('generate_peer_review_report');
    });

    it('never registers a tool that is missing from the policy table', () => {
      const unknown = tool('made_up_tool');
      expect(Object.hasOwn(TOOL_EFFECTS, 'made_up_tool')).toBe(false);
      for (const cfg of [config(), config({ CANVAS_ROLE: 'all', ALLOWED_WRITE_TOOLS: 'all' })]) {
        expect(names([unknown], cfg)).toEqual([]);
        expect(reasonFor('made_up_tool', [unknown], cfg)).toBe('not classified in the tool policy table');
      }
    });

    it('does not trust a write that declares itself a read', () => {
      // defineTool refuses this definition; a hand-built one must still not get past the registry.
      const disguised = rawTool('create_announcement', { role: 'shared', effect: 'read' });
      expect(names([disguised], config())).toEqual([]);
      expect(names([disguised], config({ ALLOWED_WRITE_TOOLS: 'create_announcement' }))).toEqual(['create_announcement']);
    });

    it('never registers code execution, even when a hand-built definition asks for it', () => {
      const exec = rawTool('execute_typescript', { effect: 'code_exec' });
      expect(names([exec], config({ ALLOWED_WRITE_TOOLS: 'all' }))).toEqual([]);
    });
  });

  describe('diagnostics mode', () => {
    const diagnosticsEnv: Env = { DIAGNOSTICS_ENABLED: 'true' };

    it('registers no diagnostics tool outside diagnostics mode', () => {
      for (const cfg of [config(), config({ CANVAS_ROLE: 'all', ALLOWED_WRITE_TOOLS: 'all' })]) {
        expect(names(CATALOG, cfg)).not.toContain('hello');
        expect(reasonFor('hello', CATALOG, cfg)).toBe('diagnostics tools need DIAGNOSTICS_ENABLED');
      }
    });

    it('registers only diagnostics tools in diagnostics mode', () => {
      const cfg = parseConfig(diagnosticsEnv);
      expect(cfg.diagnosticsEnabled).toBe(true);
      expect(names(CATALOG, cfg)).toEqual(['hello']);
      expect(reasonFor('list_courses', CATALOG, cfg)).toMatch(/diagnostics mode is on/);
    });

    it('still honours DISABLED_TOOLS in diagnostics mode', () => {
      const cfg = parseConfig({ ...diagnosticsEnv, DISABLED_TOOLS: 'hello' });
      expect(names(CATALOG, cfg)).toEqual([]);
    });

    it('refuses a diagnostics tool that is not a read', () => {
      const writer = rawTool('probe_writer', { effect: 'canvas_write', gate: { diagnostics: true } });
      expect(names([writer], parseConfig(diagnosticsEnv))).toEqual([]);
    });

    it('offers only the two spike tools in diagnostics, and business reads without the switch', () => {
      expect(names(ALL_TOOLS, parseConfig(diagnosticsEnv), NO_FEATURES)).toEqual(['hello', 'sites_diagnostics']);
      const normal = names(ALL_TOOLS, config(), ALL_FEATURES);
      expect(normal).toContain('list_courses');
      expect(normal).toContain('get_my_submission');
      expect(normal).not.toContain('hello');
      expect(normal).not.toContain('sites_diagnostics');
    });
  });

  describe('order and duplicates', () => {
    it('keeps the order of the input list', () => {
      const cfg = config({ CANVAS_ROLE: 'all' });
      const reversed = [...CATALOG].reverse();
      expect(names(reversed, cfg)).toEqual([...names(CATALOG, cfg)].reverse());
    });

    it('registers a duplicated name once', () => {
      const set = computeToolSet([listCourses, tool('list_courses')], config(), ALL_FEATURES);
      expect(set.tools).toEqual([listCourses]);
      expect(set.skipped).toEqual([{ name: 'list_courses', reason: 'duplicate tool name' }]);
    });

    it('is pure: the same inputs give the same result and the inputs are left alone', () => {
      const cfg = config({ CANVAS_ROLE: 'all', ALLOWED_WRITE_TOOLS: 'all' });
      const before = JSON.stringify(cfg);
      expect(computeToolSet(CATALOG, cfg, ALL_FEATURES)).toEqual(computeToolSet(CATALOG, cfg, ALL_FEATURES));
      expect(JSON.stringify(cfg)).toBe(before);
    });
  });
});

describe('summarize', () => {
  it('lists registered tools in order without handlers, params or gates', () => {
    expect(summarize([listCourses, deletePage])).toEqual([
      { name: 'list_courses', title: 'list_courses', description: 'list_courses description', module: 'test', role: 'shared', effect: 'read' },
      { name: 'delete_page', title: 'delete_page', description: 'delete_page description', module: 'test', role: 'educator', effect: 'canvas_write' },
    ]);
  });
});
