import { describe, expect, it } from 'vitest';
import { SubrequestMeter } from '../../src/canvas/budget';
import { createCanvasClient } from '../../src/canvas/client';
import { isFailure } from '../../src/canvas/errors';
import { canvasId, canvasPath } from '../../src/canvas/path';
import { createLogger } from '../../src/core/logging';
import { fenceUntrusted, FENCE_TEXT_END } from '../../src/core/untrusted-content';
import { parseConfig, parseSecrets, secretValuesForRedaction } from '../../src/env';
import { createFakeCanvas, json } from '../helpers/fake-canvas';
import {
  CREDENTIALS_UNAVAILABLE_MESSAGE,
  MISCONFIGURED_MESSAGE,
  NOT_AUTHORIZED_MESSAGE,
  NO_IDENTITY,
  TOOL_UNAVAILABLE_MESSAGE,
  runTool,
  validationErrorText,
} from '../../src/mcp/dispatch';
import type { CanvasClientDeps, DispatchDeps } from '../../src/mcp/dispatch';
import type {
  CanvasClient,
  CanvasCredential,
  Config,
  CredentialProvider,
  CredentialResult,
  DiagnosticsAccess,
  Env,
  Identity,
  ParamSpecs,
  ToolContext,
  ToolDef,
  ToolOutput,
  TruncationReason,
} from '../../src/types';

const TOKEN = `7~${'Tk9'.repeat(14)}`;
const SALT = 'pseudonym-salt-value';

const BASE_ENV: Env = {
  CANVAS_API_URL: 'https://canvas.example.edu',
  CANVAS_API_TOKEN: TOKEN,
  OWNER_EMAIL: 'owner@example.edu',
};

const OWNER: Identity = {
  key: 'id:user-123',
  userId: 'user-123',
  email: 'owner@example.edu',
  fullName: 'Olive Owner',
  source: 'sites-gateway',
};

const CREDENTIAL: CanvasCredential = {
  apiBaseUrl: 'https://canvas.example.edu/api/v1',
  origin: 'https://canvas.example.edu',
  token: TOKEN,
  callerId: 'caller-abc',
  kind: 'owner-secret',
};

type Truncation = { label: string; reason: TruncationReason; disclosed: boolean };

function fakeClient(truncations: Truncation[] = []): CanvasClient {
  return {
    truncations,
    caller: { origin: CREDENTIAL.origin, callerId: CREDENTIAL.callerId, kind: CREDENTIAL.kind },
  } as unknown as CanvasClient;
}

function ownerProvider(overrides: Partial<CredentialProvider> = {}): CredentialProvider & { resolved: number } {
  const provider = {
    mode: 'owner' as const,
    resolved: 0,
    authorize(identity: Identity | null) {
      return identity !== null && identity.email === 'owner@example.edu'
        ? ({ ok: true } as const)
        : ({ ok: false, status: 403, publicMessage: 'This Site is private to its owner.' } as const);
    },
    async resolve(identity: Identity | null): Promise<CredentialResult> {
      provider.resolved += 1;
      const allowed = provider.authorize(identity);
      if (!allowed.ok) return { ok: false, reason: 'forbidden', publicMessage: allowed.publicMessage };
      return { ok: true, credential: CREDENTIAL };
    },
    ...overrides,
  };
  return provider;
}

interface Harness {
  deps: DispatchDeps;
  lines: Array<Record<string, unknown>>;
  rawLog: string[];
  clientDeps: CanvasClientDeps[];
  provider: ReturnType<typeof ownerProvider>;
  clock: { now: number };
}

interface HarnessOptions {
  env?: Env;
  identity?: Identity | null;
  provider?: ReturnType<typeof ownerProvider>;
  client?: CanvasClient;
  createClient?: (deps: CanvasClientDeps) => CanvasClient;
  diagnostics?: DiagnosticsAccess;
  secrets?: string[];
}

