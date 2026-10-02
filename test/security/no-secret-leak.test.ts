// A whole session with recognisable secrets, after which no response body, response header or log line may
// contain any of them. Extends upstream tests/security/test_authentication.py (token not in logs, token not in
// error messages) from the token to every secret-class value, and from two call sites to the full request path.
import { describe, expect, it, vi } from 'vitest';
import type { Env, ToolDef } from '../../src/types';
import { createFakeCanvas, json } from '../helpers/fake-canvas';

// Each secret carries an alphanumeric canary that survives every encoding, so a
// leak in any form (raw, percent-encoded, JSON-escaped, HTML-escaped, cut in half
// past the canary) is caught by one substring search.
const SECRETS = vi.hoisted(() => ({
  token: '7~LEAKCANARYTOKENq7Jx2mVb9RkT4pWz8sHc3nYd6fGa1',
  confirmation: 'conf secret+/=&?# LEAKCANARYCONFIRM 0123456789',
  salt: 'salt "quoted" <b>&\' LEAKCANARYSALT /+=',
}));

vi.mock('../../src/tools/index', async () => {
  const { defineTool } = await import('../../src/mcp/define-tool');
  const { canvasPath } = await import('../../src/canvas/path');
  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const all = [SECRETS.token, SECRETS.confirmation, SECRETS.salt];
  const everyForm = all
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams([['v', secret]]).toString(),
      JSON.stringify(secret),
      `https://canvas.example.edu/api/v1/courses?access_token=${encodeURIComponent(secret)}`,
    ])
    .join('\n');

  const common = { role: 'shared', effect: 'read', annotations: READ, budget: { tier: 'S' }, fencing: 'safe' } as const;
  const tools: ToolDef[] = [
    // Canvas answers with the Authorization header echoed back; the tool passes the failure on.
    defineTool({
      ...common,
      name: 'get_my_profile',
      title: 'Echoing Canvas failure',
      description: 'Calls Canvas, which fails and echoes the credential.',
      module: 'self_identity',
      params: {},
      handler: async (_args, ctx) => {
        const result = await ctx.canvas.request('get', canvasPath`/users/self/profile`);
        return `Error: ${JSON.stringify(result)}`;
      },
    }) as ToolDef,
    // The tool returns every secret in every form, as text.
    defineTool({
      ...common,
      name: 'list_courses',
      title: 'Leaks as text',
      description: 'Returns the secrets as text.',
      module: 'courses',
      params: { pad: { kind: 'int', default: 0, description: 'Filler before the secrets' } },
      handler: async (args) => `${'x'.repeat(args.pad)}\n${everyForm}`,
    }) as ToolDef,
    // The tool returns the secrets as object values and as object keys.
    defineTool({
      ...common,
      name: 'list_conversations',
      title: 'Leaks as an object',
      description: 'Returns the secrets inside an object.',
      module: 'messaging',
      params: {},
      handler: async () => ({
        values: all,
        nested: { deep: [{ token: SECRETS.token, url: `https://x.example/?t=${encodeURIComponent(SECRETS.token)}` }] },
        [SECRETS.salt]: 'key',
        [`prefix-${SECRETS.confirmation}`]: SECRETS.confirmation,
      }),
    }) as ToolDef,
    // The tool throws, with the secrets in the error's message, name and stack.
    defineTool({
      ...common,
      name: 'get_course_details',
      title: 'Throws with secrets',
      description: 'Throws an error that quotes the secrets.',
      module: 'courses',
      params: { course_identifier: { kind: 'id', description: 'Course' } },
      handler: async () => {
        const error = new Error(`request to https://canvas.example.edu failed with token ${all.join(' | ')}`);
        error.name = `Leak${SECRETS.token}`;
        error.stack = `Error: ${all.join(' ')}\n    at handler (file:///${encodeURIComponent(SECRETS.confirmation)}.ts:1:1)`;
        throw error;
      },
    }) as ToolDef,
    // The tool logs the secrets itself.
    defineTool({
      ...common,
      name: 'get_syllabus',
      title: 'Logs secrets',
      description: 'Writes the secrets to the log.',
      module: 'courses',
      params: {},
      handler: async (_args, ctx) => {
        ctx.log.error(`event ${SECRETS.salt}`, { token: SECRETS.token, nested: { list: all }, [SECRETS.confirmation]: 1 });
        ctx.log.security('note', { error: new Error(all.join(' ')) });
        return 'logged';
      },
    }) as ToolDef,
  ];
  return { ALL_TOOLS: tools };
});

