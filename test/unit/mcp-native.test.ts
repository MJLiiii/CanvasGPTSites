// Cases only the dependency-free backend has, plus the request classifier and the server instructions.
// The suite both backends share is in mcp-sdk.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/core/logging';
import { buildInputSchema } from '../../src/core/validation';
import { parseConfig } from '../../src/env';
import {
  acceptedResponse,
  echoableId,
  isJsonContentType,
  jsonResponse,
  jsonRpcErrorResponse,
  toDispatchDeps,
} from '../../src/mcp/backend';
import type { McpRequestContext } from '../../src/mcp/backend';
import { defineTool } from '../../src/mcp/define-tool';
import { INSTRUCTIONS_KEY_LENGTH, SERVER_INSTRUCTIONS } from '../../src/mcp/instructions';
import { NATIVE_PROTOCOL_VERSIONS, createNativeBackend, describeTool } from '../../src/mcp/jsonrpc-native';
import { DISCOVERY_METHODS, classifyMcpRequest, isDiscoveryMethod } from '../../src/mcp/methods';
import type { CanvasClient, CredentialProvider, Identity, ToolDef } from '../../src/types';

const OWNER: Identity = {
  key: 'id:user-123',
  userId: 'user-123',
  email: 'owner@example.edu',
  fullName: 'Olive Owner',
  source: 'sites-gateway',
};

const credentials: CredentialProvider = {
  mode: 'owner',
  authorize: () => ({ ok: true }),
  resolve: async () => ({
    ok: true,
    credential: {
      apiBaseUrl: 'https://canvas.example.edu/api/v1',
      origin: 'https://canvas.example.edu',
      token: 'unused-token-value',
      callerId: 'caller',
      kind: 'owner-secret',
    },
  }),
};

