// Ports canvas-mcp tests/security/test_tool_policy.py (the classification and the allowlist resolver).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_KEYWORD_TOOLS,
  READ_EFFECT_OVERRIDES,
  SIDE_EFFECT_TOOLS,
  TOOL_EFFECTS,
  describeEntries,
  isToolAllowed,
  registeredEffect,
  resolveToolPolicy,
  splitEntries,
} from '../../src/core/tool-policy';
import type { Effect } from '../../src/types';

const ALL_NAMES = Object.keys(TOOL_EFFECTS);
const READ = new Set(ALL_NAMES.filter((name) => TOOL_EFFECTS[name] === 'read'));
const SIDE_EFFECT = new Set(ALL_NAMES.filter((name) => TOOL_EFFECTS[name] !== 'read'));
// The global URL type here is the Workers one, so the path helper is given the href string.
const MANIFEST = fileURLToPath(new URL('../../.upstream/canvas-mcp/tools/TOOL_MANIFEST.json', import.meta.url).href);

function allowed(raw: string | null): ReadonlySet<string> {
  const result = resolveToolPolicy(raw);
  if (!result.ok) throw new Error(`expected a policy, got: ${result.error}`);
  return result.allowedWrites;
}

function refusal(raw: string): string {
  const result = resolveToolPolicy(raw);
  if (result.ok) throw new Error('expected the allowlist to be refused');
  return result.error;
}

describe('the classification itself', () => {
  it('classifies all 104 upstream tools', () => {
    expect(ALL_NAMES).toHaveLength(104);
    expect(new Set(ALL_NAMES).size).toBe(104);
  });

  it.runIf(existsSync(MANIFEST))('names exactly the tools in the upstream manifest', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tools: Array<{ name: string }> };
    const manifestNames = manifest.tools.map((tool) => tool.name);
    expect(manifestNames.length).toBeGreaterThan(0);
    const unclassified = manifestNames.filter((name) => !Object.hasOwn(TOOL_EFFECTS, name));
    const stale = ALL_NAMES.filter((name) => !manifestNames.includes(name));
    expect(unclassified, 'classify these in core/tool-policy.ts').toEqual([]);
    expect(stale, 'TOOL_EFFECTS names tools that no longer exist').toEqual([]);
  });

  it('has the upstream number of tools in each class', () => {
    const count = (effect: Effect): number => ALL_NAMES.filter((name) => TOOL_EFFECTS[name] === effect).length;
    expect(count('read')).toBe(58);
    expect(count('canvas_write')).toBe(41);
    expect(count('local_write')).toBe(4);
    expect(count('code_exec')).toBe(1);
  });

  it('keeps code execution in its own class', () => {
    expect(TOOL_EFFECTS.execute_typescript).toBe('code_exec');
  });

  it('classifies download_course_file as a local write', () => {
    expect(TOOL_EFFECTS.download_course_file).toBe('local_write');
  });

  it('cannot be extended or edited at runtime', () => {
    expect(Object.isFrozen(TOOL_EFFECTS)).toBe(true);
    expect(() => {
      (TOOL_EFFECTS as Record<string, Effect>).brand_new_tool = 'read';
    }).toThrow();
    expect(() => {
      (TOOL_EFFECTS as Record<string, Effect>).send_conversation = 'read';
    }).toThrow();
  });

  it('has no inherited members that could pass for a classification', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(TOOL_EFFECTS[name]).toBeUndefined();
      expect(registeredEffect(name)).toBeUndefined();
    }
  });

  it('derives the side-effect and all-keyword sets from the table', () => {
    expect(new Set(SIDE_EFFECT_TOOLS)).toEqual(SIDE_EFFECT);
    const withoutCodeExec = new Set(SIDE_EFFECT);
    withoutCodeExec.delete('execute_typescript');
    expect(new Set(ALL_KEYWORD_TOOLS)).toEqual(withoutCodeExec);
  });
});