const { createApp } = await import('../../src/app');

const SITE = 'https://site.example';
const CANVAS = 'https://canvas.example.edu';
const OWNER_EMAIL = 'owner@example.edu';
const CANARIES = ['LEAKCANARYTOKEN', 'LEAKCANARYCONFIRM', 'LEAKCANARYSALT'];

const BASE_ENV: Env = {
  CANVAS_API_URL: CANVAS,
  CANVAS_API_TOKEN: SECRETS.token,
  OWNER_EMAIL,
  CONFIRMATION_SECRET: SECRETS.confirmation,
  PSEUDONYM_SALT: SECRETS.salt,
  LOG_LEVEL: 'debug',
};

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const OWNER_HEADERS = { 'oai-authenticated-user-id': 'user-0f9a77', 'oai-authenticated-user-email': OWNER_EMAIL };
const STRANGER_HEADERS = { 'oai-authenticated-user-id': 'user-222', 'oai-authenticated-user-email': 'visitor@example.org' };
const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } };

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' },
};

function percentEncodeStrict(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Every way a secret could be written into a response or a log line. */
function formsOf(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    percentEncodeStrict(secret),
    new URLSearchParams([['', secret]]).toString().slice(1),
    JSON.stringify(secret).slice(1, -1),
    escapeHtml(secret),
  ];
}

const FORBIDDEN: string[] = [...CANARIES, ...Object.values(SECRETS).flatMap(formsOf)];

interface Captured {
  where: string;
  text: string;
}

interface Session {
  captured: Captured[];
  logLines: string[];
  canvasSawToken(): boolean;
  request(label: string, request: Request, env?: Env): Promise<{ status: number; text: string }>;
  mcp(label: string, body: unknown, headers?: Record<string, string>, env?: Env): Promise<{ status: number; text: string }>;
}

