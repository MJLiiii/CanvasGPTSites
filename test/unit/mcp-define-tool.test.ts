import { describe, expect, it } from 'vitest';
import { buildInputSchema } from '../../src/core/validation';
import {
  BUDGET_TIER_LIMITS,
  RAW_ACCESS_TOOLS,
  READ_EFFECT_EXCEPTIONS,
  ToolDefinitionError,
  advertisedAnnotations,
  budgetLimit,
  defineTool,
  inputSchemaFor,
  toSummary,
} from '../../src/mcp/define-tool';
import type { ToolDef } from '../../src/types';

const READ_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_HINTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** A valid read tool; `overrides` replaces whole members. The cast lets a test pass deliberately wrong values. */
function readTool(overrides: Record<string, unknown> = {}): ToolDef {
  return {
    name: 'list_courses',
    title: 'List courses',
    description: 'List courses for the current user.',
    module: 'courses',
    role: 'shared',
    effect: 'read',
    params: {},
    annotations: { ...READ_HINTS },
    budget: { tier: 'S' },
    fencing: 'fenced',
    handler: async () => 'ok',
    ...overrides,
  } as ToolDef;
}

describe('defineTool', () => {
  it('returns the same definition, frozen', () => {
    const def = readTool();
    const defined = defineTool(def);
    expect(defined).toBe(def);
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.annotations)).toBe(true);
    expect(Object.isFrozen(defined.params)).toBe(true);
  });

  it.each(['Bad-Name', '1abc', '', 'has space', 'UPPER', '_leading', 'trailing-'])('rejects the name %j', (name) => {
    expect(() => defineTool(readTool({ name }))).toThrow(ToolDefinitionError);
  });

  it.each(['a', 'list_courses', 'get_my_todo_items', 'x1_y2'])('accepts the name %j', (name) => {
    // Names outside the policy table are only accepted as diagnostics-free reads here; the registry drops them.
    expect(() => defineTool(readTool({ name }))).not.toThrow();
  });

  it('requires a title, a description and a module', () => {
    expect(() => defineTool(readTool({ description: '' }))).toThrow(/description is empty/);
    expect(() => defineTool(readTool({ description: '   ' }))).toThrow(/description is empty/);
    expect(() => defineTool(readTool({ title: '' }))).toThrow(/title is empty/);
    expect(() => defineTool(readTool({ module: '' }))).toThrow(/module is empty/);
  });

  it('rejects unknown role, effect and fencing values', () => {
    expect(() => defineTool(readTool({ role: 'admin' }))).toThrow(/role/);
    expect(() => defineTool(readTool({ effect: 'write' }))).toThrow(/effect/);
    expect(() => defineTool(readTool({ fencing: 'deferred' }))).toThrow(/fencing/);
    expect(() => defineTool(readTool({ fencing: undefined }))).toThrow(/fencing/);
  });

  describe('annotations', () => {
    it('requires all four hints to be set explicitly', () => {
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        const annotations: Record<string, unknown> = { ...READ_HINTS };
        delete annotations[hint];
        expect(() => defineTool(readTool({ annotations }))).toThrow(new RegExp(hint));
      }
    });

    it('requires openWorldHint to be false', () => {
      expect(() => defineTool(readTool({ annotations: { ...READ_HINTS, openWorldHint: true } }))).toThrow(
        /openWorldHint must be false/,
      );
    });

    it('readOnlyHint true needs effect read', () => {
      expect(() =>
        defineTool(readTool({ name: 'create_announcement', effect: 'canvas_write', annotations: { ...READ_HINTS } })),
      ).toThrow(/readOnlyHint is true but the effect is 'canvas_write'/);
    });

    it('readOnlyHint true needs destructiveHint false', () => {
      expect(() => defineTool(readTool({ annotations: { ...READ_HINTS, destructiveHint: true } }))).toThrow(
        /destructiveHint is not false/,
      );
    });

    it('effect read needs readOnlyHint true', () => {
      expect(() => defineTool(readTool({ annotations: { ...WRITE_HINTS, destructiveHint: false } }))).toThrow(
        /effect is 'read' but readOnlyHint is false/,
      );
    });

    it('has no read tool that is exempt from the read-only rule', () => {
      expect([...READ_EFFECT_EXCEPTIONS]).toEqual([]);
    });

    it('accepts a write tool with readOnlyHint false', () => {
      const def = defineTool(
        readTool({ name: 'create_announcement', effect: 'canvas_write', annotations: { ...WRITE_HINTS } }),
      );
      expect(def.annotations.destructiveHint).toBe(true);
    });
  });

  describe('agreement with the tool policy table', () => {
    it('rejects a write declared as a read', () => {
      expect(() => defineTool(readTool({ name: 'create_announcement' }))).toThrow(
        /disagrees with the tool policy table \('canvas_write'\)/,
      );
    });

    it('rejects a read declared as a write', () => {
      expect(() =>
        defineTool(readTool({ name: 'list_courses', effect: 'canvas_write', annotations: { ...WRITE_HINTS } })),
      ).toThrow(/disagrees with the tool policy table \('read'\)/);
    });

    it('registers generate_peer_review_report as a read, and only as a read', () => {
      expect(() => defineTool(readTool({ name: 'generate_peer_review_report' }))).not.toThrow();
      expect(() =>
        defineTool(
          readTool({ name: 'generate_peer_review_report', effect: 'local_write', annotations: { ...WRITE_HINTS } }),
        ),
      ).toThrow(/disagrees with the tool policy table \('read'\)/);
    });

    it('requires a diagnostics tool to be a read', () => {
      expect(() =>
        defineTool(
          readTool({
            name: 'probe_writer',
            effect: 'canvas_write',
            gate: { diagnostics: true },
            annotations: { ...WRITE_HINTS },
          }),
        ),
      ).toThrow(/diagnostics tool must have effect read/);
    });
  });

  describe('raw access', () => {
    it('is pinned to the two tools upstream runs un-anonymized', () => {
      expect([...RAW_ACCESS_TOOLS].sort()).toEqual(['check_enrollment', 'create_student_anonymization_map']);
    });

    it('is refused on any other tool', () => {
      expect(() => defineTool(readTool({ name: 'list_users', rawAccess: true }))).toThrow(/rawAccess is not granted/);
    });

    it('is accepted on check_enrollment', () => {
      expect(defineTool(readTool({ name: 'check_enrollment', rawAccess: true })).rawAccess).toBe(true);
    });
  });

  describe('budget', () => {
    it('has the tier limits S 6, M 20, L 40', () => {
      expect(BUDGET_TIER_LIMITS).toEqual({ S: 6, M: 20, L: 40 });
    });

    it('rejects an unknown tier and a non-positive request count', () => {
      expect(() => defineTool(readTool({ budget: { tier: 'XL' } }))).toThrow(/budget tier/);
      expect(() => defineTool(readTool({ budget: { tier: 'constructor' } }))).toThrow(/budget tier/);
      expect(() => defineTool(readTool({ budget: { tier: 'S', requests: 0 } }))).toThrow(/budget.requests/);
      expect(() => defineTool(readTool({ budget: { tier: 'S', requests: 2.5 } }))).toThrow(/budget.requests/);
    });

    it('budgetLimit prefers the declared request count over the tier limit', () => {
      expect(budgetLimit({ budget: { tier: 'S' } })).toBe(6);
      expect(budgetLimit({ budget: { tier: 'M' } })).toBe(20);
      expect(budgetLimit({ budget: { tier: 'L' } })).toBe(40);
      expect(budgetLimit({ budget: { tier: 'L', requests: 12 } })).toBe(12);
    });
  });

  describe('params', () => {
    it('rejects an enum default that is not one of its values', () => {
      expect(() =>
        defineTool(readTool({ params: { mode: { kind: 'enum', values: ['a', 'b'], default: 'c', description: 'm' } } })),
      ).toThrow(/parameter 'mode' has a default that is not one of its values/);
    });

    it('rejects an empty enum', () => {
      expect(() => defineTool(readTool({ params: { mode: { kind: 'enum', values: [], description: 'm' } } }))).toThrow(
        /at least one enum value/,
      );
    });

    it('rejects a default of the wrong type', () => {
      expect(() => defineTool(readTool({ params: { n: { kind: 'int', default: 1.5, description: 'n' } } }))).toThrow(
        /not an integer/,
      );
      expect(() =>
        defineTool(readTool({ params: { flag: { kind: 'bool', default: 'true', description: 'f' } } })),
      ).toThrow(/not a boolean/);
      expect(() => defineTool(readTool({ params: { s: { kind: 'string', default: 5, description: 's' } } }))).toThrow(
        /not a string/,
      );
    });

    it('rejects an unknown kind, an invalid name and a missing description', () => {
      expect(() => defineTool(readTool({ params: { x: { kind: 'date', description: 'x' } } }))).toThrow(/unknown kind/);
      expect(() => defineTool(readTool({ params: { 'bad name': { kind: 'string', description: 'x' } } }))).toThrow(
        /invalid name/,
      );
      expect(() => defineTool(readTool({ params: { x: { kind: 'string' } } }))).toThrow(/needs a description/);
    });

    it('rejects a missing handler', () => {
      expect(() => defineTool(readTool({ handler: undefined }))).toThrow(/handler is not a function/);
    });
  });
});