describe('resolving the setting', () => {
  it('allows no side-effect tools when the variable is unset', () => {
    expect(allowed(null).size).toBe(0);
  });

  it.each(['', '   ', ' , ', ',,,'])('treats a set-but-empty value %j as none', (raw) => {
    expect(allowed(raw).size).toBe(0);
  });

  it('reads the none keyword case-insensitively, and lets it repeat', () => {
    expect(allowed('none,NONE').size).toBe(0);
    expect(allowed('None').size).toBe(0);
  });

  it('denies every side-effect tool for none', () => {
    expect(allowed('none').size).toBe(0);
  });

  it('allows exactly the names listed', () => {
    expect(new Set(allowed('send_conversation, update_page_settings'))).toEqual(
      new Set(['send_conversation', 'update_page_settings']),
    );
    expect(new Set(allowed('send_conversation update_page_settings\ndelete_page'))).toEqual(
      new Set(['send_conversation', 'update_page_settings', 'delete_page']),
    );
  });

  it('expands all to every Canvas write and local write, never code execution', () => {
    const policy = allowed('all');
    expect(policy.has('execute_typescript')).toBe(false);
    const expected = new Set(SIDE_EFFECT);
    expected.delete('execute_typescript');
    expect(new Set(policy)).toEqual(expected);
    expect(new Set(allowed('ALL, all'))).toEqual(expected);
  });

  it('accepts a dropped tool that is named, without registering it', () => {
    // Upstream allowlists that name execute_typescript still parse; the tool can never be registered here.
    const policy = allowed('execute_typescript');
    expect(policy.has('execute_typescript')).toBe(true);
    expect(isToolAllowed('execute_typescript', 'code_exec', policy)).toBe(false);
    expect(isToolAllowed('execute_typescript', 'canvas_write', policy)).toBe(false);
    expect(isToolAllowed('execute_typescript', 'read', policy)).toBe(false);
  });

  it('refuses all combined with other entries (deviation: upstream allows all,execute_typescript)', () => {
    expect(refusal('all,execute_typescript')).toBe(
      "ALLOWED_WRITE_TOOLS: 'all' cannot be combined with other entries (got: all, execute_typescript)",
    );
    expect(refusal('send_conversation all')).toBe(
      "ALLOWED_WRITE_TOOLS: 'all' cannot be combined with other entries (got: all, send_conversation)",
    );
  });

  it.each([
    'send_convo', // typo: must not silently allow nothing or everything
    'none,send_conversation', // contradictory
    'list_courses', // a read tool: always available, naming it is a mistake
    'none,all',
    'all,send_convo',
    'constructor',
    '__proto__',
  ])('refuses the misconfiguration %j', (raw) => {
    expect(resolveToolPolicy(raw).ok).toBe(false);
  });

  it("uses upstream's wording for each refusal", () => {
    expect(refusal('send_convo, zzz_tool')).toBe('ALLOWED_WRITE_TOOLS names unknown tools: send_convo, zzz_tool');
    expect(refusal('send_conversation,none')).toBe(
      "ALLOWED_WRITE_TOOLS: 'none' cannot be combined with other entries (got: none, send_conversation)",
    );
    expect(refusal('list_courses, get_syllabus, send_conversation')).toBe(
      'ALLOWED_WRITE_TOOLS lists read-only tools, which are always available: ' +
        'get_syllabus, list_courses. List only tools that change something.',
    );
  });

  it('matches tool names case-sensitively', () => {
    expect(refusal('Send_Conversation')).toBe('ALLOWED_WRITE_TOOLS names unknown tools: Send_Conversation');
  });

  it('never echoes an entry longer than any tool name', () => {
    const pasted = `7~${'A1b2C3d4'.repeat(8)}`;
    const error = refusal(`send_conversation,${pasted}`);
    expect(error).not.toContain(pasted);
    expect(error).not.toContain(pasted.slice(0, 16));
    expect(error).toBe(`ALLOWED_WRITE_TOOLS names unknown tools: <${pasted.length} characters>`);
    expect(refusal(`none ${pasted}`)).not.toContain(pasted);
  });

  it('echoes an entry only when it is shaped like a name', () => {
    // A secret pasted into the variable is split on commas and whitespace; its pieces must not come back out.
    expect(refusal('send-convo, 7~abc, a.b, Send_Conversation, zzz_tool')).toBe(
      'ALLOWED_WRITE_TOOLS names unknown tools: <5 characters>, Send_Conversation, <3 characters>, <10 characters>, zzz_tool',
    );
    const error = refusal('none k3y+/= https://example.test/x?token=abc');
    expect(error).toBe(
      "ALLOWED_WRITE_TOOLS: 'none' cannot be combined with other entries (got: <32 characters>, <6 characters>, none)",
    );
    expect(describeEntries(['b_tool', 'a_tool', `x${'y'.repeat(64)}`, '__proto__', 'tool2'])).toBe(
      '__proto__, a_tool, b_tool, tool2, <65 characters>',
    );
  });

  it('splits a list on commas and whitespace', () => {
    expect(splitEntries(' a, b\tc\n,,d ')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitEntries(' , ')).toEqual([]);
  });
});

