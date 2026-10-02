// No upstream counterpart: Milestone 0 spike tools. Registered only when DIAGNOSTICS_ENABLED=true, which config
// parsing allows only while no Canvas token and no confirmation secret are configured.
import { isValidTimeZone } from '../core/dates';
import { sha256Hex } from '../core/hash';
import { defineTool } from '../mcp/define-tool';
import type { ToolContext, ToolOutput } from '../types';
import { SERVER_VERSION, UPSTREAM_VERSION } from '../version';

export const DIAGNOSTIC_PROBES = ['headers', 'runtime', 'subrequests', 'd1', 'cpu', 'wall', 'size'] as const;
export type DiagnosticProbe = (typeof DIAGNOSTIC_PROBES)[number];

/** Upper bounds on `n`, per probe. */
export const PROBE_LIMITS = Object.freeze({
  subrequests: 150,
  d1: 60,
  cpuMs: 20_000,
  wallMs: 150_000,
  sizeBytes: 2_000_000,
});

const PROBE_DEFAULTS = Object.freeze({ subrequests: 10, d1: 5, cpuMs: 50, wallMs: 1000, sizeBytes: 1000 });

const IDENTITY_HEADERS = [
  'oai-authenticated-user-id',
  'oai-authenticated-user-email',
  'oai-authenticated-user-full-name',
] as const;

/** Protocol revisions a client may name in MCP-Protocol-Version; none of them is a secret. */
const KNOWN_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const NO_ACCESS = 'Error: diagnostics access is not available on this request.';

function clamp(value: number | undefined, fallback: number, low: number, high: number): number {
  const n = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value);
  return Math.min(high, Math.max(low, n));
}

export const HELLO_TEXT =
  `Hello from canvas-gpt-sites ${SERVER_VERSION}, a TypeScript port of canvas-mcp ${UPSTREAM_VERSION}. ` +
  'The MCP endpoint is reachable.';

export const hello = defineTool({
  name: 'hello',
  title: 'Hello',
  description: 'Check that the MCP endpoint is reachable. Returns a fixed greeting with the server and upstream versions.',
  module: 'diagnostics',
  role: 'shared',
  effect: 'read',
  gate: { diagnostics: true },
  params: {},
  annotations: READ_ONLY,
  budget: { tier: 'S' },
  fencing: 'safe',
  handler: async () => HELLO_TEXT,
});

/**
 * Which headers arrived, by name, length and a short hash, and whether the
 * three gateway identity headers are among them. No header value is returned.
 * The user id is the one exception to "short hash": its full SHA-256 is what
 * the owner copies into OWNER_USER_ID_SHA256.
 */
function probeHeaders(ctx: ToolContext): ToolOutput {
  const access = ctx.diagnostics;
  if (access === undefined) return NO_ACCESS;
  const headers = access.headerSummary().map((entry) => ({
    name: String(entry.name).toLowerCase(),
    length: entry.length,
    sha256_8: entry.sha256_8,
  }));
  const byName = new Map(headers.map((entry) => [entry.name, entry]));

  const identityHeaders: Record<string, { present: boolean }> = {};
  for (const name of IDENTITY_HEADERS) {
    identityHeaders[name] = { present: byName.has(name) };
  }

  // The value itself is not available here, only its short hash; a public
  // version string is recognised by hashing the handful of candidates.
  const versionEntry = byName.get('mcp-protocol-version');
  const protocolVersion =
    versionEntry === undefined
      ? null
      : (KNOWN_PROTOCOL_VERSIONS.find((version) => sha256Hex(version).slice(0, 8) === versionEntry.sha256_8) ??
        'unrecognized');

  const userId = ctx.identity.userId;
  return {
    probe: 'headers',
    headers,
    authorization: access.authorizationShape(),
    identity_headers: identityHeaders,
    identity_resolved: userId !== null || ctx.identity.email !== null,
    user_id_sha256: userId === null ? null : sha256Hex(userId),
    mcp_protocol_version: protocolVersion,
    protocol_era: ctx.protocolEra ?? 'unknown',
    note:
      'Header values are never returned. user_id_sha256 is the value for OWNER_USER_ID_SHA256; it is null when ' +
      'the id header is absent or was rejected.',
  };
}

function probeRuntime(ctx: ToolContext): ToolOutput {
  const access = ctx.diagnostics;
  if (access === undefined) return NO_ACCESS;
  let chicagoWorks = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago' }).format(new Date(0));
    chicagoWorks = true;
  } catch {
    chicagoWorks = false;
  }
  const globals = globalThis as Record<string, unknown>;
  const cryptoObject = globals.crypto as { subtle?: unknown; randomUUID?: unknown } | undefined;
  const navigatorObject = globals.navigator as { userAgent?: unknown } | undefined;
  return {
    probe: 'runtime',
    server_version: SERVER_VERSION,
    upstream_version: UPSTREAM_VERSION,
    bindings: access.bindingNames(),
    ctx_props: access.ctxPropKeys(),
    protocol_era: ctx.protocolEra ?? 'unknown',
    date: { now_ms: Date.now(), iso: new Date().toISOString() },
    intl: {
      available: typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function',
      named_time_zones: chicagoWorks,
      configured_time_zone: ctx.config.timezone,
      configured_time_zone_valid: isValidTimeZone(ctx.config.timezone),
    },
    web_crypto: {
      subtle: typeof cryptoObject?.subtle === 'object' && cryptoObject.subtle !== null,
      random_uuid: typeof cryptoObject?.randomUUID === 'function',
    },
    user_agent: typeof navigatorObject?.userAgent === 'string' ? navigatorObject.userAgent : null,
    globals: {
      set_timeout: typeof globals.setTimeout === 'function',
      text_encoder: typeof globals.TextEncoder === 'function',
      compression_stream: typeof globals.CompressionStream === 'function',
    },
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const SPIN_ITERATIONS = 200_000;
/** Chunks of work per requested millisecond before the probe gives up on the clock. */
const SPIN_CHUNKS_PER_MS = 20;

function spinChunk(seed: number): number {
  let x = seed | 0;
  for (let i = 0; i < SPIN_ITERATIONS; i += 1) {
    x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + i) | 0;
  }
  return x;
}