function harness(options: HarnessOptions = {}): Harness {
  const config: Config = parseConfig({ ...BASE_ENV, ...options.env });
  const rawLog: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  const secrets = options.secrets ?? [TOKEN, SALT];
  const log = createLogger({
    level: 'debug',
    redactPii: true,
    secrets,
    sink: (line) => {
      rawLog.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const clientDeps: CanvasClientDeps[] = [];
  const provider = options.provider ?? ownerProvider();
  const clock = { now: 1_700_000_000_000 };
  const deps: DispatchDeps = {
    config,
    identity: options.identity === undefined ? OWNER : options.identity,
    credentials: provider,
    createClient:
      options.createClient ??
      ((given) => {
        clientDeps.push(given);
        return options.client ?? fakeClient();
      }),
    log,
    requestId: 'req-1',
    pseudonymSalt: SALT,
    secretsToRedact: secrets,
    registeredTools: [
      { name: 'list_courses', title: 'List', description: 'd', module: 'courses', role: 'shared', effect: 'read' },
    ],
    ...(options.diagnostics !== undefined && { diagnostics: options.diagnostics }),
    now: () => clock.now,
  };
  return { deps, lines, rawLog, clientDeps, provider, clock };
}

interface Recorded {
  calls: number;
  args: unknown;
  ctx: ToolContext | null;
}

function toolWith<P extends ParamSpecs>(
  params: P,
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput,
  overrides: Partial<ToolDef> = {},
): { def: ToolDef; seen: Recorded } {
  const seen: Recorded = { calls: 0, args: undefined, ctx: null };
  const def: ToolDef = {
    name: 'list_courses',
    title: 'List courses',
    description: 'List courses.',
    module: 'courses',
    role: 'shared',
    effect: 'read',
    params,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    budget: { tier: 'S' },
    fencing: 'safe',
    handler: async (args, ctx) => {
      seen.calls += 1;
      seen.args = args;
      seen.ctx = ctx;
      return handler(args as Record<string, unknown>, ctx);
    },
    ...overrides,
  };
  return { def, seen };
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((block) => block.text).join('');
}

function events(h: Harness, event: string): Array<Record<string, unknown>> {
  return h.lines.filter((line) => line.event === event);
}

describe('runTool: happy path', () => {
  it('runs the handler and returns its text as one block', async () => {
    const h = harness();
    const { def, seen } = toolWith({}, () => 'Courses:\n- Biology');
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Courses:\n- Biology' }], isError: false });
    expect(seen.calls).toBe(1);
  });

  it('returns an object as JSON text plus structuredContent', async () => {
    const h = harness();
    const { def } = toolWith({}, () => ({ success: true, count: 2 }));
    const result = await runTool(def, undefined, h.deps);
    expect(result.structuredContent).toEqual({ success: true, count: 2 });
    expect(textOf(result)).toBe('{"success":true,"count":2}');
    expect(result.isError).toBe(false);
  });

  it('marks a dict with a top-level error as an error', async () => {
    const h = harness();
    const { def } = toolWith({}, () => ({ error: 'HTTP error: 404, Details: not found' }));
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'HTTP error: 404, Details: not found' });
  });

  it('reduces object output to plain JSON data', async () => {
    const h = harness();
    const { def } = toolWith({}, () => ({ when: new Date(0), skip: undefined, nested: { n: 1 } }));
    const result = await runTool(def, {}, h.deps);
    expect(result.structuredContent).toEqual({ when: '1970-01-01T00:00:00.000Z', nested: { n: 1 } });
    expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
  });
});

describe('runTool: tool context', () => {
  it('gives the handler exactly the documented members: no env, no token, no secrets', async () => {
    const client = fakeClient();
    const h = harness({ client });
    const { def, seen } = toolWith({}, () => 'ok');
    await runTool(def, {}, h.deps);
    const ctx = seen.ctx as ToolContext;
    expect(Object.keys(ctx).sort()).toEqual(
      ['canvas', 'config', 'deadline', 'identity', 'log', 'registeredTools', 'requestId'].sort(),
    );
    expect(ctx.canvas).toBe(client);
    expect(ctx.identity).toBe(OWNER);
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.registeredTools).toBe(h.deps.registeredTools);
    expect(ctx.diagnostics).toBeUndefined();
    expect(Object.isFrozen(ctx)).toBe(true);
    const flat = JSON.stringify(ctx);
    expect(flat).not.toContain(TOKEN);
    expect(flat).not.toContain(SALT);
  });

  it('passes the protocol era through when the backend knows it', async () => {
    const h = harness();
    const { def, seen } = toolWith({}, () => 'ok');
    await runTool(def, {}, { ...h.deps, protocolEra: 'modern' });
    expect(seen.ctx?.protocolEra).toBe('modern');
  });

  it('sets the deadline to now plus TOOL_DEADLINE_MS', async () => {
    const h = harness({ env: { TOOL_DEADLINE_MS: '9000' } });
    const { def, seen } = toolWith({}, () => 'ok');
    await runTool(def, {}, h.deps);
    expect(seen.ctx?.deadline).toBe(h.clock.now + 9000);
    expect(h.clientDeps[0]?.deadline).toBe(h.clock.now + 9000);
  });
});

