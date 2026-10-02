// Replaces register_all_tools in canvas-mcp src/canvas_mcp/server.py and apply_tool_policy in core/tool_policy.py.
import { isToolAllowed, resolveToolPolicy } from '../core/tool-policy';
import type { Config, ToolDef, ToolSummary } from '../types';
import { toSummary } from './define-tool';

export interface RegistryFeatures {
  /** The D1 binding is present. */
  hasD1: boolean;
  /** The R2 binding is present. */
  hasR2: boolean;
}

export interface SkippedTool {
  name: string;
  /** Why the tool is not offered; names settings, never their values. */
  reason: string;
}

export interface ToolSet {
  tools: ToolDef[];
  skipped: SkippedTool[];
}

/** The first rule that excludes `def`, or null when every rule admits it. Rules are checked in a fixed order. */
function exclusion(
  def: ToolDef,
  config: Config,
  features: RegistryFeatures,
  disabled: ReadonlySet<string>,
  allowedWrites: ReadonlySet<string>,
): string | null {
  const isDiagnostics = def.gate?.diagnostics === true;

  // Diagnostics mode is a different server: the spike tools and nothing else.
  // Config parsing guarantees that no Canvas token exists while it is on.
  if (config.diagnosticsEnabled) {
    if (!isDiagnostics) return 'diagnostics mode is on (DIAGNOSTICS_ENABLED); only diagnostics tools are registered';
    if (def.effect !== 'read') return 'a diagnostics tool must be a read';
    return disabled.has(def.name) ? 'listed in DISABLED_TOOLS' : null;
  }
  if (isDiagnostics) return 'diagnostics tools need DIAGNOSTICS_ENABLED';

  const roleAdmits =
    def.role === 'shared' ||
    (def.role === 'student' && (config.role === 'student' || config.role === 'all')) ||
    (def.role === 'educator' && (config.role === 'educator' || config.role === 'all'));
  if (!roleAdmits) return `${def.role} tools need CANVAS_ROLE=${def.role} or all; it is ${config.role}`;

  if (def.gate?.studentWrite === true && !config.studentWriteTools.includes(def.name)) {
    return 'not listed in STUDENT_WRITE_TOOLS';
  }
  if (def.gate?.accessibilityChecker !== undefined && !config.accessibilityCheckers.includes(def.gate.accessibilityChecker)) {
    return `accessibility checker '${def.gate.accessibilityChecker}' is not enabled in ACCESSIBILITY_CHECKERS`;
  }

  if (def.gate?.needsD1 === true && !features.hasD1) return 'needs the D1 database binding';
  if (def.gate?.needsR2 === true && !features.hasR2) return 'needs the R2 bucket binding';
  if (def.gate?.needsConfirmSecret === true && !config.hasConfirmationSecret) return 'needs CONFIRMATION_SECRET';

  // A tier limit above the budget only means the tool runs with less; a declared
  // minimum above it means the tool cannot finish, so it is not offered.
  if (def.budget.requests !== undefined && def.budget.requests > config.requestBudget) {
    return `needs ${def.budget.requests} requests per call; CANVAS_REQUEST_BUDGET allows ${config.requestBudget}`;
  }

  if (disabled.has(def.name)) return 'listed in DISABLED_TOOLS';

  if (!isToolAllowed(def.name, def.effect, allowedWrites)) {
    return def.effect === 'read'
      ? 'not classified in the tool policy table'
      : 'not allowed by ALLOWED_WRITE_TOOLS';
  }
  return null;
}

/**
 * Decide which tools exist for this deployment. This is the boundary a prompt
 * injection cannot talk its way past: a tool that is not returned here is
 * never listed and never callable.
 *
 * Applied in order: diagnostics mode, role, STUDENT_WRITE_TOOLS,
 * ACCESSIBILITY_CHECKERS, feature gates (D1, R2, confirmation secret, budget),
 * DISABLED_TOOLS, then the write allowlist. The result keeps the order of
 * `all`, so tools/list is deterministic.
 *
 * Pure, and cheap enough to run per request; nothing is cached here.
 */
export function computeToolSet(all: ReadonlyArray<ToolDef>, config: Config, features: RegistryFeatures): ToolSet {
  const policy = resolveToolPolicy(config.allowedWriteToolsRaw);
  // An unreadable allowlist already refuses every request (config.errors); here it means no writes.
  const allowedWrites: ReadonlySet<string> = policy.ok ? policy.allowedWrites : new Set();
  const disabled = new Set(config.disabledTools);

  const tools: ToolDef[] = [];
  const skipped: SkippedTool[] = [];
  const seen = new Set<string>();
  for (const def of all) {
    if (seen.has(def.name)) {
      skipped.push({ name: def.name, reason: 'duplicate tool name' });
      continue;
    }
    seen.add(def.name);
    const reason = exclusion(def, config, features, disabled, allowedWrites);
    if (reason === null) {
      tools.push(def);
    } else {
      skipped.push({ name: def.name, reason });
    }
  }
  return { tools, skipped };
}

/** Summaries of the registered tools, in registration order (for `search_canvas_tools`). */
export function summarize(tools: ReadonlyArray<ToolDef>): ToolSummary[] {
  return tools.map(toSummary);
}