/**
 * Burn CPU for about `n` ms. On Workers the clock stands still while code
 * runs and moves only across I/O, so the loop yields to a zero-delay timer
 * between chunks and also stops after a fixed amount of work; a loop that
 * waited on the clock alone would never end there.
 */
async function probeCpu(n: number | undefined): Promise<ToolOutput> {
  const requested = clamp(n, PROBE_DEFAULTS.cpuMs, 0, PROBE_LIMITS.cpuMs);
  const maxChunks = Math.max(1, requested) * SPIN_CHUNKS_PER_MS;
  const start = Date.now();
  let chunks = 0;
  let acc = 1;
  let clockMoved = false;
  while (Date.now() - start < requested && chunks < maxChunks) {
    const before = Date.now();
    acc = spinChunk(acc);
    chunks += 1;
    if (Date.now() !== before) clockMoved = true;
    if (chunks % 4 === 0) await pause(0);
  }
  const elapsed = Date.now() - start;
  return {
    probe: 'cpu',
    requested_ms: requested,
    elapsed_ms: elapsed,
    chunks,
    iterations: chunks * SPIN_ITERATIONS,
    clock_advanced_while_spinning: clockMoved,
    stopped_by: elapsed >= requested ? 'clock' : 'work_limit',
    checksum: acc,
    note: 'A CPU-limit kill cannot be reported from inside the call; look for it in the Site worker logs.',
  };
}

async function probeWall(n: number | undefined): Promise<ToolOutput> {
  const requested = clamp(n, PROBE_DEFAULTS.wallMs, 0, PROBE_LIMITS.wallMs);
  const start = Date.now();
  await pause(requested);
  return { probe: 'wall', requested_ms: requested, elapsed_ms: Date.now() - start };
}

const FILLER_LINE = `${'x'.repeat(99)}\n`;

/**
 * Exactly `n` bytes of ASCII, in 100-byte lines. Returned as text, so a size
 * over MAX_TOOL_RESULT_BYTES shows the server's own truncation notice instead
 * of what the client does with a large result; raise that setting to test the client.
 */
function probeSize(n: number | undefined): ToolOutput {
  const requested = clamp(n, PROBE_DEFAULTS.sizeBytes, 1, PROBE_LIMITS.sizeBytes);
  const header = `size probe: ${requested} bytes\n`;
  if (requested <= header.length) return 's'.repeat(requested);
  const rest = requested - header.length;
  const fullLines = Math.floor(rest / FILLER_LINE.length);
  return header + FILLER_LINE.repeat(fullLines) + 'x'.repeat(rest - fullLines * FILLER_LINE.length);
}

export const sitesDiagnostics = defineTool({
  name: 'sites_diagnostics',
  title: 'Sites diagnostics',
  description:
    'Report facts about the hosting runtime for the deployment spike. Never returns header values, secrets or ' +
    'Canvas data.\n\n' +
    'Probes:\n' +
    '- headers: names, lengths and short hashes of the request headers; the shape of Authorization; whether the ' +
    'gateway identity headers are present; the full SHA-256 of the gateway user id (for OWNER_USER_ID_SHA256).\n' +
    '- runtime: binding names, ctx.props keys, protocol era, Date/Intl/crypto availability.\n' +
    '- subrequests: make n outbound fetches to a fixed URL without credentials (n 1-150) and count successes.\n' +
    '- d1: make n D1 calls (n 1-60) and count successes.\n' +
    '- cpu: burn CPU for about n ms (max 20000) and report the elapsed time.\n' +
    '- wall: wait n ms (max 150000) and report the elapsed time.\n' +
    '- size: return n bytes of filler text (max 2000000).',
  module: 'diagnostics',
  role: 'shared',
  effect: 'read',
  gate: { diagnostics: true },
  params: {
    probe: { kind: 'enum', values: DIAGNOSTIC_PROBES, description: 'Which probe to run.' },
    n: {
      kind: 'int',
      optional: true,
      description: 'Probe size: a count (subrequests, d1), milliseconds (cpu, wall) or bytes (size). Ignored by headers and runtime.',
    },
  },
  annotations: READ_ONLY,
  budget: { tier: 'S' },
  fencing: 'safe',
  handler: async (args, ctx) => {
    switch (args.probe as DiagnosticProbe) {
      case 'headers':
        return probeHeaders(ctx);
      case 'runtime':
        return probeRuntime(ctx);
      case 'subrequests': {
        if (ctx.diagnostics === undefined) return NO_ACCESS;
        const count = clamp(args.n, PROBE_DEFAULTS.subrequests, 1, PROBE_LIMITS.subrequests);
        return { probe: 'subrequests', requested: count, ...(await ctx.diagnostics.probeFetch(count)) };
      }
      case 'd1': {
        if (ctx.diagnostics === undefined) return NO_ACCESS;
        const count = clamp(args.n, PROBE_DEFAULTS.d1, 1, PROBE_LIMITS.d1);
        return { probe: 'd1', requested: count, ...(await ctx.diagnostics.probeD1(count)) };
      }
      case 'cpu':
        return probeCpu(args.n);
      case 'wall':
        return probeWall(args.n);
      case 'size':
        return probeSize(args.n);
      default:
        return `Error: unknown probe. Use one of: ${DIAGNOSTIC_PROBES.join(', ')}.`;
    }
  },
});