describe('runTool: Canvas client construction', () => {
  it('hands the credential to the client factory and nowhere else', async () => {
    const h = harness();
    const { def } = toolWith({}, () => 'ok');
    await runTool(def, {}, h.deps);
    expect(h.clientDeps).toHaveLength(1);
    const given = h.clientDeps[0] as CanvasClientDeps;
    expect(given.credential).toBe(CREDENTIAL);
    expect(given.config).toStrictEqual(h.deps.config);
    expect(given.config).not.toBe(h.deps.config);
    expect(Object.isFrozen(given.config)).toBe(true);
    expect(given.pseudonymSalt).toBe(SALT);
    expect(given.allowRaw).toBe(false);
    expect(given.meter).toBeInstanceOf(SubrequestMeter);
    expect(h.rawLog.join('\n')).not.toContain(TOKEN);
  });

  it.each([
    ['S', undefined, undefined, 6],
    ['M', undefined, undefined, 20],
    ['L', undefined, undefined, 40],
    ['L', 12, undefined, 12],
    ['L', undefined, '10', 10],
    ['M', 18, '10', 10],
    ['L', undefined, '150', 40],
  ] as const)('budget for tier %s, requests %s, CANVAS_REQUEST_BUDGET %s is %i', async (tier, requests, budget, limit) => {
    const h = harness({ env: budget === undefined ? {} : { CANVAS_REQUEST_BUDGET: budget } });
    const { def } = toolWith({}, () => 'ok', {
      budget: requests === undefined ? { tier } : { tier, requests },
    });
    await runTool(def, {}, h.deps);
    expect(h.clientDeps[0]?.meter.limit).toBe(limit);
  });

  it('allows raw access only for a rawAccess tool on the pinned list', async () => {
    const granted = harness();
    await runTool(toolWith({}, () => 'ok', { name: 'check_enrollment', rawAccess: true }).def, {}, granted.deps);
    expect(granted.clientDeps[0]?.allowRaw).toBe(true);

    const notPinned = harness();
    await runTool(toolWith({}, () => 'ok', { name: 'list_users', rawAccess: true }).def, {}, notPinned.deps);
    expect(notPinned.clientDeps[0]?.allowRaw).toBe(false);

    const notAsked = harness();
    await runTool(toolWith({}, () => 'ok', { name: 'check_enrollment' }).def, {}, notAsked.deps);
    expect(notAsked.clientDeps[0]?.allowRaw).toBe(false);
  });

  it('turns a client factory failure into an error result', async () => {
    const h = harness({
      createClient: () => {
        throw new RangeError('bad base');
      },
    });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: RangeError');
    expect(seen.calls).toBe(0);
  });
});

describe('runTool: authorization', () => {
  it('refuses a call with no identity, using the provider\'s public message', async () => {
    const h = harness({ identity: null });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: This Site is private to its owner.' }],
      isError: true,
    });
    expect(seen.calls).toBe(0);
    expect(h.clientDeps).toHaveLength(0);
    expect(h.provider.resolved).toBe(0);
    expect(events(h, 'tool_call_denied')).toHaveLength(1);
  });

  it('refuses a non-owner identity', async () => {
    const h = harness({ identity: { ...OWNER, key: 'id:other', userId: 'other', email: 'mallory@example.edu' } });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: This Site is private to its owner.');
    expect(seen.calls).toBe(0);
  });

  it('fails closed when a provider approves a missing identity', async () => {
    const provider = ownerProvider({ authorize: () => ({ ok: true }) });
    const h = harness({ identity: null, provider });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe(NOT_AUTHORIZED_MESSAGE);
    expect(seen.calls).toBe(0);
    expect(h.clientDeps).toHaveLength(0);
  });

  it('reports a credential failure with the public message, never the reason or the configuration', async () => {
    const provider = ownerProvider({
      resolve: async () => ({ ok: false, reason: 'not_configured', publicMessage: 'Canvas is not connected yet.' }),
    });
    const h = harness({ provider });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Error: Canvas is not connected yet.' }], isError: true });
    expect(textOf(result)).not.toContain('not_configured');
    expect(seen.calls).toBe(0);
    expect(events(h, 'tool_call_denied')[0]?.reason).toBe('not_configured');
  });

  it('keeps an error prefix the provider already wrote', async () => {
    const provider = ownerProvider({
      resolve: async () => ({ ok: false, reason: 'not_configured', publicMessage: 'Error: Canvas credentials are unavailable.' }),
    });
    const result = await runTool(toolWith({}, () => 'ok').def, {}, harness({ provider }).deps);
    expect(textOf(result)).toBe('Error: Canvas credentials are unavailable.');
  });

  it('uses a fixed message when the provider throws', async () => {
    const provider = ownerProvider({
      resolve: async () => {
        throw new Error(`decrypt failed for ${TOKEN}`);
      },
    });
    const h = harness({ provider });
    const result = await runTool(toolWith({}, () => 'ok').def, {}, h.deps);
    expect(textOf(result)).toBe(CREDENTIALS_UNAVAILABLE_MESSAGE);
    expect(h.rawLog.join('\n')).not.toContain(TOKEN);
  });

  it('refuses every Canvas tool while the configuration has errors', async () => {
    const h = harness({ env: { CANVAS_ROLE: 'superuser' } });
    expect(h.deps.config.errors.length).toBeGreaterThan(0);
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe(MISCONFIGURED_MESSAGE);
    expect(result.isError).toBe(true);
    expect(seen.calls).toBe(0);
    expect(h.provider.resolved).toBe(0);
    // The message never carries the configuration detail.
    expect(textOf(result)).not.toContain('superuser');
  });
});