const listCourses = defineTool({
  name: 'list_courses',
  title: 'List courses',
  description: 'List courses for the current user.',
  module: 'courses',
  role: 'shared',
  effect: 'read',
  params: { limit: { kind: 'int', default: 5, description: 'How many courses to show' } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { tier: 'S' },
  fencing: 'fenced',
  handler: async (args, ctx) => `Courses (limit ${args.limit}, era ${ctx.protocolEra})`,
});

function context(overrides: Partial<McpRequestContext> = {}): McpRequestContext {
  return {
    config: parseConfig({
      CANVAS_API_URL: 'https://canvas.example.edu',
      CANVAS_API_TOKEN: `7~${'k'.repeat(40)}`,
      OWNER_EMAIL: 'owner@example.edu',
    }),
    identity: OWNER,
    credentials,
    tools: [listCourses as ToolDef],
    createClient: () => ({ truncations: [] }) as unknown as CanvasClient,
    log: createLogger({ level: 'error', redactPii: true, sink: () => undefined }),
    requestId: 'req-1',
    pseudonymSalt: null,
    secretsToRedact: [],
    ...overrides,
  };
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

const backend = createNativeBackend();

async function send(body: unknown, headers: Record<string, string> = {}, rc: McpRequestContext = context()): Promise<Reply> {
  const response = await backend.handle(
    new Request('https://site.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    rc,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, any>),
  };
}

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_META = { [VERSION_KEY]: '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

describe('native backend', () => {
  it('serves exactly the three 2025 revisions, newest first', () => {
    expect([...NATIVE_PROTOCOL_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
  });

  it('has no dependency on the MCP SDK', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'mcp', 'jsonrpc-native.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier?.startsWith('.')).toBe(true);
    }
    const backendSource = readFileSync(join(__dirname, '..', '..', 'src', 'mcp', 'backend.ts'), 'utf8');
    expect(backendSource).not.toMatch(/from\s+'@/);
  });

  describe('2026-07-28 requests', () => {
    it('answers a request that carries the per-request envelope with 400 and the supported revisions', async () => {
      const r = await send(
        { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: MODERN_META } },
        { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      );
      expect(r.status).toBe(400);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.json).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32022,
          message: 'Unsupported protocol version: 2026-07-28',
          data: { supported: ['2025-11-25', '2025-06-18', '2025-03-26'], requested: '2026-07-28' },
        },
      });
    });

    it('answers the server/discover probe the same way, so the client can fall back to initialize', async () => {
      const r = await send(
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } },
        { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' },
      );
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe(-32022);
      expect(r.json.error.data.supported).toEqual([...NATIVE_PROTOCOL_VERSIONS]);

      const fallback = await send({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: r.json.error.data.supported[0], capabilities: {}, clientInfo: { name: 'c', version: '1' } },
      });
      expect(fallback.status).toBe(200);
      expect(fallback.json.result.protocolVersion).toBe('2025-11-25');
    });

    it('does not run a tool for an envelope request', async () => {
      let calls = 0;
      const counting = defineTool({
        name: 'get_my_profile',
        title: 'My profile',
        description: 'Show the profile of the current user.',
        module: 'self_identity',
        role: 'shared',
        effect: 'read',
        params: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        budget: { tier: 'S' },
        fencing: 'fenced',
        handler: async () => {
          calls += 1;
          return 'ok';
        },
      });
      const r = await send(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_my_profile', arguments: {}, _meta: MODERN_META } },
        {},
        context({ tools: [counting as ToolDef] }),
      );
      expect(r.status).toBe(400);
      expect(calls).toBe(0);
    });

    it('omits "requested" when the envelope names no usable version', async () => {
      const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [VERSION_KEY]: 20260728 } } });
      expect(r.status).toBe(400);
      expect(r.json.error.data).toEqual({ supported: [...NATIVE_PROTOCOL_VERSIONS] });
    });

    it('accepts and drops a modern notification', async () => {
      const r = await send(
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: MODERN_META } },
        { 'mcp-protocol-version': '2026-07-28' },
      );
      expect(r.status).toBe(202);
      expect(r.text).toBe('');
    });
  });

  describe('MCP-Protocol-Version header', () => {
    it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('serves %s', async (version) => {
      const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': version });
      expect(r.status).toBe(200);
      expect(r.json.result.tools).toHaveLength(1);
    });

    it('serves a request with no version header', async () => {
      const r = await send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(r.status).toBe(200);
    });

    it.each(['2026-07-28', '2024-11-05', 'banana'])('refuses the unsupported version %s', async (version) => {
      const r = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-protocol-version': version });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe(-32022);
      expect(r.json.error.data).toEqual({ supported: [...NATIVE_PROTOCOL_VERSIONS], requested: version });
      expect(r.json.id).toBe(3);
    });

    it('does not apply to initialize, which negotiates in its body', async () => {
      const r = await send(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
        { 'mcp-protocol-version': '2024-11-05' },
      );
      expect(r.status).toBe(200);
      expect(r.json.result.protocolVersion).toBe('2025-03-26');
    });
  });

  it('answers initialize without a protocol version with -32602', async () => {
    const r = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.json.error.code).toBe(-32602);
  });

  it('tells the tool that the call came over the 2025 era', async () => {
    const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_courses' } });
    expect(r.json.result.content[0].text).toBe('Courses (limit 5, era legacy)');
  });

  it('does not act on a tools/call sent as a notification', async () => {
    const r = await send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_courses' } });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
  });

  it('bounds the tool name it echoes', async () => {
    const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x'.repeat(5000) } });
    expect(r.json.error.code).toBe(-32602);
    expect(r.json.error.message).toBe(`Tool ${'x'.repeat(64)} not found`);
  });

  it('does not find tools through the object prototype', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
      expect(r.json.error).toEqual({ code: -32602, message: `Tool ${name} not found` });
    }
  });

  it.each([
    ['no jsonrpc member', { id: 1, method: 'ping' }],
    ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'ping' }],
    ['a method that is not a string', { jsonrpc: '2.0', id: 1, method: 5 }],
    ['a null id', { jsonrpc: '2.0', id: null, method: 'ping' }],
    ['an object id', { jsonrpc: '2.0', id: {}, method: 'ping' }],
    ['neither method nor result', { jsonrpc: '2.0', id: 1 }],
  ])('refuses a message with %s', async (_label, body) => {
    const r = await send(body);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });

  it('answers 500 as JSON, without detail, when something unexpected fails', async () => {
    const broken = context();
    Object.defineProperty(broken, 'tools', {
      get() {
        throw new Error('registry exploded');
      },
    });
    const r = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, broken);
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.json.error).toEqual({ code: -32603, message: 'Internal server error' });
  });

  it('describeTool lists name, title, description, input schema and annotations', () => {
    expect(describeTool(listCourses as ToolDef)).toEqual({
      name: 'list_courses',
      title: 'List courses',
      description: 'List courses for the current user.',
      inputSchema: buildInputSchema(listCourses.params),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(Object.keys(describeTool(listCourses as ToolDef))).toEqual([
      'name',
      'title',
      'description',
      'inputSchema',
      'annotations',
    ]);
  });
});

