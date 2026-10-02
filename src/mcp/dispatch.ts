// No single upstream file: the tool-call path that FastMCP, the validate_params decorator
// (canvas-mcp src/canvas_mcp/core/validation.py) and CanvasToolResultMiddleware (core/tool_results.py) form together.
import { SubrequestMeter } from '../canvas/budget';
import type { CanvasClientFactory } from '../canvas/client';
import { redactSecrets, redactSecretsDeep } from '../core/logging';
import { escapeNonAsciiJson } from '../core/python-text';
import { coerceArgs } from '../core/validation';
import type {
  CanvasClient,
  CanvasCredential,
  Config,
  CredentialProvider,
  CredentialResult,
  DiagnosticsAccess,
  Identity,
  Logger,
  ToolContext,
  ToolDef,
  ToolOutput,
  ToolResult,
  ToolSummary,
} from '../types';
import { RAW_ACCESS_TOOLS, budgetLimit } from './define-tool';
import { errorResult, mapToolOutput, textIsError, withTruncationDisclosure } from './result';
import type { TruncationRecord } from './result';

// Type-only: the client itself is handed in as `DispatchDeps.createClient`,
// so this layer builds and tests without the Canvas client module.
export type { CanvasClientDeps, CanvasClientFactory } from '../canvas/client';

export interface DispatchDeps {
  config: Config;
  identity: Identity | null;
  credentials: CredentialProvider;
  createClient: CanvasClientFactory;
  log: Logger;
  requestId: string;
  pseudonymSalt: string | null;
  /** Every secret-class value of the deployment; none may leave in a result. */
  secretsToRedact: readonly string[];
  registeredTools: ReadonlyArray<ToolSummary>;
  diagnostics?: DiagnosticsAccess;
  fetchImpl?: typeof fetch;
  now?: () => number;
  protocolEra?: 'legacy' | 'modern';
}

/** What a diagnostics tool sees as `ctx.identity` when the request carried none. */
export const NO_IDENTITY: Identity = Object.freeze({
  key: 'diagnostics:no-identity',
  userId: null,
  email: null,
  fullName: null,
  source: 'sites-gateway',
});

export const NOT_AUTHORIZED_MESSAGE = 'Error: Not authorized.';
export const MISCONFIGURED_MESSAGE = 'Error: Server misconfigured. The Site owner can see the details on the status page.';
export const CREDENTIALS_UNAVAILABLE_MESSAGE = 'Error: Canvas credentials are unavailable.';
export const TOOL_UNAVAILABLE_MESSAGE = 'Error: This tool is not available.';