describe('runTool: argument coercion', () => {
  const params = {
    course_identifier: { kind: 'id', description: 'Course' },
    limit: { kind: 'int', default: 10, description: 'Limit' },
    include_concluded: { kind: 'bool', optional: true, description: 'Flag' },
  } as const;

  it('returns upstream\'s {"error": ...} text for a missing parameter, flagged as an error', async () => {
    const h = harness();
    const { def, seen } = toolWith(params, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"error": "Missing required parameter \'course_identifier\'"}' }],
      isError: true,
    });
    expect(result.structuredContent).toBeUndefined();
    expect(seen.calls).toBe(0);
  });

  it('returns the conversion error for a value of the wrong type', async () => {
    const h = harness();
    const { def } = toolWith(params, () => 'ok');
    const result = await runTool(def, { course_identifier: 1, limit: 'many' }, h.deps);
    expect(textOf(result)).toBe(
      '{"error": "Parameter \'limit\' with value \'many\' could not be converted to int"}',
    );
    expect(result.isError).toBe(true);
  });

  it('rejects unknown parameters and non-object arguments', async () => {
    const h = harness();
    const { def } = toolWith(params, () => 'ok');
    expect(textOf(await runTool(def, { course_identifier: 1, extra: true }, h.deps))).toBe(
      '{"error": "Unknown parameter \'extra\'"}',
    );
    expect(textOf(await runTool(def, 'not an object', h.deps))).toBe(
      '{"error": "Arguments must be an object (got string)"}',
    );
  });

  it('coerces lenient forms and applies defaults before the handler runs', async () => {
    const h = harness();
    const { def, seen } = toolWith(params, () => 'ok');
    await runTool(def, { course_identifier: 60366, limit: '25', include_concluded: 'yes' }, h.deps);
    expect(seen.args).toEqual({ course_identifier: '60366', limit: 25, include_concluded: true });
    await runTool(def, { course_identifier: 'BIO_101' }, h.deps);
    expect(seen.args).toEqual({ course_identifier: 'BIO_101', limit: 10 });
  });

  it('writes the error as Python json.dumps would', () => {
    expect(validationErrorText('plain')).toBe('{"error": "plain"}');
    expect(validationErrorText('say "hi"\n\\')).toBe('{"error": "say \\"hi\\"\\n\\\\"}');
    expect(validationErrorText('café \u{1F600}')).toBe('{"error": "caf\\u00e9 \\ud83d\\ude00"}');
    expect(JSON.parse(validationErrorText('café \u{1F600} \u007f'))).toEqual({ error: 'café \u{1F600} \u007f' });
    // json.dumps escapes DEL as well as everything above it (checked against CPython).
    expect(validationErrorText('a\u007fb')).toBe('{"error": "a\\u007fb"}');
  });

  it('checks credentials before arguments', async () => {
    const h = harness({ identity: null });
    const { def } = toolWith(params, () => 'ok');
    expect(textOf(await runTool(def, {}, h.deps))).toBe('Error: This Site is private to its owner.');
  });
});