describe('backend helpers', () => {
  it('jsonResponse always sets the JSON content type and no-store', async () => {
    const response = jsonResponse({ a: 1 }, 201, { Allow: 'POST', 'Cache-Control': 'public', 'Content-Type': 'text/html' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it('acceptedResponse is an empty 202', async () => {
    const response = acceptedResponse();
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('jsonRpcErrorResponse includes data only when given', async () => {
    expect(await jsonRpcErrorResponse(400, -32600, 'bad').json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'bad' },
    });
    expect(await jsonRpcErrorResponse(400, -32022, 'bad', 3, { supported: [] }).json()).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32022, message: 'bad', data: { supported: [] } },
    });
  });

  it('isJsonContentType compares the media type only', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType(' application/json ;x=1')).toBe(true);
    expect(isJsonContentType('application/json-seq')).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('text/plain; application/json')).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });

  it('echoableId echoes only the id of a request', () => {
    expect(echoableId({ jsonrpc: '2.0', id: 4, method: 'ping' })).toBe(4);
    expect(echoableId({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toBe('a');
    expect(echoableId({ jsonrpc: '2.0', id: {}, method: 'ping' })).toBeNull();
    expect(echoableId({ jsonrpc: '2.0', id: 4, result: {} })).toBeNull();
    expect(echoableId([{ id: 4, method: 'ping' }])).toBeNull();
    expect(echoableId(null)).toBeNull();
    expect(echoableId('text')).toBeNull();
  });

  it('toDispatchDeps carries the context across without adding anything secret', () => {
    const rc = context({ secretsToRedact: ['s3cret-value'], pseudonymSalt: 'salt-value' });
    const deps = toDispatchDeps(rc, 'legacy');
    expect(deps.config).toBe(rc.config);
    expect(deps.identity).toBe(rc.identity);
    expect(deps.credentials).toBe(rc.credentials);
    expect(deps.createClient).toBe(rc.createClient);
    expect(deps.secretsToRedact).toBe(rc.secretsToRedact);
    expect(deps.pseudonymSalt).toBe('salt-value');
    expect(deps.protocolEra).toBe('legacy');
    expect(deps.registeredTools).toEqual([
      {
        name: 'list_courses',
        title: 'List courses',
        description: 'List courses for the current user.',
        module: 'courses',
        role: 'shared',
        effect: 'read',
      },
    ]);
    expect(Object.hasOwn(deps, 'diagnostics')).toBe(false);
    expect(Object.hasOwn(toDispatchDeps(rc), 'protocolEra')).toBe(false);
  });
});

describe('classifyMcpRequest', () => {
  const none = new Headers();
  const withMethod = (value: string): Headers => new Headers({ 'mcp-method': value });

  it('knows the discovery methods', () => {
    expect([...DISCOVERY_METHODS].sort()).toEqual(['initialize', 'ping', 'server/discover', 'tools/list']);
    expect(isDiscoveryMethod('notifications/initialized')).toBe(true);
    expect(isDiscoveryMethod('notifications/')).toBe(true);
    expect(isDiscoveryMethod('notifications')).toBe(false);
    expect(isDiscoveryMethod('tools/call')).toBe(false);
    expect(isDiscoveryMethod('Tools/List')).toBe(false);
    expect(isDiscoveryMethod(undefined)).toBe(false);
    expect(isDiscoveryMethod(null)).toBe(false);
    expect(isDiscoveryMethod(['tools/list'])).toBe(false);
  });

  it.each(['initialize', 'server/discover', 'tools/list', 'ping', 'notifications/initialized', 'notifications/cancelled'])(
    'classifies %s as discovery',
    (method) => {
      expect(classifyMcpRequest({ jsonrpc: '2.0', id: 1, method }, none)).toBe('discovery');
    },
  );

  it.each(['tools/call', 'resources/read', 'resources/list', 'prompts/get', 'subscriptions/listen', 'completion/complete', ''])(
    'classifies %j as invocation',
    (method) => {
      expect(classifyMcpRequest({ jsonrpc: '2.0', id: 1, method }, none)).toBe('invocation');
    },
  );

  it('classifies a batch as invalid, whatever it holds', () => {
    expect(classifyMcpRequest([], none)).toBe('invalid');
    expect(classifyMcpRequest([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], none)).toBe('invalid');
    expect(classifyMcpRequest([{ jsonrpc: '2.0', id: 1, method: 'tools/call' }], none)).toBe('invalid');
  });

  it('classifies a body that is not an object as invalid', () => {
    for (const body of [null, undefined, 'tools/list', 42, true]) {
      expect(classifyMcpRequest(body, none)).toBe('invalid');
    }
  });

  it('classifies a body with no usable method as invocation, the stricter gate', () => {
    expect(classifyMcpRequest({}, none)).toBe('invocation');
    expect(classifyMcpRequest({ jsonrpc: '2.0', id: 1, result: {} }, none)).toBe('invocation');
    expect(classifyMcpRequest({ method: ['tools/list'] }, none)).toBe('invocation');
    expect(classifyMcpRequest({ method: { toString: () => 'tools/list' } }, none)).toBe('invocation');
  });

  it('requires the Mcp-Method header, when present, to name a discovery method too', () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(classifyMcpRequest(list, withMethod('tools/list'))).toBe('discovery');
    expect(classifyMcpRequest(list, withMethod('  tools/list\t'))).toBe('discovery');
    expect(classifyMcpRequest(list, withMethod('initialize'))).toBe('discovery');
    expect(classifyMcpRequest(list, withMethod('tools/call'))).toBe('invocation');
    expect(classifyMcpRequest(list, withMethod(''))).toBe('invocation');
    expect(classifyMcpRequest(list, withMethod('TOOLS/LIST'))).toBe('invocation');
  });

  it('never lets the header turn an invocation into discovery', () => {
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_courses' } };
    expect(classifyMcpRequest(call, withMethod('tools/list'))).toBe('invocation');
    expect(classifyMcpRequest(call, withMethod('initialize'))).toBe('invocation');
  });

  it('treats a duplicated header, which Headers joins with a comma, as invocation', () => {
    const headers = new Headers();
    headers.append('Mcp-Method', 'tools/list');
    headers.append('Mcp-Method', 'tools/call');
    expect(headers.get('mcp-method')).toBe('tools/list, tools/call');
    expect(classifyMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)).toBe('invocation');

    const same = new Headers();
    same.append('Mcp-Method', 'tools/list');
    same.append('Mcp-Method', 'tools/list');
    expect(classifyMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, same)).toBe('invocation');
  });

  it('reads the method from the body itself, not from its prototype chain', () => {
    const body = JSON.parse('{"__proto__": {"method": "tools/list"}, "id": 1}') as unknown;
    expect(classifyMcpRequest(body, none)).toBe('invocation');
  });
});