const MAX_ERROR_MESSAGE = 200;
const MAX_STACK_FRAMES = 8;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freeze a detached configuration snapshot, including nested policy and lists. */
function immutableConfig(config: Config): Config {
  function freeze(value: unknown): void {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  const snapshot = structuredClone(config);
  freeze(snapshot);
  return snapshot;
}

/** The text upstream's `validate_params` returns: `json.dumps({"error": message})`. */
export function validationErrorText(message: string): string {
  return `{"error": ${escapeNonAsciiJson(JSON.stringify(message))}}`;
}

/** A provider's public message as an error text; the wording is the provider's, never a reason code. */
function asErrorText(publicMessage: string, fallback: string): string {
  const message = typeof publicMessage === 'string' ? publicMessage.trim() : '';
  if (message === '') return fallback;
  return textIsError(message) ? message : `Error: ${message}`;
}

interface ThrownDescription {
  text: string;
  name: string;
  message: string;
  frames: string;
}

/**
 * What a thrown error may say in a result: its class name and a bounded first
 * line of its message. A SyntaxError keeps only its name, because parser
 * messages quote the text they choked on, and that text may be a Canvas body
 * that has not been anonymized yet.
 */
function describeThrown(error: unknown, secrets: readonly string[]): ThrownDescription {
  if (!(error instanceof Error)) {
    return { text: 'Error: UnknownError', name: 'UnknownError', message: '', frames: '' };
  }
  const name = typeof error.name === 'string' && SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error';
  let message = '';
  if (name !== 'SyntaxError') {
    const firstLine = String(error.message).split(/\r?\n/, 1)[0] ?? '';
    const bounded = firstLine.trim().slice(0, MAX_ERROR_MESSAGE);
    message = redactSecrets(bounded, secrets);
  }
  // Frames only: the first line of a stack repeats the message.
  const frames = String(error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => line.trim())
    .join(' | ');
  let text: string;
  if (name === 'Error') {
    text = message === '' ? 'Error: the tool failed' : `Error: ${message}`;
  } else {
    text = message === '' ? `Error: ${name}` : `Error: ${name}: ${message}`;
  }
  return { text, name, message, frames };
}

interface Redaction {
  count: number;
}

function redactText(text: string, secrets: readonly string[], seen: Redaction): string {
  const out = redactSecrets(text, secrets);
  if (out !== text) seen.count += 1;
  return out;
}

/** Redact every string, keys included, of a JSON value. */
function redactJson<T>(value: T, secrets: readonly string[], seen: Redaction): T {
  return redactSecretsDeep(value, secrets, () => {
    seen.count += 1;
  });
}

/**
 * Reduce a handler's object to plain JSON data (what the wire will carry) and
 * redact it. Throws if the value cannot be serialized; the caller reports that.
 */
function cleanObjectOutput(
  output: Record<string, unknown>,
  secrets: readonly string[],
  seen: Redaction,
): Record<string, unknown> | null {
  const plain: unknown = JSON.parse(JSON.stringify(output));
  if (!isPlainObject(plain)) return null;
  return redactJson(plain, secrets, seen);
}

function redactResult(result: ToolResult, secrets: readonly string[], seen: Redaction): ToolResult {
  const content = result.content.map((block) => ({ type: block.type, text: redactText(block.text, secrets, seen) }));
  const out: ToolResult = { content };
  if (result.structuredContent !== undefined) {
    out.structuredContent = redactJson(result.structuredContent, secrets, seen);
  }
  if (result.isError !== undefined) out.isError = result.isError;
  return out;
}

function undisclosed(client: CanvasClient | null): TruncationRecord[] {
  if (client === null) return [];
  try {
    return client.truncations.filter((record) => !record.disclosed);
  } catch {
    return [];
  }
}

function anyTruncation(client: CanvasClient | null): boolean {
  if (client === null) return false;
  try {
    return client.truncations.length > 0;
  } catch {
    return false;
  }
}

type Stage = { kind: 'final'; result: ToolResult } | { kind: 'output'; output: ToolOutput };

interface CallState {
  meter: SubrequestMeter | null;
  client: CanvasClient | null;
}

function refuse(text: string): Stage {
  return { kind: 'final', result: errorResult(text) };
}

async function produce(def: ToolDef, rawArgs: unknown, deps: DispatchDeps, state: CallState): Promise<Stage> {
  const { config, log } = deps;
  const now = deps.now ?? Date.now;
  const isDiagnostics = def.gate?.diagnostics === true;

  // The registry already keeps these apart; a tool reaching this point on the
  // wrong side of the switch is a wiring bug and is refused, not run.
  if (isDiagnostics !== config.diagnosticsEnabled) {
    log.security('tool_call_refused', { tool: def.name, reason: 'diagnostics_mode_mismatch' });
    return refuse(TOOL_UNAVAILABLE_MESSAGE);
  }

  let identity: Identity = NO_IDENTITY;
  let credential: CanvasCredential | null = null;
  if (!isDiagnostics) {
    if (config.errors.length > 0) {
      log.security('tool_call_refused', { tool: def.name, reason: 'config_errors' });
      return refuse(MISCONFIGURED_MESSAGE);
    }
    const authorized = deps.credentials.authorize(deps.identity);
    if (!authorized.ok) {
      log.security('tool_call_denied', { tool: def.name, reason: 'not_authorized' });
      return refuse(asErrorText(authorized.publicMessage, NOT_AUTHORIZED_MESSAGE));
    }
    if (deps.identity === null) {
      log.security('tool_call_denied', { tool: def.name, reason: 'no_identity' });
      return refuse(NOT_AUTHORIZED_MESSAGE);
    }
    identity = deps.identity;
    let resolved: CredentialResult;
    try {
      resolved = await deps.credentials.resolve(identity);
    } catch (error) {
      log.error('credential_resolve_failed', { tool: def.name, error_name: describeThrown(error, []).name });
      return refuse(CREDENTIALS_UNAVAILABLE_MESSAGE);
    }
    if (!resolved.ok) {
      log.security('tool_call_denied', { tool: def.name, reason: resolved.reason });
      return refuse(asErrorText(resolved.publicMessage, CREDENTIALS_UNAVAILABLE_MESSAGE));
    }
    credential = resolved.credential;
  } else if (deps.identity !== null) {
    identity = deps.identity;
  }

  const args = coerceArgs(def.params, rawArgs);
  if (!args.ok) {
    // Exactly upstream's validate_params: the message as a JSON text, flagged as an error.
    return refuse(validationErrorText(args.error));
  }

  const meter = new SubrequestMeter(Math.min(budgetLimit(def), config.requestBudget));
  state.meter = meter;
  const deadline = now() + config.toolDeadlineMs;

  const shared = {
    requestId: deps.requestId,
    deadline,
    config,
    identity,
    log,
    registeredTools: deps.registeredTools,
    ...(deps.protocolEra !== undefined && { protocolEra: deps.protocolEra }),
  };

  let ctx: ToolContext;
  if (credential !== null) {
    const client = deps.createClient({
      credential,
      config,
      meter,
      deadline,
      log,
      allowRaw: def.rawAccess === true && RAW_ACCESS_TOOLS.has(def.name),
      pseudonymSalt: deps.pseudonymSalt,
      ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
      ...(deps.now !== undefined && { now: deps.now }),
    });
    state.client = client;
    ctx = { ...shared, canvas: client };
  } else {
    ctx = {
      ...shared,
      ...(deps.diagnostics !== undefined && { diagnostics: deps.diagnostics }),
      get canvas(): CanvasClient {
        throw new Error('Diagnostics tools have no Canvas client and no Canvas credential.');
      },
    };
    // Not enumerable, so copying or logging the context cannot trip it.
    Object.defineProperty(ctx, 'canvas', { enumerable: false });
  }
  Object.freeze(ctx);

  let output: ToolOutput;
  try {
    output = await def.handler(args.value, ctx);
  } catch (error) {
    const thrown = describeThrown(error, deps.secretsToRedact);
    log.error('tool_error', {
      tool: def.name,
      error_name: thrown.name,
      error_message: thrown.message,
      stack: thrown.frames,
    });
    output = thrown.text;
  }
  if (typeof output !== 'string' && !isPlainObject(output)) {
    log.error('tool_error', { tool: def.name, error_name: 'InvalidToolOutput' });
    return refuse('Error: the tool returned no usable output.');
  }
  return { kind: 'output', output };
}

/**
 * Run one tool call end to end and return its MCP result. Never throws and
 * never returns a secret: every failure becomes an `isError` result, and the
 * result is scrubbed of the deployment's secrets before it is returned.
 *
 * `rawArgs` is the caller's `arguments` value, untouched; coercion and
 * upstream-style validation errors happen here, not in the transport.
 */
export async function runTool(def: ToolDef, rawArgs: unknown, dispatchDeps: DispatchDeps): Promise<ToolResult> {
  // A handler must not change the client's privacy switches or the result limit.
  const deps = { ...dispatchDeps, config: immutableConfig(dispatchDeps.config) };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const secrets = deps.secretsToRedact;
  const seen: Redaction = { count: 0 };
  const state: CallState = { meter: null, client: null };
  let result: ToolResult;
  let cut = false;

  try {
    const stage = await produce(def, rawArgs, deps, state);
    if (stage.kind === 'final') {
      result = stage.result;
    } else {
      let output = withTruncationDisclosure(stage.output, undisclosed(state.client));
      // Redacted before the size limit as well as after: a secret cut in half
      // by truncation would no longer match and its first half would get out.
      if (typeof output === 'string') {
        output = redactText(output, secrets, seen);
      } else {
        const cleaned = cleanObjectOutput(output, secrets, seen);
        if (cleaned === null) throw new TypeError('tool output is not a JSON object');
        output = cleaned;
      }
      const mapped = mapToolOutput(output, { maxBytes: deps.config.maxToolResultBytes });
      result = mapped.result;
      cut = mapped.cut || mapped.refused;
    }
  } catch (error) {
    const thrown = describeThrown(error, secrets);
    deps.log.error('tool_dispatch_error', { tool: def.name, error_name: thrown.name, stack: thrown.frames });
    result = errorResult(`Error: ${thrown.name === 'Error' ? 'the tool call failed' : thrown.name}`);
  }

  result = redactResult(result, secrets, seen);
  if (seen.count > 0) {
    deps.log.security('secret_redacted_from_tool_output', { tool: def.name, occurrences: seen.count });
  }

  const counts = state.meter?.counts ?? { canvas: 0, d1: 0, r2: 0 };
  deps.log.info('tool_call', {
    tool: def.name,
    effect: def.effect,
    isError: result.isError === true,
    ms: Math.max(0, now() - startedAt),
    subrequests: state.meter?.used ?? 0,
    budget: state.meter?.limit ?? 0,
    canvas_requests: counts.canvas,
    d1_calls: counts.d1,
    r2_calls: counts.r2,
    truncated: cut || anyTruncation(state.client),
  });
  return result;
}