describe('runTool: thrown errors', () => {
  it('reports the error class and a sanitized message; the stack goes to the log only', async () => {
    const h = harness();
    const { def } = toolWith({}, () => {
      throw new TypeError('cannot read course');
    });
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Error: TypeError: cannot read course' }], isError: true });
    expect(textOf(result)).not.toMatch(/\bat\b.*\.ts/);
    const logged = events(h, 'tool_error')[0] as Record<string, unknown>;
    expect(logged.tool).toBe('list_courses');
    expect(logged.error_name).toBe('TypeError');
    expect(String(logged.stack)).toMatch(/^at /);
  });

  it('does not repeat "Error" for a plain Error', async () => {
    const { def } = toolWith({}, () => {
      throw new Error('course lookup failed');
    });
    expect(textOf(await runTool(def, {}, harness().deps))).toBe('Error: course lookup failed');
  });

  it('drops the message of a SyntaxError, which quotes the text it could not parse', async () => {
    const h = harness();
    const { def } = toolWith({}, () => JSON.parse('Jane Roe <jane@example.edu>') as string);
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe('Error: SyntaxError');
    expect(h.rawLog.join('\n')).not.toContain('Jane');
  });

  it('redacts secrets from the message, bounds it and keeps the first line only', async () => {
    const h = harness();
    const { def } = toolWith({}, () => {
      throw new Error(`fetch https://canvas.example.edu/?access_token=${TOKEN} failed\nsecond line ${'x'.repeat(500)}`);
    });
    const text = textOf(await runTool(def, {}, h.deps));
    expect(text).toBe('Error: fetch https://canvas.example.edu/?access_token=[REDACTED] failed');
    expect(h.rawLog.join('\n')).not.toContain(TOKEN);

    const long = toolWith({}, () => {
      throw new Error('y'.repeat(5000));
    });
    expect(textOf(await runTool(long.def, {}, harness().deps)).length).toBeLessThanOrEqual('Error: '.length + 200);
  });

  it('handles thrown values that are not errors, and odd error names', async () => {
    const thrower = (value: unknown) =>
      toolWith({}, () => {
        throw value;
      }).def;
    expect(textOf(await runTool(thrower('a string'), {}, harness().deps))).toBe('Error: UnknownError');
    expect(textOf(await runTool(thrower(null), {}, harness().deps))).toBe('Error: UnknownError');
    const odd = new Error('message');
    odd.name = 'Bad Name <script>';
    expect(textOf(await runTool(thrower(odd), {}, harness().deps))).toBe('Error: message');
    expect(textOf(await runTool(thrower(new Error('')), {}, harness().deps))).toBe('Error: the tool failed');
  });

  it('reports a handler that returns nothing usable', async () => {
    const h = harness();
    const { def } = toolWith({}, () => undefined as unknown as string);
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: the tool returned no usable output.');
    const array = toolWith({}, () => [1, 2] as unknown as Record<string, unknown>);
    expect((await runTool(array.def, {}, harness().deps)).isError).toBe(true);
  });

  it('never throws, even when the output cannot be serialized', async () => {
    const h = harness();
    const { def } = toolWith({}, () => ({ big: 10n }) as unknown as Record<string, unknown>);
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: TypeError');
    expect(events(h, 'tool_call')).toHaveLength(1);
  });
});

describe('runTool: Canvas path errors thrown by tool code', () => {
  const courseParam = { course_identifier: { kind: 'string', description: 'Course' } } as const;

  it('turns a CanvasPathError from canvasId into an error result that does not echo the value', async () => {
    const h = harness();
    const { def } = toolWith(courseParam, (args) => `course ${canvasId(args.course_identifier)}`);
    const result = await runTool(def, { course_identifier: '../accounts/1' }, h.deps);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: CanvasPathError: Invalid Canvas ID: expected a numeric ID' }],
      isError: true,
    });
    expect(textOf(result)).not.toContain('accounts');
    const logged = events(h, 'tool_error')[0] as Record<string, unknown>;
    expect(logged.error_name).toBe('CanvasPathError');
    expect(h.rawLog.join('\n')).not.toContain('accounts');
    expect(events(h, 'tool_call')[0]?.isError).toBe(true);
  });

  it.each(['..', '.', '', 'a\u0000b', '\ud800'])('turns a CanvasPathError from canvasPath (%j) into an error result', async (segment) => {
    const h = harness();
    const { def } = toolWith(courseParam, (args) => canvasPath`/courses/1/pages/${args.course_identifier as string}`);
    const result = await runTool(def, { course_identifier: segment }, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: CanvasPathError: Invalid /);
    expect(events(h, 'tool_error')[0]?.error_name).toBe('CanvasPathError');
  });
});

describe('runTool: with the real Canvas client factory', () => {
  const ORIGIN = 'https://canvas.example.edu';
  const courseParam = { course_identifier: { kind: 'string', description: 'Course' } } as const;

  function courseTool(): { def: ToolDef; seen: Recorded } {
    return toolWith(courseParam, async (args, ctx) => {
      const course = await ctx.canvas.request<{ name: string }>(
        'get',
        canvasPath`/courses/${canvasId(args.course_identifier)}`,
      );
      return isFailure(course) ? `Error: ${course.error}` : `Course: ${course.name}`;
    });
  }

  it('accepts createCanvasClient as the factory and counts its requests in the tool_call line', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.route('GET', '/api/v1/courses/42', () => json({ id: 42, name: 'Biology 101' }));
    const h = harness({ createClient: createCanvasClient });
    h.deps.fetchImpl = fake.fetch;
    const { def, seen } = courseTool();
    const result = await runTool(def, { course_identifier: '42' }, h.deps);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Course: Biology 101' }], isError: false });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(`${ORIGIN}/api/v1/courses/42`);
    expect(fake.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.ctx?.canvas.caller).toEqual({ origin: ORIGIN, callerId: 'caller-abc', kind: 'owner-secret' });
    const line = events(h, 'tool_call')[0] as Record<string, unknown>;
    expect(line.canvas_requests).toBe(1);
    expect(line.subrequests).toBe(1);
    expect(line.isError).toBe(false);
    expect(h.rawLog.join('\n')).not.toContain(TOKEN);
  });

  it('sends nothing to Canvas when the tool builds an invalid path', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    const h = harness({ createClient: createCanvasClient });
    h.deps.fetchImpl = fake.fetch;
    const { def } = courseTool();
    const result = await runTool(def, { course_identifier: '42/../../accounts/self' }, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: CanvasPathError: Invalid Canvas ID: expected a numeric ID');
    expect(fake.calls).toHaveLength(0);
    expect(events(h, 'tool_call')[0]?.canvas_requests).toBe(0);
  });

  it('gives the client the smaller of the tool budget and CANVAS_REQUEST_BUDGET', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    fake.route('GET', /^\/api\/v1\/courses\/\d+$/, () => json({ name: 'x' }));
    const h = harness({ createClient: createCanvasClient });
    h.deps.fetchImpl = fake.fetch;
    const { def, seen } = toolWith(
      {},
      async (_args, ctx) => {
        const answers: string[] = [];
        for (let id = 1; id <= 4; id += 1) {
          const got = await ctx.canvas.request('get', canvasPath`/courses/${id}`);
          answers.push(isFailure(got) ? 'refused' : 'ok');
        }
        return answers.join(',');
      },
      { budget: { tier: 'S', requests: 3 } },
    );
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe('ok,ok,ok,refused');
    expect(fake.calls).toHaveLength(3);
    expect(seen.ctx?.canvas.budget.limit).toBe(3);
    expect(events(h, 'tool_call')[0]?.budget).toBe(3);
  });
});