describe('toSummary', () => {
  it('exposes the six public members and nothing else', () => {
    const def = defineTool(readTool({ rawAccess: undefined, gate: { needsD1: true } }));
    expect(toSummary(def)).toEqual({
      name: 'list_courses',
      title: 'List courses',
      description: 'List courses for the current user.',
      module: 'courses',
      role: 'shared',
      effect: 'read',
    });
  });
});

describe('advertisedAnnotations', () => {
  it('returns a fresh copy of the four hints', () => {
    const def = defineTool(readTool());
    const hints = advertisedAnnotations(def);
    expect(hints).toEqual(READ_HINTS);
    expect(hints).not.toBe(def.annotations);
  });
});

describe('inputSchemaFor', () => {
  const params = {
    course_identifier: { kind: 'id', description: 'Course' },
    limit: { kind: 'int', default: 10, description: 'How many' },
  } as const;

  it('is exactly buildInputSchema of the params', () => {
    expect(inputSchemaFor({ params })).toEqual(buildInputSchema(params));
  });

  it('returns one frozen object per params object', () => {
    const first = inputSchemaFor({ params });
    expect(inputSchemaFor({ params })).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.properties)).toBe(true);
    expect(() => {
      (first.properties as Record<string, unknown>).injected = {};
    }).toThrow(TypeError);
  });
});
