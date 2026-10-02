// End-to-end through the Worker entry: an in-process MCP client posts to app.fetch, for both backends and both
// protocol eras. Also covers the diagnostics access the Milestone 0 probes rely on (src/http/diagnostics-access.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import worker from '../../entry/worker';
import { createApp } from '../../src/app';
import type { App, AppExecutionContext } from '../../src/app';
import { sha256Hex } from '../../src/core/hash';
import { PROBE_FETCH_URL, createDiagnosticsAccess } from '../../src/http/diagnostics-access';
import { HELLO_TEXT } from '../../src/tools/diagnostics';
import type { Env } from '../../src/types';
import { SERVER_VERSION } from '../../src/version';

const SITE = 'https://site.example';
const OWNER_EMAIL = 'owner@example.edu';
const OWNER_ID = 'user-0f9a77';
const TOKEN = `7~${'Nb6'.repeat(16)}`;

/** The spike deployment: diagnostics on, and no Canvas token or confirmation secret. */
const SPIKE_ENV: Env = { DIAGNOSTICS_ENABLED: 'true', OWNER_EMAIL };

const LEGACY_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const OWNER_HEADERS = { 'oai-authenticated-user-id': OWNER_ID, 'oai-authenticated-user-email': OWNER_EMAIL };
const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } };

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_META = {
  [VERSION_KEY]: '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' },
};

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