describe('runTool: undisclosed truncation', () => {
  const partial: Truncation = { label: 'assignments', reason: 'max_pages', disclosed: false };

  it('appends the standard notice to text output', async () => {
    const h = harness({ client: fakeClient([partial]) });
    const { def } = toolWith({}, () => 'Assignments:\n- Essay');
    const text = textOf(await runTool(def, {}, h.deps));
    expect(text.startsWith('Assignments:\n- Essay\n\n⚠️ Results truncated: the list of assignments is incomplete')).toBe(true);
  });

  it('adds "truncated": true to object output, in the text and the structured content', async () => {
    const h = harness({ client: fakeClient([partial]) });
    const { def } = toolWith({}, () => ({ items: ['Essay'] }));
    const result = await runTool(def, {}, h.deps);
    expect(result.structuredContent).toEqual({ items: ['Essay'], truncated: true });
    expect(JSON.parse(textOf(result))).toEqual({ items: ['Essay'], truncated: true });
  });

  it('adds nothing when the tool disclosed the truncation itself', async () => {
    const h = harness({ client: fakeClient([{ ...partial, disclosed: true }]) });
    const { def } = toolWith({}, () => 'Assignments:\n- Essay');
    expect(textOf(await runTool(def, {}, h.deps))).toBe('Assignments:\n- Essay');
    expect(events(h, 'tool_call')[0]?.truncated).toBe(true);
  });

  it('logs truncated: false for a complete result', async () => {
    const h = harness();
    await runTool(toolWith({}, () => 'ok').def, {}, h.deps);
    expect(events(h, 'tool_call')[0]?.truncated).toBe(false);
  });
});

describe('runTool: size limit', () => {
  it('cuts oversized text, closes an open fence and flags the call as truncated', async () => {
    const h = harness({ env: { MAX_TOOL_RESULT_BYTES: '3000' } });
    const body = Array.from({ length: 300 }, (_, i) => `paragraph ${i} ${'lorem '.repeat(8)}`).join('\n');
    const { def } = toolWith({}, () => `Page\n${fenceUntrusted(body, 'page body')}`);
    const result = await runTool(def, {}, h.deps);
    const text = textOf(result);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(3000);
    expect(text.indexOf(FENCE_TEXT_END)).toBeGreaterThan(0);
    expect(text.indexOf('Output truncated')).toBeGreaterThan(text.indexOf(FENCE_TEXT_END));
    expect(result.isError).toBe(false);
    expect(events(h, 'tool_call')[0]?.truncated).toBe(true);
  });

  it('refuses oversized JSON instead of cutting it', async () => {
    const h = harness({ env: { MAX_TOOL_RESULT_BYTES: '500' } });
    const { def } = toolWith({}, () => ({ rows: Array.from({ length: 100 }, (_, i) => `row ${i}`) }));
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/^Error: the result is too large to return/);
  });

  it('does not let a secret that straddles the cut escape in part', async () => {
    const maxBytes = 1200;
    for (let padding = 700; padding < 1100; padding += 7) {
      const h = harness({ env: { MAX_TOOL_RESULT_BYTES: String(maxBytes) } });
      const { def } = toolWith({}, () => `${'a'.repeat(padding)}${TOKEN}${'b'.repeat(2000)}`);
      const text = textOf(await runTool(def, {}, h.deps));
      expect(text).not.toContain(TOKEN.slice(0, 12));
    }
  });
});