describe('applying it to a registry', () => {
  const surviving = (allowedWrites: ReadonlySet<string>): Set<string> =>
    new Set(ALL_NAMES.filter((name) => isToolAllowed(name, TOOL_EFFECTS[name] as Effect, allowedWrites)));

  it('leaves only read tools by default', () => {
    expect(surviving(allowed(null))).toEqual(READ);
  });

  it('adds exactly the allowlisted writes', () => {
    const expected = new Set(READ);
    expected.add('update_page_settings');
    expect(surviving(allowed('update_page_settings'))).toEqual(expected);
  });

  it('never registers code execution, even under all', () => {
    const expected = new Set(ALL_NAMES);
    expected.delete('execute_typescript');
    expect(surviving(allowed('all'))).toEqual(expected);
  });

  it('treats an unclassified tool as a side effect', () => {
    // Fail closed: a tool missing from TOOL_EFFECTS must not survive enforcement.
    expect(isToolAllowed('brand_new_tool', 'read', allowed(null))).toBe(false);
    expect(isToolAllowed('brand_new_tool', 'read', allowed('all'))).toBe(false);
    expect(isToolAllowed('brand_new_tool', 'read', new Set(['brand_new_tool']))).toBe(false);
    expect(isToolAllowed('constructor', 'read', allowed(null))).toBe(false);
  });

  it('does not trust a declared read effect on a classified writer', () => {
    // download_course_file once carried read_only_hint=True upstream while writing to disk.
    expect(isToolAllowed('download_course_file', 'read', allowed(null))).toBe(false);
    expect(isToolAllowed('send_conversation', 'read', allowed(null))).toBe(false);
    expect(isToolAllowed('send_conversation', 'read', allowed('send_conversation'))).toBe(true);
  });

  it('keeps a read that is declared as a write behind the allowlist, which can never name it', () => {
    expect(isToolAllowed('list_courses', 'canvas_write', allowed(null))).toBe(false);
    expect(isToolAllowed('list_courses', 'canvas_write', allowed('all'))).toBe(false);
  });

  it('registers generate_peer_review_report as a read while keeping its upstream class', () => {
    expect([...READ_EFFECT_OVERRIDES]).toEqual(['generate_peer_review_report']);
    expect(TOOL_EFFECTS.generate_peer_review_report).toBe('local_write');
    expect(registeredEffect('generate_peer_review_report')).toBe('read');
    expect(isToolAllowed('generate_peer_review_report', 'read', allowed(null))).toBe(true);
    // An upstream allowlist that names it still parses.
    expect(allowed('generate_peer_review_report').has('generate_peer_review_report')).toBe(true);
  });

  it('reports the registered effect of every other tool unchanged', () => {
    for (const name of ALL_NAMES) {
      if (READ_EFFECT_OVERRIDES.has(name)) continue;
      expect(registeredEffect(name)).toBe(TOOL_EFFECTS[name]);
    }
  });
});