function rpc(method: string, params?: unknown, id: string | number = 1): Record<string, unknown> {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

function post(body: unknown, headers: Record<string, string> = {}, path = '/mcp'): Request {
  return new Request(`${SITE}${path}`, { method: 'POST', headers: { ...LEGACY_HEADERS, ...headers }, body: JSON.stringify(body) });
}

function modern(method: string, params: Record<string, unknown> = {}, id: string | number = 1): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  return new Request(`${SITE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } }),
  });
}

function expectJson(r: Reply): void {
  expect(r.headers.get('content-type')).toBe('application/json');
  expect(r.headers.get('cache-control')).toBe('no-store');
}

interface Harness {
  app: App;
  logLines: string[];
  logs(): Array<Record<string, unknown>>;
}

function harness(overrides: Parameters<typeof createApp>[0] = {}): Harness {
  const logLines: string[] = [];
  const app = createApp({ logSink: (line) => logLines.push(line), ...overrides });
  return { app, logLines, logs: () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe.each(['native', 'sdk'])('MCP session through app.fetch (%s backend)', (backend) => {
  const env: Env = { ...SPIKE_ENV, MCP_BACKEND: backend };

  it('initialize, then tools/list, then tools/call hello, all as application/json', async () => {
    const { app } = harness();

    const init = await reply(await app.fetch(post(rpc('initialize', INIT_PARAMS, 'init-1')), env));
    expect(init.status).toBe(200);
    expectJson(init);
    expect(init.json.id).toBe('init-1');
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.serverInfo).toEqual({ name: 'canvas-api', version: SERVER_VERSION });
    expect(init.json.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.headers.get('mcp-session-id')).toBeNull();

    const initialized = await reply(await app.fetch(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), env));
    expect(initialized.status).toBe(202);
    expect(initialized.text).toBe('');

    const list = await reply(await app.fetch(post(rpc('tools/list', undefined, 2)), env));
    expect(list.status).toBe(200);
    expectJson(list);
    const tools = list.json.result.tools as Array<Record<string, any>>;
    expect(tools.map((tool) => tool.name)).toEqual(['hello', 'sites_diagnostics']);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }

    const call = await reply(await app.fetch(post(rpc('tools/call', { name: 'hello', arguments: {} }, 3)), env));
    expect(call.status).toBe(200);
    expectJson(call);
    expect(call.json).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: HELLO_TEXT }], isError: false },
    });
  });

  it('answers ping', async () => {
    const r = await reply(await harness().app.fetch(post(rpc('ping', undefined, 'p')), env));
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expectJson(r);
  });

  it('never answers with an event stream, whatever the client says it accepts', async () => {
    const { app } = harness();
    for (const accept of ['text/event-stream', 'application/json', '*/*']) {
      const r = await app.fetch(post(rpc('tools/call', { name: 'hello', arguments: {} }), { accept }), env);
      expect(r.headers.get('content-type')).toBe('application/json');
      await r.text();
    }
  });

  it('reports a bad argument in upstream wording', async () => {
    const r = await reply(
      await harness().app.fetch(post(rpc('tools/call', { name: 'sites_diagnostics', arguments: { probe: 'nope' } })), env),
    );
    expect(r.status).toBe(200);
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toMatch(/^\{"error": "/);
  });

  it('writes one request line and one tool line per call, with no header, body or identity value in them', async () => {
    const h = harness();
    await h.app.fetch(
      post(rpc('tools/call', { name: 'hello', arguments: {} }), { ...OWNER_HEADERS, authorization: 'Bearer aaa.bbb.ccc', 'x-probe': 'header-value-123' }),
      env,
    );
    const lines = h.logs();
    const requestLines = lines.filter((line) => line.event === 'http_request');
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({ level: 'info', route: 'mcp', method: 'POST', status: 200 });
    expect(requestLines[0]?.identity_tag).toMatch(/^[0-9a-f]{12}$/);
    const toolLines = lines.filter((line) => line.event === 'tool_call');
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toMatchObject({ tool: 'hello', effect: 'read', isError: false });
    expect(toolLines[0]?.request_id).toBe(requestLines[0]?.request_id);
    const all = h.logLines.join('\n');
    for (const value of [OWNER_EMAIL, OWNER_ID, 'aaa.bbb.ccc', 'header-value-123', 'clientInfo']) {
      expect(all).not.toContain(value);
    }
  });

  it('gives every request its own request id', async () => {
    const h = harness();
    await h.app.fetch(post(rpc('ping')), env);
    await h.app.fetch(post(rpc('ping')), env);
    const ids = h.logs().filter((line) => line.event === 'http_request').map((line) => line.request_id);
    expect(new Set(ids).size).toBe(2);
  });

  it('reads configuration from the env of each request, and keeps nothing from the one before', async () => {
    const { app } = harness();
    const ownerOnly: Env = { MCP_BACKEND: backend, CANVAS_API_URL: 'https://canvas.example.edu', CANVAS_API_TOKEN: TOKEN, OWNER_EMAIL };
    const otherOwner: Env = { ...ownerOnly, OWNER_EMAIL: 'second@example.edu' };

    expect((await app.fetch(post(rpc('tools/list'), OWNER_HEADERS), ownerOnly)).status).toBe(200);
    // The same app, another deployment's env: the first owner is a stranger there.
    expect((await app.fetch(post(rpc('tools/list'), OWNER_HEADERS), otherOwner)).status).toBe(403);
    // Diagnostics mode on one request does not carry over to the next.
    expect((await app.fetch(post(rpc('tools/list')), env)).status).toBe(200);
    expect((await app.fetch(post(rpc('tools/list')), ownerOnly)).status).toBe(403);
  });

  it('keeps concurrent requests apart', async () => {
    const { app } = harness();
    const ownerEnv: Env = { MCP_BACKEND: backend, CANVAS_API_URL: 'https://canvas.example.edu', CANVAS_API_TOKEN: TOKEN, OWNER_EMAIL };
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) => {
        const isOwner = index % 2 === 0;
        return app
          .fetch(post(rpc('tools/list', undefined, index), isOwner ? OWNER_HEADERS : { 'oai-authenticated-user-email': `visitor${index}@example.org` }), ownerEnv)
          .then(reply);
      }),
    );
    for (const [index, r] of replies.entries()) {
      expect(r.status).toBe(index % 2 === 0 ? 200 : 403);
      if (index % 2 === 0) expect(r.json.id).toBe(index);
    }
  });

  it('serves the Worker entry the same way', async () => {
    const r = await reply(await worker.fetch(post(rpc('tools/call', { name: 'hello', arguments: {} })), { ...env, LOG_LEVEL: 'error' }));
    expect(r.json.result.content[0].text).toBe(HELLO_TEXT);
    const health = await worker.fetch(new Request(`${SITE}/healthz`), { LOG_LEVEL: 'error' });
    expect(await health.text()).toBe('ok');
  });
});

describe('sdk backend through app.fetch: 2026-07-28 requests', () => {
  const env: Env = { ...SPIKE_ENV, MCP_BACKEND: 'sdk' };

  it('server/discover, then tools/list, then tools/call hello, all as application/json', async () => {
    const { app } = harness();
    const discover = await reply(await app.fetch(modern('server/discover'), env));
    expect(discover.status).toBe(200);
    expectJson(discover);
    expect(discover.json.result.supportedVersions).toEqual(['2026-07-28']);

    const list = await reply(await app.fetch(modern('tools/list', {}, 2), env));
    expect(list.status).toBe(200);
    expectJson(list);
    expect(list.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['hello', 'sites_diagnostics']);

    const call = await reply(await app.fetch(modern('tools/call', { name: 'hello', arguments: {} }, 3), env));
    expect(call.status).toBe(200);
    expectJson(call);
    expect(call.json.result.content).toEqual([{ type: 'text', text: HELLO_TEXT }]);
  });

  it('reports the protocol era to the diagnostics tool', async () => {
    const { app } = harness();
    const legacy = await reply(await app.fetch(post(rpc('tools/call', { name: 'sites_diagnostics', arguments: { probe: 'runtime' } })), env));
    expect(legacy.json.result.structuredContent.protocol_era).toBe('legacy');
    const current = await reply(await app.fetch(modern('tools/call', { name: 'sites_diagnostics', arguments: { probe: 'runtime' } }), env));
    expect(current.json.result.structuredContent.protocol_era).toBe('modern');
  });

  it('applies the owner gate to 2026-07-28 requests as well', async () => {
    const { app } = harness();
    const ownerEnv: Env = { MCP_BACKEND: 'sdk', CANVAS_API_URL: 'https://canvas.example.edu', CANVAS_API_TOKEN: TOKEN, OWNER_EMAIL };
    const denied = await reply(await app.fetch(modern('tools/list'), ownerEnv));
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe(-32001);
  });
});

describe('native backend through app.fetch: a 2026-07-28 client', () => {
  it('is told which revisions are served, so it can fall back to initialize', async () => {
    const r = await reply(await harness().app.fetch(modern('tools/list'), { ...SPIKE_ENV, MCP_BACKEND: 'native' }));
    expect(r.status).toBe(400);
    expectJson(r);
    expect(r.json.error.data.supported).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
  });
});

describe.each(['native', 'sdk'])('diagnostics probes through app.fetch (%s backend)', (backend) => {
  const env: Env = { ...SPIKE_ENV, MCP_BACKEND: backend };

  async function probe(
    app: App,
    args: Record<string, unknown>,
    headers: Record<string, string> = {},
    requestEnv: Env = env,
    ctx?: AppExecutionContext,
  ): Promise<Reply> {
    return reply(await app.fetch(post(rpc('tools/call', { name: 'sites_diagnostics', arguments: args }), headers), requestEnv, ctx));
  }

  it('headers: reports names, lengths and short hashes, and never a value', async () => {
    const authorization = 'Bearer aaa.bbb.ccc';
    const r = await probe(harness().app, { probe: 'headers' }, { ...OWNER_HEADERS, authorization, 'mcp-protocol-version': '2025-06-18', 'x-secret-thing': 'value-ZZZ-123' });
    expect(r.json.result.isError).toBe(false);
    const out = r.json.result.structuredContent;
    const byName = new Map<string, { length: number; sha256_8: string }>(out.headers.map((entry: any) => [entry.name, entry]));
    expect(byName.get('oai-authenticated-user-email')).toEqual({
      name: 'oai-authenticated-user-email',
      length: OWNER_EMAIL.length,
      sha256_8: sha256Hex(OWNER_EMAIL).slice(0, 8),
    });
    expect(byName.get('x-secret-thing')?.length).toBe('value-ZZZ-123'.length);
    expect(byName.has('content-type')).toBe(true);
    expect(out.identity_headers).toEqual({
      'oai-authenticated-user-id': { present: true },
      'oai-authenticated-user-email': { present: true },
      'oai-authenticated-user-full-name': { present: false },
    });
    expect(out.identity_resolved).toBe(true);
    expect(out.user_id_sha256).toBe(sha256Hex(OWNER_ID));
    expect(out.authorization).toEqual({ present: true, scheme: 'Bearer', segments: 3 });
    expect(out.mcp_protocol_version).toBe('2025-06-18');
    for (const value of [OWNER_EMAIL, OWNER_ID, authorization, 'aaa.bbb.ccc', 'value-ZZZ-123']) {
      expect(r.text).not.toContain(value);
    }
  });

  it('headers: reports no identity when none arrives, and when the bypass token is present', async () => {
    const { app } = harness();
    const none = await probe(app, { probe: 'headers' });
    expect(none.json.result.structuredContent.identity_resolved).toBe(false);
    expect(none.json.result.structuredContent.user_id_sha256).toBeNull();

    const bypass = await probe(app, { probe: 'headers' }, { ...OWNER_HEADERS, 'oai-sites-authorization': 'bypass-token-value' });
    const out = bypass.json.result.structuredContent;
    // The headers are visible to the probe, but they do not make an identity.
    expect(out.identity_headers['oai-authenticated-user-email']).toEqual({ present: true });
    expect(out.headers.some((entry: any) => entry.name === 'oai-sites-authorization')).toBe(true);
    expect(out.identity_resolved).toBe(false);
    expect(out.user_id_sha256).toBeNull();
    expect(bypass.text).not.toContain('bypass-token-value');
  });

  it('headers: shows a forged duplicate as one joined value that makes no identity', async () => {
    const headers = new Headers(LEGACY_HEADERS);
    headers.append('oai-authenticated-user-email', 'forged@evil.example');
    headers.append('oai-authenticated-user-email', OWNER_EMAIL);
    const request = new Request(`${SITE}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc('tools/call', { name: 'sites_diagnostics', arguments: { probe: 'headers' } })),
    });
    const r = await reply(await harness().app.fetch(request, env));
    const out = r.json.result.structuredContent;
    const entry = out.headers.find((item: any) => item.name === 'oai-authenticated-user-email');
    expect(entry.length).toBe(`forged@evil.example, ${OWNER_EMAIL}`.length);
    expect(out.identity_resolved).toBe(false);
  });

  it('runtime: reports binding names and ctx.props keys, never their values', async () => {
    const ctx: AppExecutionContext = { props: { mcp_connection: { oauth_resource: 'resource-value-XYZ' }, user: 'prop-value-XYZ' } };
    const requestEnv: Env = { ...env, DB: { prepare: () => ({ first: async () => null }) } as unknown as D1Database, PSEUDONYM_SALT: 'salt-value-XYZ-123' };
    const r = await probe(harness().app, { probe: 'runtime' }, {}, requestEnv, ctx);
    const out = r.json.result.structuredContent;
    expect(out.bindings).toEqual(['DB', 'DIAGNOSTICS_ENABLED', 'MCP_BACKEND', 'OWNER_EMAIL', 'PSEUDONYM_SALT']);
    expect(out.ctx_props).toEqual(['mcp_connection', 'user']);
    expect(out.server_version).toBe(SERVER_VERSION);
    for (const value of ['resource-value-XYZ', 'prop-value-XYZ', 'salt-value-XYZ-123', OWNER_EMAIL]) {
      expect(r.text).not.toContain(value);
    }
  });

  it('runtime: works without an execution context', async () => {
    const r = await probe(harness().app, { probe: 'runtime' });
    expect(r.json.result.structuredContent.ctx_props).toEqual([]);
  });

  it('subrequests: fetches one fixed URL, without credentials or caller input, one request at a time', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response('h=www.cloudflare.com\n', { status: 200 });
    }) as unknown as typeof fetch;
    const { app } = harness({ fetchImpl });
    const r = await probe(app, { probe: 'subrequests', n: 5, url: undefined }, { ...OWNER_HEADERS, authorization: 'Bearer aaa.bbb.ccc', cookie: 'session=abc' });
    expect(r.json.result.structuredContent).toEqual({ probe: 'subrequests', requested: 5, attempted: 5, succeeded: 5 });
    expect(seen).toHaveLength(5);
    expect(maxInFlight).toBe(1);
    expect(PROBE_FETCH_URL).toBe('https://www.cloudflare.com/cdn-cgi/trace');
    for (const call of seen) {
      expect(call.url).toBe(PROBE_FETCH_URL);
      expect(call.init).toEqual({ method: 'GET', redirect: 'manual' });
    }
  });

  it('subrequests: stops at the first error and reports it', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls > 3) throw new Error('Too many subrequests.\nsecond line');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probe(harness({ fetchImpl }).app, { probe: 'subrequests', n: 50 });
    expect(r.json.result.structuredContent).toEqual({
      probe: 'subrequests',
      requested: 50,
      attempted: 4,
      succeeded: 3,
      firstError: 'Error: Too many subrequests.',
    });
    expect(calls).toBe(4);
  });

  it('subrequests: counts an HTTP error as a failed request and carries on', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('nope', { status: calls === 2 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const r = await probe(harness({ fetchImpl }).app, { probe: 'subrequests', n: 4 });
    expect(r.json.result.structuredContent).toMatchObject({ attempted: 4, succeeded: 3, firstError: 'HTTP 503' });
  });

  it('d1: runs SELECT 1 on the DB binding, one statement at a time', async () => {
    const statements: string[] = [];
    const DB = {
      prepare: (query: string) => ({
        first: async () => {
          statements.push(query);
          return { 1: 1 };
        },
      }),
    } as unknown as D1Database;
    const r = await probe(harness().app, { probe: 'd1', n: 4 }, {}, { ...env, DB });
    expect(r.json.result.structuredContent).toEqual({ probe: 'd1', requested: 4, attempted: 4, succeeded: 4 });
    expect(statements).toEqual(['SELECT 1', 'SELECT 1', 'SELECT 1', 'SELECT 1']);
  });

  it('d1: reports a missing binding and a failing database', async () => {
    const { app } = harness();
    const missing = await probe(app, { probe: 'd1', n: 3 });
    expect(missing.json.result.structuredContent).toMatchObject({ attempted: 0, succeeded: 0, firstError: 'The D1 binding DB is not present' });

    let calls = 0;
    const DB = {
      prepare: () => ({
        first: async () => {
          calls += 1;
          if (calls === 2) throw new TypeError('D1_ERROR: too many subrequests');
          return null;
        },
      }),
    } as unknown as D1Database;
    const failing = await probe(app, { probe: 'd1', n: 9 }, {}, { ...env, DB });
    expect(failing.json.result.structuredContent).toMatchObject({ attempted: 2, succeeded: 1, firstError: 'TypeError: D1_ERROR: too many subrequests' });
  });

  it('is not reachable outside diagnostics mode: the probes do not exist there', async () => {
    const ownerEnv: Env = { MCP_BACKEND: backend, CANVAS_API_URL: 'https://canvas.example.edu', CANVAS_API_TOKEN: TOKEN, OWNER_EMAIL };
    const r = await probe(harness().app, { probe: 'headers' }, OWNER_HEADERS, ownerEnv);
    expect(r.json.error.code).toBe(-32602);
    expect(r.json.result).toBeUndefined();
  });
});