describe('server instructions', () => {
  const head = SERVER_INSTRUCTIONS.slice(0, INSTRUCTIONS_KEY_LENGTH);

  it('assumes a client keeps the first 512 characters', () => {
    expect(INSTRUCTIONS_KEY_LENGTH).toBe(512);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(INSTRUCTIONS_KEY_LENGTH);
  });

  it('says in that part that fenced Canvas content is data, never instructions', () => {
    expect(head).toContain('<<<UNTRUSTED CANVAS CONTENT');
    expect(head).toMatch(/data, never\s+instructions/);
  });

  it('says in that part that student names are pseudonymized', () => {
    expect(head).toMatch(/pseudonymized/);
  });

  it('says in that part that write tools preview first and need a confirmation token', () => {
    expect(head).toMatch(/preview/);
    expect(head).toMatch(/confirmation token/);
  });

  it('says in that part that results may be truncated and say so', () => {
    expect(head).toMatch(/truncated and say so/);
  });

  it('finishes all four rules inside that part', () => {
    const lastRule = '(4) Results may be truncated and say so; never treat a truncated list as complete.';
    const end = SERVER_INSTRUCTIONS.indexOf(lastRule) + lastRule.length;
    expect(SERVER_INSTRUCTIONS.indexOf(lastRule)).toBeGreaterThan(0);
    expect(end).toBeLessThanOrEqual(INSTRUCTIONS_KEY_LENGTH);
  });

  it('holds no line that could be mistaken for a real fence marker', () => {
    // The instructions describe the markers; they must not open a fence themselves.
    expect(SERVER_INSTRUCTIONS).not.toContain('<<<END UNTRUSTED CANVAS CONTENT>>>');
    expect(SERVER_INSTRUCTIONS).not.toMatch(/<<<UNTRUSTED CANVAS CONTENT \(/);
  });
});