describe('runTool: secret redaction', () => {
  it('removes secrets, raw and URL-encoded, from text output and logs a security event', async () => {
    const h = harness();
    const { def } = toolWith({}, () => `token=${TOKEN} encoded=${encodeURIComponent(TOKEN).replace(/~/g, '%7E')} salt=${SALT}`);
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe('token=[REDACTED] encoded=[REDACTED] salt=[REDACTED]');
    const security = events(h, 'secret_redacted_from_tool_output');
    expect(security).toHaveLength(1);
    expect(security[0]?.level).toBe('security');
    expect(security[0]?.tool).toBe('list_courses');
    expect(h.rawLog.join('\n')).not.toContain(TOKEN);
  });

  it('removes secrets from structured content, keys included', async () => {
    const h = harness();
    const { def } = toolWith({}, () => ({
      url: `https://canvas.example.edu/files/1?access_token=${TOKEN}`,
      nested: [{ note: `salt ${SALT}` }],
      [TOKEN]: 'as a key',
      count: 3,
    }));
    const result = await runTool(def, {}, h.deps);
    expect(result.structuredContent).toEqual({
      url: 'https://canvas.example.edu/files/1?access_token=[REDACTED]',
      nested: [{ note: 'salt [REDACTED]' }],
      '[REDACTED]': 'as a key',
      count: 3,
    });
    const text = textOf(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SALT);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(events(h, 'secret_redacted_from_tool_output')).toHaveLength(1);
  });

  it('redacts a secret echoed back through a validation error', async () => {
    const h = harness();
    const { def } = toolWith({ limit: { kind: 'int', description: 'Limit' } }, () => 'ok');
    const text = textOf(await runTool(def, { limit: TOKEN }, h.deps));
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTED]');
  });

  it('takes the list from secretValuesForRedaction as given, including values parseSecrets rejects', async () => {
    // A confirmation secret under 32 characters is rejected as a secret, yet it is still a secret value.
    const env: Env = { ...BASE_ENV, CONFIRMATION_SECRET: 'too-short-secret', PSEUDONYM_SALT: SALT };
    expect(parseSecrets(env).confirmationSecret).toBeNull();
    const secrets = secretValuesForRedaction(env);
    expect(secrets).toEqual([TOKEN, 'too-short-secret', SALT]);
    const before = [...secrets];

    const h = harness({ env, secrets });
    expect(h.deps.secretsToRedact).toBe(secrets);
    const { def } = toolWith({}, () => ({
      text: `confirm=too-short-secret token=${TOKEN}`,
      form: new URLSearchParams({ access_token: TOKEN }).toString(),
    }));
    const result = await runTool(def, {}, h.deps);
    expect(result.structuredContent).toEqual({
      text: 'confirm=[REDACTED] token=[REDACTED]',
      form: 'access_token=[REDACTED]',
    });
    expect(textOf(result)).not.toContain('too-short-secret');
    expect(textOf(result)).not.toContain(TOKEN);
    // The list is read, never filtered, reordered or extended.
    expect(secrets).toEqual(before);
    expect(events(h, 'secret_redacted_from_tool_output')).toHaveLength(1);
  });

  it('works with a frozen list and with an empty one', async () => {
    const frozen = harness({ secrets: Object.freeze([TOKEN]) as unknown as string[] });
    const leaky = toolWith({}, () => `t=${TOKEN}`);
    expect(textOf(await runTool(leaky.def, {}, frozen.deps))).toBe('t=[REDACTED]');

    const none = harness({ secrets: [] });
    expect(textOf(await runTool(toolWith({}, () => 'plain text').def, {}, none.deps))).toBe('plain text');
    expect(events(none, 'secret_redacted_from_tool_output')).toHaveLength(0);
  });

  it('logs no security event when nothing was redacted', async () => {
    const h = harness();
    await runTool(toolWith({}, () => 'clean output').def, {}, h.deps);
    expect(events(h, 'secret_redacted_from_tool_output')).toHaveLength(0);
  });
});

describe('runTool: logging', () => {
  it('writes one tool_call line with the tool, effect, outcome, time, counts and truncation', async () => {
    const h = harness();
    const { def } = toolWith({ q: { kind: 'string', description: 'Query' } }, (_args, ctx) => {
      const meter = h.clientDeps[0]?.meter as SubrequestMeter;
      meter.take('canvas', 3);
      meter.take('d1', 1);
      h.clock.now += 42;
      return ctx.requestId;
    });
    await runTool(def, { q: 'private search words' }, h.deps);
    const calls = events(h, 'tool_call');
    expect(calls).toHaveLength(1);
    const { timestamp, ...line } = calls[0] as Record<string, unknown>;
    expect(typeof timestamp).toBe('string');
    expect(line).toEqual({
      level: 'info',
      event: 'tool_call',
      tool: 'list_courses',
      effect: 'read',
      isError: false,
      ms: 42,
      subrequests: 4,
      budget: 6,
      canvas_requests: 3,
      d1_calls: 1,
      r2_calls: 0,
      truncated: false,
    });
  });

  it('never logs arguments or output', async () => {
    const h = harness();
    const { def } = toolWith({ q: { kind: 'string', description: 'Query' } }, () => 'Grade for Jane Roe: 91');
    await runTool(def, { q: 'private search words' }, h.deps);
    const all = h.rawLog.join('\n');
    expect(all).not.toContain('private search words');
    expect(all).not.toContain('Jane Roe');
  });

  it('logs a denied call as an error outcome with zero counts', async () => {
    const h = harness({ identity: null });
    await runTool(toolWith({}, () => 'ok').def, {}, h.deps);
    const line = events(h, 'tool_call')[0] as Record<string, unknown>;
    expect(line.isError).toBe(true);
    expect(line.subrequests).toBe(0);
    expect(line.budget).toBe(0);
  });
});