describe('createDiagnosticsAccess', () => {
  const noFetch = (async () => {
    throw new Error('not used');
  }) as unknown as typeof fetch;

  function access(headers: Record<string, string>, env: Env = {}, ctx?: { props?: Record<string, unknown> }) {
    return createDiagnosticsAccess(new Request(`${SITE}/mcp`, { method: 'POST', headers }), env, ctx, noFetch);
  }

  function jwt(payload: unknown): string {
    const encode = (value: unknown): string =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJl`;
  }

  it('summarizes every header by lower-cased name, length and the first 8 hex of its SHA-256, sorted by name', () => {
    const summary = access({ 'X-Beta': 'two', 'x-alpha': 'one!' }).headerSummary();
    expect(summary).toEqual([
      { name: 'x-alpha', length: 4, sha256_8: sha256Hex('one!').slice(0, 8) },
      { name: 'x-beta', length: 3, sha256_8: sha256Hex('two').slice(0, 8) },
    ]);
    expect(JSON.stringify(summary)).not.toContain('one!');
  });

  it('reports an absent Authorization header', () => {
    expect(access({}).authorizationShape()).toEqual({ present: false });
  });

  it('reports the scheme and segment count of an opaque bearer token', () => {
    expect(access({ authorization: 'Bearer abcdef' }).authorizationShape()).toEqual({ present: true, scheme: 'Bearer', segments: 1 });
    expect(access({ authorization: 'Basic dXNlcjpwYXNz' }).authorizationShape()).toEqual({ present: true, scheme: 'Basic', segments: 1 });
  });

  it('reports only presence for a value with no scheme', () => {
    expect(access({ authorization: 'justonetoken' }).authorizationShape()).toEqual({ present: true });
  });

  it('reads iss and aud from a JWT, and nothing else', () => {
    const token = jwt({ iss: 'https://auth.example', aud: 'https://site.example/mcp', sub: 'user-sub-SECRET', email: 'owner@example.edu', exp: 1 });
    const shape = access({ authorization: `Bearer ${token}` }).authorizationShape();
    expect(shape).toEqual({ present: true, scheme: 'Bearer', segments: 3, jwtIss: 'https://auth.example', jwtAud: 'https://site.example/mcp' });
    expect(JSON.stringify(shape)).not.toContain('user-sub-SECRET');
    expect(JSON.stringify(shape)).not.toContain('owner@example.edu');
  });

  it('joins a list-valued aud and bounds the length of both claims', () => {
    const shape = access({ authorization: `Bearer ${jwt({ iss: 'i'.repeat(500), aud: ['one', 'two'] })}` }).authorizationShape();
    expect(shape.jwtAud).toBe('one two');
    expect(shape.jwtIss).toHaveLength(200);
  });

  it('reports three segments without claims when the middle one is not a JWT payload', () => {
    expect(access({ authorization: 'Bearer aaa.bbb.ccc' }).authorizationShape()).toEqual({ present: true, scheme: 'Bearer', segments: 3 });
    expect(access({ authorization: `Bearer aaa.${btoa('[1,2]')}.ccc` }).authorizationShape()).toEqual({ present: true, scheme: 'Bearer', segments: 3 });
    expect(access({ authorization: `Bearer aaa.${btoa('{"iss":7}').replace(/=+$/, '')}.ccc` }).authorizationShape()).toEqual({
      present: true,
      scheme: 'Bearer',
      segments: 3,
    });
  });

  it('lists binding names, sorted, without reading a value', () => {
    const env: Env = {};
    Object.defineProperty(env, 'SECRET_THING', {
      enumerable: true,
      get() {
        throw new Error('a binding value was read');
      },
    });
    env.DB = {} as D1Database;
    expect(createDiagnosticsAccess(new Request(SITE), env, undefined, noFetch).bindingNames()).toEqual(['DB', 'SECRET_THING']);
  });

  it('lists ctx.props keys, or nothing when there are none', () => {
    expect(access({}, {}, { props: { b: 1, a: { nested: 'value' } } }).ctxPropKeys()).toEqual(['a', 'b']);
    expect(access({}, {}, {}).ctxPropKeys()).toEqual([]);
    expect(access({}, {}, undefined).ctxPropKeys()).toEqual([]);
  });

  it('clamps the probe count and never passes anything but the fixed URL to fetch', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      urls.push(String(input));
      return new Response('ok');
    }) as unknown as typeof fetch;
    const diagnostics = createDiagnosticsAccess(
      new Request(`${SITE}/mcp?url=https://evil.example/`, { headers: { 'x-url': 'https://evil.example/' } }),
      { PROBE_URL: 'https://evil.example/' },
      undefined,
      fetchImpl,
    );
    expect(await diagnostics.probeFetch(100_000)).toEqual({ attempted: 200, succeeded: 200 });
    expect(new Set(urls)).toEqual(new Set([PROBE_FETCH_URL]));
    expect(await diagnostics.probeFetch(-3)).toEqual({ attempted: 0, succeeded: 0 });
    expect(await diagnostics.probeFetch(Number.NaN)).toEqual({ attempted: 0, succeeded: 0 });
  });

  it('treats a DB value that is not a database as absent', async () => {
    const diagnostics = createDiagnosticsAccess(new Request(SITE), { DB: 'not-a-binding' as unknown as D1Database }, undefined, noFetch);
    expect(await diagnostics.probeD1(2)).toEqual({ attempted: 0, succeeded: 0, firstError: 'The D1 binding DB is not present' });
  });
});

