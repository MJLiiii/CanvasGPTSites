// No single upstream file: replaces the @mcp.tool(...) decorators and the registration tests around them
// (canvas-mcp src/canvas_mcp/tools/*.py, tests/security/test_tool_policy.py).
import { registeredEffect } from '../core/tool-policy';
import { buildInputSchema } from '../core/validation';
import type { BudgetTier, ParamSpec, ParamSpecs, ToolDef, ToolSummary } from '../types';

/** Subrequests a tool call may spend, by tier, before CANVAS_REQUEST_BUDGET is applied. */
export const BUDGET_TIER_LIMITS: Readonly<Record<BudgetTier, number>> = Object.freeze({ S: 6, M: 20, L: 40 });

/**
 * Tools declared with effect 'read' that may still say `readOnlyHint: false`.
 * Empty on purpose: every read in this port is read-only, and a name is added
 * here only together with a note in docs/PORTING.md saying why.
 */
export const READ_EFFECT_EXCEPTIONS: ReadonlySet<string> = new Set<string>();

/**
 * The only tools that may ask the Canvas client for un-anonymized data.
 * Upstream skips anonymization in exactly these two places
 * (tools/admin_tools.py and core/enrollment.py).
 */
export const RAW_ACCESS_TOOLS: ReadonlySet<string> = new Set(['check_enrollment', 'create_student_anonymization_map']);

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EFFECTS: ReadonlySet<string> = new Set(['read', 'canvas_write', 'local_write', 'code_exec']);
const ROLES: ReadonlySet<string> = new Set(['shared', 'student', 'educator']);
const FENCING: ReadonlySet<string> = new Set(['fenced', 'safe']);
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