describe('runTool: diagnostics tools', () => {
  const DIAGNOSTICS_ENV: Env = { CANVAS_API_URL: '', CANVAS_API_TOKEN: '', OWNER_EMAIL: '', DIAGNOSTICS_ENABLED: 'true' };
  const access: DiagnosticsAccess = {
    headerSummary: () => [],
    authorizationShape: () => ({ present: false }),
    bindingNames: () => ['DB'],
    ctxPropKeys: () => [],
    probeFetch: async (count) => ({ attempted: count, succeeded: count }),
    probeD1: async (count) => ({ attempted: count, succeeded: count }),
  };
  const untouchable = ownerProvider({
    authorize: () => {
      throw new Error('authorize must not be called');
    },
    resolve: async () => {
      throw new Error('resolve must not be called');
    },
  });

  function diagnosticsTool(handler: (ctx: ToolContext) => ToolOutput): { def: ToolDef; seen: Recorded } {
    return toolWith({}, (_args, ctx) => handler(ctx), { name: 'hello', gate: { diagnostics: true } });
  }

  it('run with no identity, no credential and a configuration that blocks invocation', async () => {
    const h = harness({ env: DIAGNOSTICS_ENV, identity: null, provider: untouchable, diagnostics: access });
    expect(h.deps.config.diagnosticsEnabled).toBe(true);
    expect(h.deps.config.errors.length).toBeGreaterThan(0);
    const { def, seen } = diagnosticsTool((ctx) => `bindings: ${ctx.diagnostics?.bindingNames().join(',')}`);
    const result = await runTool(def, {}, h.deps);
    expect(result).toEqual({ content: [{ type: 'text', text: 'bindings: DB' }], isError: false });
    expect(h.clientDeps).toHaveLength(0);
    expect(seen.ctx?.identity).toBe(NO_IDENTITY);
    expect(seen.ctx?.diagnostics).toBe(access);
  });

  it('see the real identity when the request carried one', async () => {
    const h = harness({ env: DIAGNOSTICS_ENV, provider: untouchable, diagnostics: access });
    const { def, seen } = diagnosticsTool(() => 'ok');
    await runTool(def, {}, h.deps);
    expect(seen.ctx?.identity).toBe(OWNER);
  });

  it('get a context whose canvas member throws a clear error', async () => {
    const h = harness({ env: DIAGNOSTICS_ENV, identity: null, provider: untouchable, diagnostics: access });
    const { def, seen } = diagnosticsTool((ctx) => String(ctx.canvas.budget.remaining));
    const result = await runTool(def, {}, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: Diagnostics tools have no Canvas client and no Canvas credential.');
    const ctx = seen.ctx as ToolContext;
    expect(Object.keys(ctx)).not.toContain('canvas');
    expect(() => JSON.stringify(ctx)).not.toThrow();
    expect(() => ({ ...ctx })).not.toThrow();
  });

  it('are refused when diagnostics mode is off, even if one reaches the dispatcher', async () => {
    const h = harness({ diagnostics: access });
    const { def, seen } = diagnosticsTool(() => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe(TOOL_UNAVAILABLE_MESSAGE);
    expect(result.isError).toBe(true);
    expect(seen.calls).toBe(0);
    expect(events(h, 'tool_call_refused')).toHaveLength(1);
  });

  it('are the only tools that run in diagnostics mode, and the only ones given diagnostics access', async () => {
    const h = harness({ env: DIAGNOSTICS_ENV, diagnostics: access });
    const { def, seen } = toolWith({}, () => 'ok');
    const result = await runTool(def, {}, h.deps);
    expect(textOf(result)).toBe(TOOL_UNAVAILABLE_MESSAGE);
    expect(seen.calls).toBe(0);

    const normal = harness({ diagnostics: access });
    const canvasTool = toolWith({}, () => 'ok');
    await runTool(canvasTool.def, {}, normal.deps);
    expect(canvasTool.seen.ctx?.diagnostics).toBeUndefined();
  });
});