describe('app.fetch never rejects', () => {
  it('answers 500 without detail when the env cannot be read', async () => {
    const env: Env = {};
    Object.defineProperty(env, 'CANVAS_API_URL', {
      enumerable: true,
      get() {
        throw new Error(`boom ${TOKEN}`);
      },
    });
    const r = await reply(await harness().app.fetch(post(rpc('tools/list')), env));
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Internal server error' });
    expect(r.text).not.toContain(TOKEN);
  });

  it('serves without an env object and without an execution context', async () => {
    const { app } = harness();
    const health = await app.fetch(new Request(`${SITE}/healthz`), undefined as unknown as Env);
    expect(health.status).toBe(200);
    const mcp = await reply(await app.fetch(post(rpc('tools/list')), null as unknown as Env));
    expect(mcp.status).toBe(403);
  });

  it('answers 500 with a JSON-RPC error when something breaks on the MCP path', async () => {
    const h = harness();
    // A binding whose inspection throws breaks the request after routing has chosen /mcp.
    const env: Env = { ...SPIKE_ENV, MCP_BACKEND: 'native' };
    Object.defineProperty(env, 'DB', {
      enumerable: true,
      get() {
        throw new RangeError('binding exploded');
      },
    });
    const r = await reply(await h.app.fetch(post(rpc('tools/list')), env));
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
    expect(h.logs().find((line) => line.event === 'unhandled_error')).toMatchObject({ route: 'mcp', error_name: 'RangeError' });
    expect(h.logLines.join('\n')).not.toContain('binding exploded');
  });
});

