// The owner gate, tested through createApp().fetch for both MCP backends. Carries over upstream
// tests/test_http_transport.py (fail closed without an authenticated caller; client-supplied credentials and URLs are
// ignored) and tests/security/test_public_route_limits.py (bounded body reads for callers that are not authorized).
import { describe, expect, it, vi } from 'vitest';
import { APP_DENIED_CODE, createApp } from '../../src/app';
import { NOT_AUTHORIZED_PUBLIC_MESSAGE } from '../../src/auth/owner-secret-provider';
import { sha256Hex } from '../../src/core/hash';
import {
  ANONYMOUS_BODY_LIMIT_BYTES,
  bodyLimitFor,
  browserRequestMarker,
  declaredContentLength,
  hasSameOriginHeader,
  isAllowedHost,
  readBodyCapped,
  withoutAuthChallenge,
} from '../../src/http/security';
import type { Env } from '../../src/types';

const SITE = 'https://site.example';
const TOKEN = `7~${'Gh2'.repeat(16)}`;
const CONFIRMATION_SECRET = 'owner-gate-confirmation-secret-0123456789';
const SALT = 'owner-gate-pseudonym-salt';
const OWNER_EMAIL = 'owner@example.edu';
const OWNER_ID = 'user-0f9a77';

const BASE_ENV: Env = {
  CANVAS_API_URL: 'https://canvas.example.edu',
  CANVAS_API_TOKEN: TOKEN,
  OWNER_EMAIL,
  CONFIRMATION_SECRET,
  PSEUDONYM_SALT: SALT,
};

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const OWNER_HEADERS = { 'oai-authenticated-user-id': OWNER_ID, 'oai-authenticated-user-email': OWNER_EMAIL };
const STRANGER_HEADERS = { 'oai-authenticated-user-id': 'user-222', 'oai-authenticated-user-email': 'visitor@example.org' };

const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } };

function rpc(method: string, params?: unknown, id: string | number = 1): Record<string, unknown> {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

const LIST = rpc('tools/list');
const CALL = rpc('tools/call', { name: 'hello', arguments: {} });

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

interface Harness {
  logLines: string[];
  outbound: string[];
  /** Every response this harness produced, for the checks that hold for all of them. */
  replies: Reply[];
  post(body: unknown, headers?: Record<string, string>, env?: Env, path?: string): Promise<Reply>;
  send(request: Request, env?: Env): Promise<Reply>;
  security(): Array<Record<string, unknown>>;
}

function harness(backend: string): Harness {
  const logLines: string[] = [];
  const outbound: string[] = [];
  const replies: Reply[] = [];
  const app = createApp({
    logSink: (line) => logLines.push(line),
    fetchImpl: (async (input: unknown) => {
      outbound.push(String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  const send = async (request: Request, env: Env = {}): Promise<Reply> => {
    const response = await app.fetch(request, { ...BASE_ENV, MCP_BACKEND: backend, ...env });
    const text = await response.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as Record<string, any>);
    } catch {
      parsed = {};
    }
    const reply = { status: response.status, headers: response.headers, text, json: parsed };
    replies.push(reply);
    return reply;
  };
  return {
    logLines,
    outbound,
    replies,
    send,
    post: (body, headers = {}, env = {}, path = '/mcp') =>
      send(
        new Request(`${SITE}${path}`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        env,
      ),
    security: () =>
      logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === 'security'),
  };
}

function expectDenied(reply: Reply): void {
  expect(reply.status).toBe(403);
  expect(reply.headers.get('content-type')).toBe('application/json');
  expect(reply.headers.get('www-authenticate')).toBeNull();
  expect(reply.json.jsonrpc).toBe('2.0');
  expect(reply.json.error.code).toBe(APP_DENIED_CODE);
  expect(reply.json.result).toBeUndefined();
}

function expectNoChallenge(replies: readonly Reply[]): void {
  expect(replies.length).toBeGreaterThan(0);
  for (const reply of replies) {
    expect(reply.status).not.toBe(401);
    expect(reply.headers.get('www-authenticate')).toBeNull();
  }
}

describe.each(['native', 'sdk'])('owner gate on /mcp (%s backend)', (backend) => {
  describe('who gets in', () => {
    it('refuses a request with no identity', async () => {
      const h = harness(backend);
      for (const body of [rpc('initialize', INIT_PARAMS), LIST, CALL, rpc('ping')]) {
        const reply = await h.post(body);
        expectDenied(reply);
        expect(reply.json.error.message).toBe(NOT_AUTHORIZED_PUBLIC_MESSAGE);
      }
      expectNoChallenge(h.replies);
    });

    it('refuses a signed-in user who is not the owner', async () => {
      const h = harness(backend);
      for (const body of [rpc('initialize', INIT_PARAMS), LIST, CALL]) {
        expectDenied(await h.post(body, STRANGER_HEADERS));
      }
      expectNoChallenge(h.replies);
    });

    it('lets the owner in', async () => {
      const h = harness(backend);
      const init = await h.post(rpc('initialize', INIT_PARAMS), OWNER_HEADERS);
      expect(init.status).toBe(200);
      expect(init.headers.get('content-type')).toBe('application/json');
      expect(init.json.result.protocolVersion).toBe('2025-06-18');
      const list = await h.post(LIST, OWNER_HEADERS);
      expect(list.status).toBe(200);
      expect(list.json.result.tools).toContainEqual(expect.objectContaining({ name: 'list_courses' }));
      expect(h.security()).toEqual([]);
      expectNoChallenge(h.replies);
    });

    it('lets the owner in on the email alone', async () => {
      const reply = await harness(backend).post(LIST, { 'oai-authenticated-user-email': OWNER_EMAIL });
      expect(reply.status).toBe(200);
    });

    it('gives the owner a tool error, not a gate error, for a tool that is not registered', async () => {
      const reply = await harness(backend).post(CALL, OWNER_HEADERS);
      expect(reply.status).toBe(200);
      expect(reply.json.error.code).toBe(-32602);
    });

    it.each([
      ['a comma-joined email', { 'oai-authenticated-user-email': `attacker@evil.example,${OWNER_EMAIL}` }],
      ['a comma-and-space-joined email', { 'oai-authenticated-user-email': `${OWNER_EMAIL}, attacker@evil.example` }],
      ['the owner email twice, joined', { 'oai-authenticated-user-email': `${OWNER_EMAIL}, ${OWNER_EMAIL}` }],
      ['an email containing a space', { 'oai-authenticated-user-email': `${OWNER_EMAIL} extra` }],
      ['an email containing a tab', { 'oai-authenticated-user-email': `${OWNER_EMAIL}\textra` }],
      ['an email with a control character', { 'oai-authenticated-user-email': `${OWNER_EMAIL}\u0001` }],
      ['a percent-encoded email', { 'oai-authenticated-user-email': 'owner%40example.edu' }],
      ['an empty email', { 'oai-authenticated-user-email': '' }],
      ['a valid email with a comma-joined id', { ...OWNER_HEADERS, 'oai-authenticated-user-id': `forged, ${OWNER_ID}` }],
      ['the owner email in a full-name header only', { 'oai-authenticated-user-full-name': OWNER_EMAIL }],
      ['underscore variants of the header names', { oai_authenticated_user_email: OWNER_EMAIL, oai_authenticated_user_id: OWNER_ID }],
    ])('refuses %s', async (_label, headers) => {
      const h = harness(backend);
      expectDenied(await h.post(LIST, headers));
      expectDenied(await h.post(CALL, headers));
    });

    it('refuses a duplicated email header, as a gateway that appends would produce', async () => {
      const h = harness(backend);
      const headers = new Headers(JSON_HEADERS);
      headers.append('oai-authenticated-user-email', OWNER_EMAIL);
      headers.append('oai-authenticated-user-email', 'visitor@example.org');
      expectDenied(await h.send(new Request(`${SITE}/mcp`, { method: 'POST', headers, body: JSON.stringify(LIST) })));
      const twice = new Headers(JSON_HEADERS);
      twice.append('oai-authenticated-user-email', OWNER_EMAIL);
      twice.append('oai-authenticated-user-email', OWNER_EMAIL);
      expectDenied(await h.send(new Request(`${SITE}/mcp`, { method: 'POST', headers: twice, body: JSON.stringify(LIST) })));
    });

    it('refuses a request that carries the bypass token, whatever identity it claims', async () => {
      const h = harness(backend);
      for (const body of [rpc('initialize', INIT_PARAMS), LIST, CALL]) {
        expectDenied(await h.post(body, { ...OWNER_HEADERS, 'oai-sites-authorization': 'bypass-token' }));
      }
      expect(h.security().every((line) => line.identity_rejected === 'bypass_token_present')).toBe(true);
      expect(h.security().every((line) => line.identity_tag === undefined)).toBe(true);
    });

    it('never takes an identity from the body or from _meta', async () => {
      const h = harness(backend);
      const meta = {
        'openai/subject': OWNER_ID,
        'openai/userEmail': OWNER_EMAIL,
        'oai-authenticated-user-email': OWNER_EMAIL,
      };
      expectDenied(await h.post(rpc('tools/list', { _meta: meta })));
      expectDenied(await h.post(rpc('tools/call', { name: 'hello', arguments: { email: OWNER_EMAIL }, _meta: meta })));
      expectDenied(await h.post({ ...LIST, 'oai-authenticated-user-email': OWNER_EMAIL }));
    });

    it('ignores client-supplied credentials: X-Canvas-Token, X-Canvas-URL, Authorization, access keys', async () => {
      const h = harness(backend);
      const headers = {
        'x-canvas-token': TOKEN,
        'x-canvas-url': 'https://evil.example/api/v1',
        'x-mcp-access-key': 'key',
        authorization: `Bearer ${TOKEN}`,
      };
      expectDenied(await h.post(LIST, headers));
      expectDenied(await h.post(CALL, headers));
      expect(h.outbound).toEqual([]);
    });
  });

  describe('OWNER_USER_ID_SHA256', () => {
    const env = { OWNER_USER_ID_SHA256: sha256Hex(OWNER_ID) };

    it('lets the owner in when the id matches', async () => {
      expect((await harness(backend).post(LIST, OWNER_HEADERS, env)).status).toBe(200);
    });

    it('refuses the owner email with another id', async () => {
      expectDenied(await harness(backend).post(LIST, { ...OWNER_HEADERS, 'oai-authenticated-user-id': 'user-other' }, env));
    });

    it('lets the owner in without the id header, and logs that it did', async () => {
      const h = harness(backend);
      expect((await h.post(LIST, { 'oai-authenticated-user-email': OWNER_EMAIL }, env)).status).toBe(200);
      expect(h.security().map((line) => line.event)).toEqual(['owner_id_header_absent']);
    });
  });

  describe('browser requests', () => {
    it.each([
      ['Origin of another site', { origin: 'https://evil.example' }],
      ["Origin of this Site (script on the Site's own origin is not an MCP client)", { origin: SITE }],
      ['Origin: null', { origin: 'null' }],
      ['Sec-Fetch-Site', { 'sec-fetch-site': 'same-origin' }],
      ['Sec-Fetch-Mode', { 'sec-fetch-mode': 'cors' }],
      ['Sec-Fetch-Dest', { 'sec-fetch-dest': 'empty' }],
      ['Sec-Fetch-User', { 'sec-fetch-user': '?1' }],
    ])('refuses the owner when the request carries %s', async (_label, headers) => {
      const h = harness(backend);
      const reply = await h.post(LIST, { ...OWNER_HEADERS, ...headers });
      expectDenied(reply);
      expect(reply.json.error.message).toBe('Forbidden');
      expect(reply.headers.get('access-control-allow-origin')).toBeNull();
      expect(h.security()).toHaveLength(1);
      expect(h.security()[0]).toMatchObject({ event: 'request_denied', reason: 'browser_request' });
    });

    it('answers a CORS preflight with 405 and no CORS headers', async () => {
      const reply = await harness(backend).send(
        new Request(`${SITE}/mcp`, {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        }),
      );
      expect(reply.status).toBe(405);
      expect(reply.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('request shape', () => {
    it.each(['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD'])('answers %s /mcp with 405', async (method) => {
      const h = harness(backend);
      const reply = await h.send(new Request(`${SITE}/mcp`, { method, headers: OWNER_HEADERS }));
      expect(reply.status).toBe(405);
      expect(reply.headers.get('allow')).toBe('POST');
      const anonymous = await h.send(new Request(`${SITE}/mcp`, { method }));
      expect(anonymous.status).toBe(405);
      expectNoChallenge(h.replies);
    });

    it('refuses a JSON-RPC batch with -32600, for the owner and for anyone else', async () => {
      const h = harness(backend);
      for (const headers of [OWNER_HEADERS, {}]) {
        const reply = await h.post([LIST, CALL], headers);
        expect(reply.status).toBe(400);
        expect(reply.json.error.code).toBe(-32600);
        expect(reply.json.error.message).toBe('Bad Request: JSON-RPC batches are not supported by this endpoint');
        expect(reply.json.result).toBeUndefined();
      }
      const empty = await h.post([], OWNER_HEADERS);
      expect(empty.json.error.code).toBe(-32600);
      expectNoChallenge(h.replies);
    });

    it.each([
      ['a string', '"tools/list"'],
      ['a number', '7'],
      ['null', 'null'],
    ])('refuses a body that is %s with -32600', async (_label, body) => {
      const reply = await harness(backend).post(body, OWNER_HEADERS);
      expect(reply.status).toBe(400);
      expect(reply.json.error.code).toBe(-32600);
    });

    it('answers a body that is not JSON with -32700 and does not echo it', async () => {
      const reply = await harness(backend).post(`{"jsonrpc": "2.0", "method": "tools/list", "secret-looking": ${TOKEN}`, OWNER_HEADERS);
      expect(reply.status).toBe(400);
      expect(reply.json.error.code).toBe(-32700);
      expect(reply.text).not.toContain(TOKEN);
      expect(reply.text).not.toContain('secret-looking');
    });

    it('answers a body that is not UTF-8 with -32700', async () => {
      const reply = await harness(backend).send(
        new Request(`${SITE}/mcp`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
          body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
        }),
      );
      expect(reply.status).toBe(400);
      expect(reply.json.error.code).toBe(-32700);
    });

    it.each([
      ['text/plain', 'text/plain'],
      ['a form', 'application/x-www-form-urlencoded'],
      ['no Content-Type', null],
    ])('requires Content-Type application/json: %s gets 415', async (_label, contentType) => {
      const headers = new Headers(OWNER_HEADERS);
      if (contentType !== null) headers.set('content-type', contentType);
      const request = new Request(`${SITE}/mcp`, { method: 'POST', headers, body: new TextEncoder().encode(JSON.stringify(LIST)) });
      if (contentType === null) request.headers.delete('content-type');
      const reply = await harness(backend).send(request);
      expect(reply.status).toBe(415);
    });

    it('accepts application/json with a charset parameter', async () => {
      const reply = await harness(backend).post(LIST, { ...OWNER_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      expect(reply.status).toBe(200);
    });

    it('serves MCP_PATH and nothing at the default path once it is moved', async () => {
      const h = harness(backend);
      expect((await h.post(LIST, OWNER_HEADERS, { MCP_PATH: '/api/mcp' }, '/api/mcp')).status).toBe(200);
      expect((await h.post(LIST, OWNER_HEADERS, { MCP_PATH: '/api/mcp' }, '/mcp')).status).toBe(404);
      expectDenied(await h.post(LIST, {}, { MCP_PATH: '/api/mcp' }, '/api/mcp'));
    });

    it('gates the path with a trailing slash the same way', async () => {
      const h = harness(backend);
      expectDenied(await h.post(LIST, {}, {}, '/mcp/'));
      expect((await h.post(LIST, OWNER_HEADERS, {}, '/mcp/')).status).toBe(200);
    });
  });

  describe('ALLOWED_HOSTS', () => {
    it('refuses the owner on a host that is not listed', async () => {
      const h = harness(backend);
      const reply = await h.post(LIST, OWNER_HEADERS, { ALLOWED_HOSTS: 'canvas-mcp.example.site' });
      expectDenied(reply);
      expect(h.security()[0]).toMatchObject({ event: 'request_denied', reason: 'host_not_allowed' });
    });

    it('serves the owner on a listed host, judged by the Host header when there is one', async () => {
      const h = harness(backend);
      expect((await h.post(LIST, OWNER_HEADERS, { ALLOWED_HOSTS: 'other.example, SITE.example' })).status).toBe(200);
      expectDenied(await h.post(LIST, { ...OWNER_HEADERS, host: 'evil.example' }, { ALLOWED_HOSTS: 'site.example' }));
      expect((await h.post(LIST, { ...OWNER_HEADERS, host: 'site.example:443' }, { ALLOWED_HOSTS: 'site.example' })).status).toBe(200);
    });
  });

  describe('the request class cannot be talked down', () => {
    const noToken = { CANVAS_API_TOKEN: '' };

    it('treats a discovery body with an invocation Mcp-Method header as an invocation', async () => {
      const h = harness(backend);
      const asDiscovery = await h.post(LIST, OWNER_HEADERS, noToken);
      expect(asDiscovery.status).toBe(200);
      expect(asDiscovery.json.result.tools).toContainEqual(expect.objectContaining({ name: 'list_courses' }));
      const mismatched = await h.post(LIST, { ...OWNER_HEADERS, 'mcp-method': 'tools/call' }, noToken);
      expect(mismatched.json.error).toMatchObject({ code: -32603, message: 'Server misconfigured' });
    });

    it('treats a body without a method as an invocation', async () => {
      const reply = await harness(backend).post({ jsonrpc: '2.0', id: 1, result: {} }, OWNER_HEADERS, noToken);
      expect(reply.json.error).toMatchObject({ code: -32603, message: 'Server misconfigured' });
    });
  });

  describe('configuration errors', () => {
    it.each([
      ['an unknown role', { CANVAS_ROLE: 'admin' }],
      ['an unreadable write allowlist', { ALLOWED_WRITE_TOOLS: 'no_such_tool' }],
      ['an http Canvas URL', { CANVAS_API_URL: 'http://canvas.example.edu' }],
      ['the token pasted into the Canvas URL', { CANVAS_API_URL: `https://${TOKEN}@canvas.example.edu` }],
      ['the token pasted in as the Canvas host', { CANVAS_API_URL: `https://${TOKEN}` }],
      ['an unknown auth mode', { AUTH_MODE: 'everyone' }],
      ['unsupported auth mode with an owner token', { AUTH_MODE: 'per_user' }],
      ['a malformed owner id hash', { OWNER_USER_ID_SHA256: 'not-a-hash' }],
      ['diagnostics with a Canvas token', { DIAGNOSTICS_ENABLED: 'true' }],
      // Read as "false" these would switch a privacy protection off; they refuse the request instead.
      ['an unreadable anonymization flag', { ENABLE_DATA_ANONYMIZATION: 'yes' }],
      ['an unreadable log-redaction flag', { LOG_REDACT_PII: '1' }],
      ['the token pasted into a privacy flag', { ENABLE_DATA_ANONYMIZATION: TOKEN }],
    ])('refuses every request with 500 and -32603 on %s, without echoing a secret', async (_label, env) => {
      const h = harness(backend);
      for (const headers of [OWNER_HEADERS, STRANGER_HEADERS, {}]) {
        for (const body of [rpc('initialize', INIT_PARAMS), LIST, CALL]) {
          const reply = await h.post(body, headers, env);
          expect(reply.status).toBe(500);
          expect(reply.headers.get('content-type')).toBe('application/json');
          expect(reply.json).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server misconfigured' } });
        }
      }
      for (const text of [...h.replies.map((reply) => reply.text), ...h.logLines]) {
        for (const secret of [TOKEN, CONFIRMATION_SECRET, SALT, encodeURIComponent(TOKEN)]) {
          expect(text).not.toContain(secret);
        }
      }
      // The detail is in the log, for the owner to read there.
      expect(h.logLines.some((line) => line.includes('"event":"server_misconfigured"') && line.includes('"blocks":"request"'))).toBe(true);
      expectNoChallenge(h.replies);
    });

    it('still answers GET with 405 on a misconfigured deployment', async () => {
      const reply = await harness(backend).send(new Request(`${SITE}/mcp`, { method: 'GET' }), { CANVAS_ROLE: 'admin' });
      expect(reply.status).toBe(405);
    });

    it.each([
      ['no Canvas token', { CANVAS_API_TOKEN: '' }],
      ['no Canvas URL', { CANVAS_API_URL: '' }],
    ])('with %s: the owner can still discover, and invocation is refused with a JSON-RPC error', async (_label, env) => {
      const h = harness(backend);
      const init = await h.post(rpc('initialize', INIT_PARAMS), OWNER_HEADERS, env);
      expect(init.status).toBe(200);
      expect(init.json.result.serverInfo.name).toBe('canvas-api');
      const list = await h.post(LIST, OWNER_HEADERS, env);
      expect(list.status).toBe(200);
      expect(list.json.result.tools).toContainEqual(expect.objectContaining({ name: 'list_courses' }));
      const call = await h.post(rpc('tools/call', { name: 'hello', arguments: {} }, 'call-7'), OWNER_HEADERS, env);
      expect(call.json).toEqual({ jsonrpc: '2.0', id: 'call-7', error: { code: -32603, message: 'Server misconfigured' } });
      expect(call.headers.get('content-type')).toBe('application/json');
      // A stranger learns nothing about the configuration: the gate answers first.
      expectDenied(await h.post(CALL, STRANGER_HEADERS, env));
      expectDenied(await h.post(LIST, {}, env));
      expectNoChallenge(h.replies);
    });

    it('refuses everyone when OWNER_EMAIL is not configured, since nobody can be the owner', async () => {
      const h = harness(backend);
      expectDenied(await h.post(LIST, OWNER_HEADERS, { OWNER_EMAIL: '' }));
      expectDenied(await h.post(CALL, OWNER_HEADERS, { OWNER_EMAIL: '' }));
      expectDenied(await h.post(LIST, { 'oai-authenticated-user-email': '' }, { OWNER_EMAIL: '' }));
      expect(h.security()[0]).toMatchObject({ config_error_codes: ['owner_email_missing'] });
    });
  });

  describe('diagnostics mode', () => {
    const env = { DIAGNOSTICS_ENABLED: 'true', CANVAS_API_TOKEN: '', CONFIRMATION_SECRET: '' };

    it('lists only hello and sites_diagnostics, without any identity', async () => {
      const h = harness(backend);
      const init = await h.post(rpc('initialize', INIT_PARAMS), {}, env);
      expect(init.status).toBe(200);
      const list = await h.post(LIST, {}, env);
      expect(list.status).toBe(200);
      expect(list.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['hello', 'sites_diagnostics']);
      expect(h.security()).toEqual([]);
    });

    it('runs the diagnostics tools without any identity', async () => {
      const h = harness(backend);
      const call = await h.post(CALL, {}, env);
      expect(call.status).toBe(200);
      expect(call.json.result.isError).toBe(false);
      expect(call.json.result.content[0].text).toContain('Hello from canvas-gpt-sites');
      const probe = await h.post(rpc('tools/call', { name: 'sites_diagnostics', arguments: { probe: 'runtime' } }), STRANGER_HEADERS, env);
      expect(probe.json.result.isError).toBe(false);
      expect(probe.json.result.structuredContent.probe).toBe('runtime');
    });

    it('still refuses browser requests, batches and GET', async () => {
      const h = harness(backend);
      expectDenied(await h.post(LIST, { origin: SITE }, env));
      expect((await h.post([LIST], {}, env)).json.error.code).toBe(-32600);
      expect((await h.send(new Request(`${SITE}/mcp`, { method: 'GET' }), env)).status).toBe(405);
    });

    it.each([
      ['a Canvas token', { CANVAS_API_TOKEN: TOKEN }],
      ['a confirmation secret', { CONFIRMATION_SECRET }],
      ['a token that is itself unusable', { CANVAS_API_TOKEN: 'bad token' }],
    ])('refuses every /mcp request when %s is also configured', async (_label, credential) => {
      const h = harness(backend);
      for (const headers of [{}, OWNER_HEADERS]) {
        for (const body of [rpc('initialize', INIT_PARAMS), LIST, CALL, rpc('ping')]) {
          const reply = await h.post(body, headers, { ...env, ...credential });
          expect(reply.status).toBe(500);
          expect(reply.json.error).toEqual({ code: -32603, message: 'Server misconfigured' });
        }
      }
      expect(h.outbound).toEqual([]);
    });

    it('is refused with an unsupported auth mode', async () => {
      const reply = await harness(backend).post(LIST, OWNER_HEADERS, { ...env, AUTH_MODE: 'per_user' });
      expect(reply.status).toBe(500);
    });
  });

  it('rejects the removed authentication mode before contacting Canvas', async () => {
    const h = harness(backend);
    const reply = await h.post(CALL, OWNER_HEADERS, { AUTH_MODE: 'per_user' });
    expect(reply.status).toBe(500);
    expect(reply.json.error).toEqual({ code: -32603, message: 'Server misconfigured' });
    expect(h.outbound).toEqual([]);
  });

  describe('denial log lines', () => {
    it('writes exactly one security line per denial, with a tag and never the email or the id', async () => {
      const h = harness(backend);
      await h.post(CALL, STRANGER_HEADERS);
      const lines = h.security();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'request_denied', route: 'mcp', reason: 'not_authorized', request_class: 'invocation' });
      expect(lines[0]?.identity_tag).toMatch(/^[0-9a-f]{12}$/);
      expect(typeof lines[0]?.request_id).toBe('string');
      const all = h.logLines.join('\n');
      expect(all).not.toContain('visitor@example.org');
      expect(all).not.toContain('user-222');
      expect(all).not.toContain(OWNER_EMAIL);
    });

    it('tags the same identity the same way and different identities differently', async () => {
      const h = harness(backend);
      await h.post(LIST, STRANGER_HEADERS);
      await h.post(CALL, STRANGER_HEADERS);
      await h.post(LIST, { 'oai-authenticated-user-id': 'user-333', 'oai-authenticated-user-email': 'other@example.org' });
      const tags = h.security().map((line) => line.identity_tag);
      expect(tags[0]).toBe(tags[1]);
      expect(tags[2]).not.toBe(tags[0]);
    });

    it('does not use an unsalted hash of the identity as the tag', async () => {
      const h = harness(backend);
      await h.post(LIST, STRANGER_HEADERS);
      const tag = String(h.security()[0]?.identity_tag);
      for (const guess of ['id:user-222', 'user-222', 'visitor@example.org', 'email:visitor@example.org']) {
        expect(sha256Hex(guess).startsWith(tag)).toBe(false);
      }
      const otherDeployment = harness(backend);
      await otherDeployment.post(LIST, STRANGER_HEADERS, {
        CANVAS_API_TOKEN: `7~${'OtherSecret'.repeat(6)}`,
        CONFIRMATION_SECRET: 'another-confirmation-secret-0123456789',
        PSEUDONYM_SALT: 'another-private-pseudonym-salt',
      });
      expect(otherDeployment.security()[0]?.identity_tag).not.toBe(tag);
    });

    it('names the reason when there is no identity, and why headers were rejected', async () => {
      const h = harness(backend);
      await h.post(LIST);
      await h.post(LIST, { 'oai-authenticated-user-email': `${OWNER_EMAIL}, x@y.example` });
      const lines = h.security();
      expect(lines[0]).toMatchObject({ reason: 'no_identity', request_class: 'discovery' });
      expect(lines[0]?.identity_tag).toBeUndefined();
      expect(lines[1]).toMatchObject({ reason: 'no_identity', identity_rejected: 'email_invalid' });
    });
  });

  describe('body size', () => {
    const big = (bytes: number): string => JSON.stringify(rpc('tools/call', { name: 'hello', arguments: { pad: 'x'.repeat(bytes) } }));

    it('caps a caller who is not the owner at 64 KiB', async () => {
      const h = harness(backend);
      for (const headers of [{}, STRANGER_HEADERS]) {
        const reply = await h.post(big(ANONYMOUS_BODY_LIMIT_BYTES), headers);
        expect(reply.status).toBe(413);
        expect(reply.json.error.code).toBe(-32000);
      }
      // Under the cap the same callers reach the gate.
      expectDenied(await h.post(big(1000), {}));
      expectNoChallenge(h.replies);
    });

    it('lets the owner send more than 64 KiB, up to MAX_REQUEST_BYTES', async () => {
      const h = harness(backend);
      const within = await h.post(big(200_000), OWNER_HEADERS);
      expect(within.status).toBe(200);
      const over = await h.post(big(200_000), OWNER_HEADERS, { MAX_REQUEST_BYTES: '100000' });
      expect(over.status).toBe(413);
      expect(over.text).toContain('100000');
    });

    it('never raises the cap above MAX_REQUEST_BYTES for an anonymous caller', async () => {
      const reply = await harness(backend).post(big(5000), {}, { MAX_REQUEST_BYTES: '2000' });
      expect(reply.status).toBe(413);
    });

    it('stops reading an anonymous chunked body mid-stream', async () => {
      let delivered = 0;
      const chunk = new Uint8Array(8192).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          delivered += 1;
          controller.enqueue(chunk);
        },
      });
      const request = new Request(`${SITE}/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: stream,
        duplex: 'half',
      } as RequestInit);
      const reply = await harness(backend).send(request);
      expect(reply.status).toBe(413);
      // Nine 8192-byte chunks exceed 64 KiB; an unbounded reader would never return.
      expect(delivered).toBeLessThanOrEqual(12);
    });
  });
});

describe('routes that must not exist', () => {
  it.each(['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback', '/settings', '/files/exports/abc', '/mcp/extra', '/MCP', '/api'])(
    'answers %s with 404 for every method',
    async (path) => {
      const h = harness('native');
      for (const method of ['GET', 'POST']) {
        const reply = await h.send(
          new Request(`${SITE}${path}`, { method, headers: { ...OWNER_HEADERS, ...(method === 'POST' ? JSON_HEADERS : {}) }, ...(method === 'POST' && { body: '{}' }) }),
        );
        expect(reply.status).toBe(404);
        expect(reply.json).toEqual({ error: 'Not found' });
      }
    },
  );
});

describe('no response is ever a 401', () => {
  it('holds across every route, method and identity', async () => {
    for (const backend of ['native', 'sdk']) {
      const h = harness(backend);
      const identities: Array<Record<string, string>> = [
        {},
        STRANGER_HEADERS,
        OWNER_HEADERS,
        { ...OWNER_HEADERS, 'oai-sites-authorization': 'x' },
        { authorization: 'Bearer nope' },
      ];
      for (const headers of identities) {
        for (const path of ['/mcp', '/', '/api/status', '/api/status/check', '/healthz', '/robots.txt', '/nope']) {
          await h.send(new Request(`${SITE}${path}`, { method: 'GET', headers }));
          await h.send(new Request(`${SITE}${path}`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(CALL) }));
          await h.send(new Request(`${SITE}${path}`, { method: 'DELETE', headers }));
        }
      }
      expect(h.replies).toHaveLength(identities.length * 7 * 3);
      expectNoChallenge(h.replies);
    }
  });

  it('holds even if a backend answers 401 with a challenge', async () => {
    vi.resetModules();
    vi.doMock('../../src/mcp/jsonrpc-native', () => ({
      createNativeBackend: () => ({
        handle: async () =>
          new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized"}}', {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer resource_metadata="https://x.example"' },
          }),
      }),
    }));
    try {
      const { createApp: createIsolatedApp } = await import('../../src/app');
      const app = createIsolatedApp({ logSink: () => undefined });
      const response = await app.fetch(
        new Request(`${SITE}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...OWNER_HEADERS }, body: JSON.stringify(LIST) }),
        { ...BASE_ENV, MCP_BACKEND: 'native' },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.text()).toContain('Unauthorized');
    } finally {
      vi.doUnmock('../../src/mcp/jsonrpc-native');
      vi.resetModules();
    }
  });

  it('turns a 401 from anything downstream into a 403 without a challenge', async () => {
    const challenged = new Response('{"x":1}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="x"', 'Content-Type': 'application/json' } });
    const cleaned = withoutAuthChallenge(challenged);
    expect(cleaned.status).toBe(403);
    expect(cleaned.headers.get('www-authenticate')).toBeNull();
    expect(cleaned.headers.get('content-type')).toBe('application/json');
    expect(await cleaned.text()).toBe('{"x":1}');

    const ok = new Response('fine', { status: 200 });
    expect(withoutAuthChallenge(ok)).toBe(ok);
    const stray = withoutAuthChallenge(new Response('x', { status: 403, headers: { 'WWW-Authenticate': 'Basic' } }));
    expect(stray.status).toBe(403);
    expect(stray.headers.get('www-authenticate')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// src/http/security.ts on its own
// ---------------------------------------------------------------------------

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}/mcp`, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readBodyCapped (upstream _read_body)', () => {
  it('reads a small body', async () => {
    expect(await readBodyCapped(streamRequest(streamOf([bytes('token=abc')])), 8192)).toEqual({ ok: true, text: 'token=abc' });
  });

  it('refuses an oversized body', async () => {
    expect(await readBodyCapped(streamRequest(streamOf([bytes('x'.repeat(10_000))])), 8192)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses an oversized chunked body: many small chunks must not slip past the cap', async () => {
    const chunks = Array.from({ length: 20 }, () => bytes('x'.repeat(1000)));
    expect(await readBodyCapped(streamRequest(streamOf(chunks)), 8192)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('stops before consuming the whole stream', async () => {
    let delivered = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += 1;
        controller.enqueue(bytes('x'.repeat(1000)));
      },
    });
    expect(await readBodyCapped(streamRequest(endless), 8192)).toEqual({ ok: false, reason: 'too_large' });
    // Nine 1000-byte chunks exceed 8192; an unbounded reader would loop forever.
    expect(delivered).toBeLessThanOrEqual(12);
  });

  it('reads a body of exactly the cap and refuses one byte more', async () => {
    expect((await readBodyCapped(streamRequest(streamOf([bytes('x'.repeat(8192))])), 8192)).ok).toBe(true);
    expect((await readBodyCapped(streamRequest(streamOf([bytes('x'.repeat(8193))])), 8192)).ok).toBe(false);
  });

  it('counts bytes, not characters', async () => {
    const text = 'é'.repeat(3000);
    expect(await readBodyCapped(streamRequest(streamOf([bytes(text)])), 5999)).toEqual({ ok: false, reason: 'too_large' });
    expect(await readBodyCapped(streamRequest(streamOf([bytes(text)])), 6000)).toEqual({ ok: true, text });
  });

  it('joins a multi-byte character split across chunks', async () => {
    const encoded = bytes('aé€b');
    const result = await readBodyCapped(streamRequest(streamOf([encoded.slice(0, 2), encoded.slice(2, 4), encoded.slice(4)])), 100);
    expect(result).toEqual({ ok: true, text: 'aé€b' });
  });

  it('refuses on the declared Content-Length before reading anything', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(bytes('x'));
        controller.close();
      },
    });
    const result = await readBodyCapped(streamRequest(stream, { 'content-length': '999999' }), 8192);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('does not trust a small declared Content-Length', async () => {
    const result = await readBodyCapped(streamRequest(streamOf([bytes('x'.repeat(10_000))]), { 'content-length': '10' }), 8192);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('reads a request without a body as empty text', async () => {
    expect(await readBodyCapped(new Request(`${SITE}/mcp`, { method: 'POST' }), 8192)).toEqual({ ok: true, text: '' });
  });

  it('reports bytes that are not UTF-8 as unreadable', async () => {
    expect(await readBodyCapped(streamRequest(streamOf([new Uint8Array([0xff, 0xfe])])), 8192)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports a stream that fails as unreadable', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection reset');
      },
    });
    expect(await readBodyCapped(streamRequest(failing), 8192)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('declaredContentLength (upstream _declared_content_length)', () => {
  it('parses a declared length', () => {
    expect(declaredContentLength(new Headers({ 'content-length': '123' }))).toBe(123);
  });

  it('is case-insensitive', () => {
    expect(declaredContentLength(new Headers({ 'Content-Length': '7' }))).toBe(7);
  });

  it('returns null when absent or unparseable', () => {
    expect(declaredContentLength(new Headers())).toBeNull();
    expect(declaredContentLength(new Headers({ 'content-length': 'abc' }))).toBeNull();
    expect(declaredContentLength(new Headers({ 'content-length': '-5' }))).toBeNull();
    expect(declaredContentLength(new Headers({ 'content-length': '12, 12' }))).toBeNull();
    expect(declaredContentLength(new Headers({ 'content-length': '1e3' }))).toBeNull();
  });
});

describe('bodyLimitFor', () => {
  it('is 64 KiB for a caller who is not authorized and the configured limit for one who is', () => {
    expect(ANONYMOUS_BODY_LIMIT_BYTES).toBe(65536);
    expect(bodyLimitFor(false, { maxRequestBytes: 1_048_576 })).toBe(65536);
    expect(bodyLimitFor(true, { maxRequestBytes: 1_048_576 })).toBe(1_048_576);
    expect(bodyLimitFor(false, { maxRequestBytes: 1000 })).toBe(1000);
    expect(bodyLimitFor(true, { maxRequestBytes: 1000 })).toBe(1000);
  });
});

describe('browserRequestMarker', () => {
  it('names the header that marks a browser request', () => {
    expect(browserRequestMarker(new Headers({ Origin: 'https://x.example' }))).toBe('origin');
    expect(browserRequestMarker(new Headers({ 'Sec-Fetch-Site': 'none' }))).toBe('sec-fetch-site');
    expect(browserRequestMarker(new Headers({ 'sec-fetch-storage-access': 'active' }))).toBe('sec-fetch-storage-access');
    expect(browserRequestMarker(new Headers({ origin: '' }))).toBe('origin');
  });

  it('is null for a server-to-server request', () => {
    expect(browserRequestMarker(new Headers({ 'content-type': 'application/json', 'user-agent': 'openai-mcp/1.0', 'sec-ch-ua': '"x"' }))).toBeNull();
  });
});

describe('isAllowedHost', () => {
  const request = (url: string, host?: string): Request => new Request(url, host === undefined ? {} : { headers: { host } });

  it('allows every host when the list is empty', () => {
    expect(isAllowedHost(request('https://anything.example/'), { allowedHosts: [] })).toBe(true);
  });

  it('matches the URL host when there is no Host header, with or without the port', () => {
    expect(isAllowedHost(request('https://site.example/mcp'), { allowedHosts: ['site.example'] })).toBe(true);
    expect(isAllowedHost(request('https://site.example:8443/mcp'), { allowedHosts: ['site.example'] })).toBe(true);
    expect(isAllowedHost(request('https://site.example:8443/mcp'), { allowedHosts: ['site.example:8443'] })).toBe(true);
    expect(isAllowedHost(request('https://site.example:8443/mcp'), { allowedHosts: ['site.example:9000'] })).toBe(false);
  });

  it('prefers the Host header', () => {
    expect(isAllowedHost(request('https://site.example/mcp', 'evil.example'), { allowedHosts: ['site.example'] })).toBe(false);
    expect(isAllowedHost(request('https://internal.invalid/mcp', 'Site.Example'), { allowedHosts: ['site.example'] })).toBe(true);
  });

  it('does not match a suffix, a prefix or a subdomain', () => {
    for (const host of ['evil-site.example', 'site.example.evil.example', 'sub.site.example', 'site.exampl']) {
      expect(isAllowedHost(request(`https://${host}/mcp`), { allowedHosts: ['site.example'] })).toBe(false);
    }
  });
});

describe('hasSameOriginHeader', () => {
  const request = (origin?: string, extra: Record<string, string> = {}): Request =>
    new Request(`${SITE}/api/status/check`, { method: 'POST', headers: { ...(origin !== undefined && { origin }), ...extra } });

  it('needs an Origin header naming the request origin', () => {
    expect(hasSameOriginHeader(request(SITE))).toBe(true);
    expect(hasSameOriginHeader(request())).toBe(false);
    expect(hasSameOriginHeader(request('null'))).toBe(false);
    expect(hasSameOriginHeader(request(''))).toBe(false);
    expect(hasSameOriginHeader(request('https://evil.example'))).toBe(false);
    expect(hasSameOriginHeader(request('http://site.example'))).toBe(false);
    expect(hasSameOriginHeader(request('https://site.example:8443'))).toBe(false);
    expect(hasSameOriginHeader(request(`${SITE}/`))).toBe(false);
  });

  it('does not accept an Origin that merely matches a forged Host of another scheme', () => {
    expect(hasSameOriginHeader(request('http://evil.example', { host: 'evil.example' }))).toBe(false);
  });
});