export class ToolDefinitionError extends Error {
  constructor(tool: string, problem: string) {
    super(`Invalid tool definition '${tool}': ${problem}`);
    this.name = 'ToolDefinitionError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function checkParam(tool: string, name: string, spec: ParamSpec): void {
  const fail = (problem: string): never => {
    throw new ToolDefinitionError(tool, `parameter '${name}' ${problem}`);
  };
  if (!PARAM_NAME.test(name)) fail('has an invalid name');
  if (typeof spec.description !== 'string') fail('needs a description');
  const fallback: unknown = 'default' in spec ? spec.default : undefined;
  switch (spec.kind) {
    case 'id':
    case 'string':
      if (fallback !== undefined && typeof fallback !== 'string') fail('has a default that is not a string');
      break;
    case 'int':
      if (fallback !== undefined && !Number.isSafeInteger(fallback)) fail('has a default that is not an integer');
      break;
    case 'float':
      if (fallback !== undefined && !(typeof fallback === 'number' && Number.isFinite(fallback))) {
        fail('has a default that is not a number');
      }
      break;
    case 'bool':
      if (fallback !== undefined && typeof fallback !== 'boolean') fail('has a default that is not a boolean');
      break;
    case 'enum':
      if (!Array.isArray(spec.values) || spec.values.length === 0) fail('needs at least one enum value');
      if (spec.values.some((value) => typeof value !== 'string')) fail('has an enum value that is not a string');
      if (fallback !== undefined && !spec.values.includes(fallback as string)) {
        fail('has a default that is not one of its values');
      }
      break;
    case 'list':
      if (spec.items !== 'string' && spec.items !== 'id' && spec.items !== 'object') fail('has an unknown item type');
      break;
    case 'dict':
      break;
    default:
      fail('has an unknown kind');
  }
}

/**
 * Check a tool definition once, when its module is evaluated, and return it
 * frozen. A wrong definition throws here, so it fails every test that imports
 * the module instead of misbehaving on one request.
 *
 * Consistency rules (OpenAI reads the hints to decide whether to ask the user):
 *  - `readOnlyHint: true` requires effect 'read' and `destructiveHint: false`
 *  - effect 'read' requires `readOnlyHint: true`, unless listed in READ_EFFECT_EXCEPTIONS
 *  - `openWorldHint` is always false: Canvas is one bounded account
 *  - the declared effect must agree with TOOL_EFFECTS for a classified name
 */
export function defineTool<P extends ParamSpecs>(def: ToolDef<P>): ToolDef<P> {
  const name = typeof def.name === 'string' ? def.name : String(def.name);
  const fail = (problem: string): never => {
    throw new ToolDefinitionError(name, problem);
  };

  if (!TOOL_NAME.test(name)) fail('the name must match /^[a-z][a-z0-9_]*$/');
  if (!isNonEmptyString(def.title)) fail('the title is empty');
  if (!isNonEmptyString(def.description)) fail('the description is empty');
  if (!isNonEmptyString(def.module)) fail('the module is empty');
  if (!ROLES.has(def.role)) fail('the role is not one of shared, student, educator');
  if (!EFFECTS.has(def.effect)) fail('the effect is not one of read, canvas_write, local_write, code_exec');
  if (!FENCING.has(def.fencing)) fail("fencing must be 'fenced' or 'safe'");
  if (typeof def.handler !== 'function') fail('the handler is not a function');

  const annotations: Record<string, unknown> = { ...def.annotations };
  for (const hint of HINTS) {
    if (typeof annotations[hint] !== 'boolean') fail(`annotation ${hint} must be set explicitly`);
  }
  if (annotations.openWorldHint !== false) fail('openWorldHint must be false');
  if (annotations.readOnlyHint === true) {
    if (def.effect !== 'read') fail(`readOnlyHint is true but the effect is '${def.effect}'`);
    if (annotations.destructiveHint !== false) fail('readOnlyHint is true but destructiveHint is not false');
  } else if (def.effect === 'read' && !READ_EFFECT_EXCEPTIONS.has(name)) {
    fail("the effect is 'read' but readOnlyHint is false");
  }

  const classified = registeredEffect(name);
  if (classified !== undefined && classified !== def.effect) {
    fail(`the effect '${def.effect}' disagrees with the tool policy table ('${classified}')`);
  }
  if (def.gate?.diagnostics === true && def.effect !== 'read') fail('a diagnostics tool must have effect read');
  if (def.rawAccess === true && !RAW_ACCESS_TOOLS.has(name)) fail('rawAccess is not granted to this tool');

  const budget = def.budget;
  if (budget === null || typeof budget !== 'object' || !Object.hasOwn(BUDGET_TIER_LIMITS, budget.tier)) {
    fail('the budget tier must be S, M or L');
  }
  if (budget.requests !== undefined && !(Number.isSafeInteger(budget.requests) && budget.requests > 0)) {
    fail('budget.requests must be a positive integer');
  }

  if (def.params === null || typeof def.params !== 'object' || Array.isArray(def.params)) {
    fail('params must be an object of parameter specs');
  }
  for (const [paramName, spec] of Object.entries(def.params)) {
    checkParam(name, paramName, spec);
  }

  Object.freeze(def.annotations);
  Object.freeze(def.budget);
  Object.freeze(def.params);
  if (def.gate !== undefined) Object.freeze(def.gate);
  return Object.freeze(def);
}

/** What `search_canvas_tools` and the status page may show about a tool. */
export function toSummary(def: ToolDef): ToolSummary {
  return {
    name: def.name,
    title: def.title,
    description: advertisedDescription(def),
    module: def.module,
    role: def.role,
    effect: def.effect,
  };
}

/** Subrequests the tool asks for: its declared `requests`, else its tier's limit. */
export function budgetLimit(def: Pick<ToolDef, 'budget'>): number {
  return def.budget.requests ?? BUDGET_TIER_LIMITS[def.budget.tier];
}

/** Hints as advertised in tools/list. A fresh object, so a backend cannot alter the definition. */
export function advertisedAnnotations(def: ToolDef): ToolDef['annotations'] {
  return {
    readOnlyHint: def.annotations.readOnlyHint,
    destructiveHint: def.annotations.destructiveHint,
    idempotentHint: def.annotations.idempotentHint,
    openWorldHint: def.annotations.openWorldHint,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Tool definitions are module constants, so their generated schemas are the
// same for every request. The cache holds nothing that belongs to a request,
// and its entries are frozen because every request is handed the same object.
const schemaCache = new WeakMap<ParamSpecs, Record<string, unknown>>();

const scopedParams = new WeakMap<ParamSpecs, ParamSpecs>();

/** Transport parameter consumed by dispatch, never passed to the original handler. */
export function paramsFor(def: Pick<ToolDef, 'params' | 'canvasScope'>): ParamSpecs {
  if (def.canvasScope !== 'single' && def.canvasScope !== 'aggregate') return def.params;
  let params = scopedParams.get(def.params);
  if (params === undefined) {
    params = Object.freeze({ ...def.params, canvas_instance: {
      kind: 'string', optional: true,
      description: 'Configured Canvas connection ID from list_canvas_instances. Required for a single-connection operation when multiple connections exist; omit for supported overview aggregation.',
    } });
    scopedParams.set(def.params, params);
  }
  return params;
}

export function advertisedDescription(def: ToolDef): string {
  if (def.canvasScope !== 'single' && def.canvasScope !== 'aggregate') return def.description;
  return def.description + '\n\ncanvas_instance: Custom connection ID from list_canvas_instances. ' +
    (def.canvasScope === 'aggregate' ? 'Omit to query all configured connections, grouped by connection.'
      : 'Required when multiple Canvas connections are configured.');
}

/** The JSON Schema advertised for a tool's arguments; both backends emit exactly this object. */
export function inputSchemaFor(def: Pick<ToolDef, 'params' | 'canvasScope'>): Record<string, unknown> {
  const params = paramsFor(def);
  let schema = schemaCache.get(params);
  if (schema === undefined) {
    schema = deepFreeze(buildInputSchema(params));
    schemaCache.set(params, schema);
  }
  return schema;
}