describe('source rules for the app layer', () => {
  const root = join(__dirname, '..', '..');
  const files = [
    'src/app.ts',
    ...readdirSync(join(root, 'src/http')).map((name) => `src/http/${name}`),
    ...readdirSync(join(root, 'src/auth')).map((name) => `src/auth/${name}`),
    'entry/worker.ts',
  ];

  it('covers the files of this layer', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'src/app.ts',
        'src/http/identity.ts',
        'src/http/security.ts',
        'src/http/status-page.ts',
        'src/http/diagnostics-access.ts',
        'src/auth/credentials.ts',
        'src/auth/owner-secret-provider.ts',
      ]),
    );
  });

  it.each(files)('%s imports nothing from node: or cloudflare:', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).not.toMatch(/from\s+['"](node|cloudflare):/);
    expect(source).not.toMatch(/import\(\s*['"](node|cloudflare):/);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });

  it('keeps module-level mutable state to the two MCP backends', () => {
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      const mutable = source.split('\n').filter((line) => /^(export\s+)?(let|var)\s/.test(line));
      if (file === 'src/app.ts') {
        expect(mutable.map((line) => line.replace(/\s*[:=].*$/, ''))).toEqual(['let nativeBackend', 'let sdkBackend']);
      } else {
        expect(mutable).toEqual([]);
      }
    }
  });

  it('never defines the reserved gateway routes or a 401', () => {
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(code).not.toMatch(/signin-with-chatgpt|signout-with-chatgpt|['"`]\/callback/);
      expect(code).not.toMatch(/status:\s*401|\(401\b|,\s*401\s*[,)]/);
      expect(code).not.toMatch(/['"`]WWW-Authenticate['"`]\s*:/i);
    }
  });
});

describe('.dev.vars.example', () => {
  const root = join(__dirname, '..', '..');
  const example = readFileSync(join(root, '.dev.vars.example'), 'utf8');

  it('names every variable the configuration reads', () => {
    const source = readFileSync(join(root, 'src/env.ts'), 'utf8');
    const read = new Set([...source.matchAll(/\(env, '([A-Z0-9_]+)'/g)].map((match) => match[1] as string));
    expect(read.size).toBeGreaterThanOrEqual(35);
    const named = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] as string));
    expect([...read].filter((name) => !named.has(name))).toEqual([]);
  });

  it('holds only placeholders: nothing shaped like a Canvas token, and a warning at the top', () => {
    expect(example).not.toMatch(/\b\d{1,6}~[A-Za-z0-9]{40,}\b/);
    expect(example.split('\n').slice(0, 6).join('\n')).toMatch(/NEVER put a real Canvas token/);
    expect(example).toMatch(/^CANVAS_API_TOKEN=FAKE-/m);
    expect(example).toMatch(/^CONFIRMATION_SECRET=FAKE-/m);
    expect(example).toMatch(/^PSEUDONYM_SALT=FAKE-/m);
  });

  it('parses as a deployment with no configuration error', async () => {
    const env: Env = {};
    for (const line of example.split('\n')) {
      const match = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
      if (match !== null) env[match[1] as string] = match[2] as string;
    }
    const r = await reply(
      await harness().app.fetch(new Request(`${SITE}/api/status`, { headers: { 'oai-authenticated-user-email': 'owner@example.edu' } }), env),
    );
    expect(r.json.private).toBe(false);
    expect(r.json.status.config_errors).toEqual([]);
    expect(r.json.status.config_warnings).toEqual([]);
  });
});