function session(backend: string): Session {
  const fake = createFakeCanvas({ origin: CANVAS });
  // Canvas (or a proxy in front of it) echoing the credential back is the worst case for a client error message.
  fake.route('GET', /^\/api\/v1\//, (request) =>
    json(
      { errors: [{ message: `Invalid access token: ${request.headers.authorization ?? ''}` }], token: SECRETS.token },
      { status: request.parsed.pathname.endsWith('/users/self') ? 401 : 500 },
    ),
  );
  const logLines: string[] = [];
  const captured: Captured[] = [];
  const app = createApp({ fetchImpl: fake.fetch, logSink: (line) => logLines.push(line) });

  const request = async (label: string, req: Request, env: Env = {}): Promise<{ status: number; text: string }> => {
    const response = await app.fetch(req, { ...BASE_ENV, MCP_BACKEND: backend, ...env });
    const text = await response.text();
    captured.push({ where: `${label}: body`, text });
    captured.push({ where: `${label}: status text`, text: response.statusText });
    response.headers.forEach((value, name) => {
      captured.push({ where: `${label}: header ${name}`, text: `${name}: ${value}` });
    });
    return { status: response.status, text };
  };

  return {
    captured,
    logLines,
    canvasSawToken: () => fake.calls.some((call) => call.headers.authorization === `Bearer ${SECRETS.token}`),
    request,
    mcp: (label, body, headers = OWNER_HEADERS, env = {}) =>
      request(
        label,
        new Request(`${SITE}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }),
        env,
      ),
  };
}

function rpc(method: string, params?: unknown, id: string | number = 1): Record<string, unknown> {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

function call(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return rpc('tools/call', { name, arguments: args });
}

function expectClean(s: Session): void {
  expect(s.captured.length).toBeGreaterThan(0);
  for (const item of s.captured) {
    for (const forbidden of FORBIDDEN) {
      if (item.text.includes(forbidden)) {
        throw new Error(`secret material (${forbidden.slice(0, 6)}...) found in ${item.where}`);
      }
    }
  }
  for (const [index, line] of s.logLines.entries()) {
    for (const forbidden of FORBIDDEN) {
      if (line.includes(forbidden)) {
        throw new Error(`secret material (${forbidden.slice(0, 6)}...) found in log line ${index}: ${JSON.parse(line).event}`);
      }
    }
  }
}

describe('the leak detector itself', () => {
  it('would see a secret in each of its forms', () => {
    for (const secret of Object.values(SECRETS)) {
      for (const form of formsOf(secret)) {
        expect(CANARIES.some((canary) => form.includes(canary))).toBe(true);
      }
    }
    const s = session('native');
    s.captured.push({ where: 'planted', text: `x ${encodeURIComponent(SECRETS.confirmation)} y` });
    expect(() => expectClean(s)).toThrow(/secret material/);
    const t = session('native');
    t.captured.push({ where: 'ok', text: 'nothing here' });
    t.logLines.push(JSON.stringify({ event: 'planted', value: SECRETS.salt }));
    expect(() => expectClean(t)).toThrow(/log line 0: planted/);
  });
});

describe.each(['native', 'sdk'])('no secret leaves the Worker (%s backend)', (backend) => {
  it('status page and status API, as the owner and as a stranger', async () => {
    const s = session(backend);
    for (const [who, headers] of [['owner', OWNER_HEADERS], ['stranger', STRANGER_HEADERS], ['anonymous', {}]] as const) {
      for (const path of ['/', '/api/status', '/healthz', '/robots.txt', '/nope']) {
        const reply = await s.request(`${who} GET ${path}`, new Request(`${SITE}${path}`, { headers }));
        expect(reply.status).toBe(path === '/nope' ? 404 : 200);
      }
    }
    const owner = s.captured.find((item) => item.where === 'owner GET /: body');
    expect(owner?.text).toContain('CANVAS_API_TOKEN');
    expect(owner?.text).toContain('canvas.example.edu');
    expectClean(s);
  });

  it('the Canvas check, when Canvas echoes the token in its error', async () => {
    const s = session(backend);
    const reply = await s.request(
      'status check',
      new Request(`${SITE}/api/status/check`, { method: 'POST', headers: { ...OWNER_HEADERS, origin: SITE } }),
    );
    expect(JSON.parse(reply.text)).toEqual({ ok: false, status: 401 });
    expect(s.canvasSawToken()).toBe(true);
    expectClean(s);
  });

  it('discovery', async () => {
    const s = session(backend);
    expect((await s.mcp('initialize', rpc('initialize', INIT_PARAMS))).status).toBe(200);
    const list = await s.mcp('tools/list', rpc('tools/list'));
    expect(JSON.parse(list.text).result.tools).toHaveLength(5);
    expectClean(s);
  });

  it('a tool call that fails because Canvas refuses, with the token echoed in the Canvas error', async () => {
    const s = session(backend);
    const reply = await s.mcp('failing call', call('get_my_profile'));
    const result = JSON.parse(reply.text).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP error: 500');
    expect(result.content[0].text).toContain('[REDACTED]');
    expect(s.canvasSawToken()).toBe(true);
    expectClean(s);
  });

  it('a tool that returns the secrets as text, at every truncation point', async () => {
    const s = session(backend);
    const full = await s.mcp('text leak', call('list_courses'));
    expect(JSON.parse(full.text).result.content[0].text).toContain('[REDACTED]');
    // Move the size limit across the secrets so that a cut would fall inside each of them.
    for (let pad = 0; pad < 400; pad += 7) {
      await s.mcp(`text leak pad ${pad}`, call('list_courses', { pad }), OWNER_HEADERS, { MAX_TOOL_RESULT_BYTES: '420' });
    }
    expectClean(s);
  });

  it('a tool that returns the secrets in an object, as values and as keys', async () => {
    const s = session(backend);
    const reply = await s.mcp('object leak', call('list_conversations'));
    const result = JSON.parse(reply.text).result;
    expect(result.structuredContent.values).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
    expect(Object.keys(result.structuredContent)).toContain('[REDACTED]');
    expectClean(s);
  });

  it('a tool that throws an error quoting the secrets', async () => {
    const s = session(backend);
    const reply = await s.mcp('throwing call', call('get_course_details', { course_identifier: '1' }));
    const result = JSON.parse(reply.text).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Error: /);
    expect(s.logLines.some((line) => line.includes('"event":"tool_error"'))).toBe(true);
    expectClean(s);
  });

  it('a tool that writes the secrets to the log', async () => {
    const s = session(backend);
    await s.mcp('logging call', call('get_syllabus'));
    expect(s.logLines.filter((line) => line.includes('[REDACTED]')).length).toBeGreaterThanOrEqual(2);
    expectClean(s);
  });

  it('argument errors, unknown tools and unknown methods', async () => {
    const s = session(backend);
    await s.mcp('bad argument', call('list_courses', { pad: 'many' }));
    await s.mcp('unknown argument', call('list_courses', { nope: 1 }));
    await s.mcp('unknown tool', call('no_such_tool'));
    await s.mcp('unknown method', rpc('resources/list'));
    await s.mcp('batch', [rpc('tools/list')]);
    await s.request(
      'not json',
      new Request(`${SITE}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...OWNER_HEADERS }, body: '{"jsonrpc":' }),
    );
    expectClean(s);
  });

  it('denials', async () => {
    const s = session(backend);
    expect((await s.mcp('stranger', call('list_courses'), STRANGER_HEADERS)).status).toBe(403);
    expect((await s.mcp('anonymous', call('list_courses'), {})).status).toBe(403);
    expect((await s.mcp('bypass token', call('list_courses'), { ...OWNER_HEADERS, 'oai-sites-authorization': 'bypass' })).status).toBe(403);
    expect((await s.mcp('browser', call('list_courses'), { ...OWNER_HEADERS, origin: SITE })).status).toBe(403);
    expect((await s.request('GET /mcp', new Request(`${SITE}/mcp`, { headers: OWNER_HEADERS }))).status).toBe(405);
    expectClean(s);
  });

  it.each([
    ['the token as userinfo of the Canvas URL', { CANVAS_API_URL: `https://user:${SECRETS.token}@canvas.example.edu` }],
    ['the token in the query of an http Canvas URL', { CANVAS_API_URL: `http://canvas.example.edu/?access_token=${SECRETS.token}` }],
    ['the token as the Canvas host', { CANVAS_API_URL: `https://${SECRETS.token}` }],
    ['the token as the whole Canvas URL', { CANVAS_API_URL: SECRETS.token }],
    ['the salt as the role', { CANVAS_ROLE: SECRETS.salt }],
    ['the token as the auth mode', { AUTH_MODE: SECRETS.token }],
    ['the confirmation secret in the write allowlist', { ALLOWED_WRITE_TOOLS: SECRETS.confirmation }],
    ['the token in the write allowlist', { ALLOWED_WRITE_TOOLS: `send_conversation,${SECRETS.token}` }],
    ['the token as the owner id hash', { OWNER_USER_ID_SHA256: SECRETS.token }],
    ['a token that cannot be sent in a header', { CANVAS_API_TOKEN: `${SECRETS.token} with spaces` }],
    ['a short confirmation secret next to diagnostics', { DIAGNOSTICS_ENABLED: 'true' }],
  ])('a config-error response: %s', async (_label, env) => {
    const s = session(backend);
    const refused = await s.mcp('misconfigured tools/list', rpc('tools/list'), OWNER_HEADERS, env);
    expect(refused.status).toBe(500);
    expect(JSON.parse(refused.text).error).toEqual({ code: -32603, message: 'Server misconfigured' });
    await s.mcp('misconfigured tools/call', call('list_courses'), OWNER_HEADERS, env);
    await s.mcp('misconfigured anonymous', rpc('tools/list'), {}, env);
    // The owner reads the detail on the status page and in the log; neither may quote a secret.
    await s.request('misconfigured status page', new Request(`${SITE}/`, { headers: OWNER_HEADERS }), env);
    await s.request('misconfigured status json', new Request(`${SITE}/api/status`, { headers: OWNER_HEADERS }), env);
    await s.request(
      'misconfigured status check',
      new Request(`${SITE}/api/status/check`, { method: 'POST', headers: { ...OWNER_HEADERS, origin: SITE } }),
      env,
    );
    expect(s.logLines.some((line) => line.includes('"event":"server_misconfigured"'))).toBe(true);
    expectClean(s);
  });

  it('tolerated configuration problems that echo a value: a secret pasted into a non-secret variable', async () => {
    const s = session(backend);
    const env = { TIMEZONE: SECRETS.salt, LOG_LEVEL: SECRETS.salt, STUDENT_WRITE_TOOLS: SECRETS.token, INSTITUTION_NAME: SECRETS.confirmation };
    const page = await s.request('warnings page', new Request(`${SITE}/`, { headers: OWNER_HEADERS }), env);
    expect(page.text).toContain('Configuration warnings');
    expect(page.text).toContain('[REDACTED]');
    await s.request('warnings json', new Request(`${SITE}/api/status`, { headers: OWNER_HEADERS }), env);
    await s.mcp('warnings tools/list', rpc('tools/list'), OWNER_HEADERS, env);
    expectClean(s);
  });

  it('a deployment with invocation-blocking errors', async () => {
    const s = session(backend);
    const env = { CANVAS_API_URL: '' };
    await s.mcp('no url tools/list', rpc('tools/list'), OWNER_HEADERS, env);
    const refused = await s.mcp('no url tools/call', call('list_courses'), OWNER_HEADERS, env);
    expect(JSON.parse(refused.text).error.message).toBe('Server misconfigured');
    await s.request('no url status', new Request(`${SITE}/`, { headers: OWNER_HEADERS }), env);
    expectClean(s);
  });
});

describe('no secret leaves the Worker (sdk backend, 2026-07-28 requests)', () => {
  const modern = (method: string, params: Record<string, unknown> = {}): [Record<string, unknown>, Record<string, string>] => {
    const headers: Record<string, string> = {
      ...OWNER_HEADERS,
      accept: 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    };
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
    return [{ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: MODERN_META } }, headers];
  };

  it('discovery and every leaking tool', async () => {
    const s = session('sdk');
    const [discover, discoverHeaders] = modern('server/discover');
    expect((await s.mcp('server/discover', discover, discoverHeaders)).status).toBe(200);
    for (const name of ['get_my_profile', 'list_courses', 'list_conversations', 'get_syllabus']) {
      const [body, headers] = modern('tools/call', { name, arguments: {} });
      const reply = await s.mcp(`modern ${name}`, body, headers);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.text).result).toBeDefined();
    }
    const [throwing, throwingHeaders] = modern('tools/call', { name: 'get_course_details', arguments: { course_identifier: '1' } });
    await s.mcp('modern throwing', throwing, throwingHeaders);
    expect(s.canvasSawToken()).toBe(true);
    expectClean(s);
  });
});
