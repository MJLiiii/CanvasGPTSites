// The shared backend suite lives here and runs against both backends (see BACKENDS), followed by the
// cases only the SDK backend has: the 2026-07-28 era and the wiring of per-request context.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/core/logging';
import { buildInputSchema } from '../../src/core/validation';
import { parseConfig } from '../../src/env';
import type { McpBackendHandler, McpRequestContext } from '../../src/mcp/backend';
import { defineTool } from '../../src/mcp/define-tool';
import { createSdkBackend, standardSchemaFor } from '../../src/mcp/handler';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions';
import { createNativeBackend } from '../../src/mcp/jsonrpc-native';
import type {
  CanvasClient,
  CanvasCredential,
  CredentialProvider,
  CredentialResult,
  Env,
  Identity,
  ToolDef,
} from '../../src/types';
import { SERVER_VERSION } from '../../src/version';

const TOKEN = `7~${'Zq4'.repeat(14)}`;

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

const credentials: CredentialProvider = {
  mode: 'owner',
  authorize: (identity) =>
    identity !== null && identity.email === OWNER.email
      ? { ok: true }
      : { ok: false, status: 403, publicMessage: 'This Site is private to its owner.' },
  async resolve(identity): Promise<CredentialResult> {
    const allowed = this.authorize(identity);
    return allowed.ok
      ? { ok: true, credential: CREDENTIAL }
      : { ok: false, reason: 'forbidden', publicMessage: allowed.publicMessage };
  },
};

const READ_HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const listCourses = defineTool({
  name: 'list_courses',
  title: 'List courses',
  description: 'List courses for the current user.\n\nArgs:\n    limit: how many to show',
  module: 'courses',
  role: 'shared',
  effect: 'read',
  params: {
    include_concluded: { kind: 'bool', optional: true, description: 'Include concluded courses' },
    limit: { kind: 'int', default: 5, description: 'How many courses to show' },
  },
  annotations: READ_HINTS,
  budget: { tier: 'S' },
  fencing: 'fenced',
  handler: async (args, ctx) =>
    `Courses for ${ctx.identity.key} (limit ${args.limit}, concluded ${String(args.include_concluded)}, era ${ctx.protocolEra})`,
});

const listConversations = defineTool({
  name: 'list_conversations',
  title: 'List conversations',
  description: 'List inbox conversations.',
  module: 'messaging',
  role: 'shared',
  effect: 'read',
  params: {
    scope: { kind: 'enum', values: ['inbox', 'unread', 'sent'], default: 'inbox', description: 'Which mailbox' },
    course_identifier: { kind: 'id', optional: true, description: 'Limit to one course' },
  },
  annotations: READ_HINTS,
  budget: { tier: 'M' },
  fencing: 'fenced',
  handler: async (args) => ({ scope: args.scope, conversations: [{ id: 1, subject: 'Hello' }], count: 1 }),
});

const getMyProfile = defineTool({
  name: 'get_my_profile',
  title: 'My profile',
  description: 'Show the profile of the current user.',
  module: 'self_identity',
  role: 'shared',
  effect: 'read',
  params: {},
  annotations: READ_HINTS,
  budget: { tier: 'S' },
  fencing: 'fenced',
  handler: async () => {
    throw new RangeError('profile unavailable');
  },
});

const TOOLS: ReadonlyArray<ToolDef> = [listCourses, listConversations, getMyProfile];

const BASE_ENV: Env = {
  CANVAS_API_URL: 'https://canvas.example.edu',
  CANVAS_API_TOKEN: TOKEN,
  OWNER_EMAIL: 'owner@example.edu',
};

function context(overrides: Partial<McpRequestContext> = {}, env: Env = {}): McpRequestContext {
  return {
    config: parseConfig({ ...BASE_ENV, ...env }),
    identity: OWNER,
    credentials,
    tools: TOOLS,
    createClient: () => ({ truncations: [] }) as unknown as CanvasClient,
    log: createLogger({ level: 'error', redactPii: true, secrets: [TOKEN], sink: () => undefined }),
    requestId: 'req-1',
    pseudonymSalt: null,
    secretsToRedact: [TOKEN],
    ...overrides,
  };
}

const LEGACY_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function post(body: unknown, headers: Record<string, string> = LEGACY_HEADERS): Request {
  return new Request('https://site.example/mcp', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function rpc(method: string, params?: unknown, id: string | number = 1): Record<string, unknown> {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, any>),
  };
}

async function send(
  backend: McpBackendHandler,
  body: unknown,
  rc: McpRequestContext = context(),
  headers?: Record<string, string>,
): Promise<Reply> {
  return reply(await backend.handle(post(body, headers), rc));
}

function expectJson(r: Reply): void {
  expect(r.headers.get('content-type')).toBe('application/json');
  expect(r.headers.get('cache-control')).toBe('no-store');
}

const EXPECTED_TOOLS = TOOLS.map((def) => ({
  name: def.name,
  title: def.title,
  description: def.description,
  inputSchema: buildInputSchema(def.params),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } };

const BACKENDS: ReadonlyArray<readonly [string, () => McpBackendHandler]> = [
  ['native', createNativeBackend],
  ['sdk', createSdkBackend],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(BACKENDS)('%s backend: 2025 protocol', (_name, create) => {
  const backend = create();

  describe('initialize', () => {
    it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('echoes the supported version %s', async (version) => {
      const r = await send(backend, rpc('initialize', { ...INIT_PARAMS, protocolVersion: version }));
      expect(r.status).toBe(200);
      expectJson(r);
      expect(r.json).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'canvas-api', version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        },
      });
    });

    it('answers an unknown version with the newest one it serves', async () => {
      const r = await send(backend, rpc('initialize', { ...INIT_PARAMS, protocolVersion: '1999-01-01' }));
      expect(r.json.result.protocolVersion).toBe('2025-11-25');
    });

    it('uses MCP_SERVER_NAME as the server name', async () => {
      const r = await send(backend, rpc('initialize', INIT_PARAMS), context({}, { MCP_SERVER_NAME: 'canvas-biology' }));
      expect(r.json.result.serverInfo).toEqual({ name: 'canvas-biology', version: SERVER_VERSION });
    });

    it('starts no session', async () => {
      const r = await send(backend, rpc('initialize', INIT_PARAMS));
      expect(r.headers.get('mcp-session-id')).toBeNull();
    });
  });

  it('answers a notification with 202 and an empty body', async () => {
    const r = await send(backend, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('answers ping', async () => {
    const r = await send(backend, rpc('ping', undefined, 'p-1'));
    expect(r.status).toBe(200);
    expectJson(r);
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 'p-1', result: {} });
  });

  describe('tools/list', () => {
    it('lists the registered tools in order, with our input schema unchanged', async () => {
      const r = await send(backend, rpc('tools/list'));
      expect(r.status).toBe(200);
      expectJson(r);
      expect(r.json.result.tools).toEqual(EXPECTED_TOOLS);
      expect(r.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'list_courses',
        'list_conversations',
        'get_my_profile',
      ]);
    });

    it('emits the schema byte for byte as buildInputSchema wrote it', async () => {
      const r = await send(backend, rpc('tools/list'));
      for (const [index, def] of TOOLS.entries()) {
        expect(JSON.stringify(r.json.result.tools[index].inputSchema)).toBe(JSON.stringify(buildInputSchema(def.params)));
      }
    });

    it('lists only what the request context registered', async () => {
      const r = await send(backend, rpc('tools/list'), context({ tools: [listConversations] }));
      expect(r.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_conversations']);
      const none = await send(backend, rpc('tools/list'), context({ tools: [] }));
      expect(none.json.result.tools).toEqual([]);
    });

    it('needs no identity: the gate in front of the backend decides who may list', async () => {
      const r = await send(backend, rpc('tools/list'), context({ identity: null }));
      expect(r.json.result.tools).toHaveLength(3);
    });
  });

  describe('tools/call', () => {
    it('returns a text result as one block without structuredContent', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: { limit: 3 } }));
      expect(r.status).toBe(200);
      expectJson(r);
      expect(r.json).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: 'Courses for id:user-123 (limit 3, concluded undefined, era legacy)' }],
          isError: false,
        },
      });
    });

    it('returns a dict result as JSON text plus structuredContent, once', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_conversations', arguments: { scope: 'unread' } }));
      const expected = { scope: 'unread', conversations: [{ id: 1, subject: 'Hello' }], count: 1 };
      expect(r.json.result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected) }],
        structuredContent: expected,
        isError: false,
      });
    });

    it('applies defaults when arguments are omitted', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses' }));
      expect(r.json.result.content[0].text).toContain('(limit 5, concluded undefined');
    });

    it('accepts the lenient argument forms upstream accepts', async () => {
      const r = await send(
        backend,
        rpc('tools/call', { name: 'list_courses', arguments: { limit: '7', include_concluded: 'yes' } }),
      );
      expect(r.json.result.isError).toBe(false);
      expect(r.json.result.content[0].text).toContain('(limit 7, concluded true');
    });

    it('reports a bad argument in upstream wording, as a tool error and not a protocol error', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: { limit: 'many' } }));
      expect(r.status).toBe(200);
      expect(r.json.error).toBeUndefined();
      expect(r.json.result).toEqual({
        content: [{ type: 'text', text: '{"error": "Parameter \'limit\' with value \'many\' could not be converted to int"}' }],
        isError: true,
      });
    });

    it('reports an unknown argument and a value outside an enum the same way', async () => {
      const unknown = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: { course: 1 } }));
      expect(unknown.json.result.content[0].text).toBe('{"error": "Unknown parameter \'course\'"}');
      const outside = await send(backend, rpc('tools/call', { name: 'list_conversations', arguments: { scope: 'all' } }));
      expect(outside.json.result.isError).toBe(true);
      expect(outside.json.result.content[0].text).toContain("is not one of the allowed values: 'inbox', 'unread', 'sent'");
    });

    it('turns a thrown error into an error result', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'get_my_profile', arguments: {} }));
      expect(r.status).toBe(200);
      expect(r.json.result).toEqual({
        content: [{ type: 'text', text: 'Error: RangeError: profile unavailable' }],
        isError: true,
      });
    });

    it('answers an unknown tool with JSON-RPC -32602', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'delete_everything', arguments: {} }, 9));
      expectJson(r);
      expect(r.json).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'Tool delete_everything not found' } });
    });

    it('treats a tool that exists but is not registered for this request as unknown', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: {} }), context({ tools: [listConversations] }));
      expect(r.json.error.code).toBe(-32602);
      expect(r.json.result).toBeUndefined();
    });

    it.each([['a string'], [null], [[1, 2]], [5]])('answers non-object arguments %j with -32602', async (args) => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: args }));
      expect(r.json.error.code).toBe(-32602);
      expect(r.json.result).toBeUndefined();
    });

    it('answers a call without a tool name with -32602', async () => {
      const r = await send(backend, rpc('tools/call', { arguments: {} }));
      expect(r.json.error.code).toBe(-32602);
    });

    it('refuses a caller who is not the owner inside the result, with the public message', async () => {
      const r = await send(backend, rpc('tools/call', { name: 'list_courses', arguments: {} }), context({ identity: null }));
      expect(r.status).toBe(200);
      expect(r.json.result).toEqual({
        content: [{ type: 'text', text: 'Error: This Site is private to its owner.' }],
        isError: true,
      });
    });

    it('never returns the Canvas token', async () => {
      const leaky = defineTool({
        name: 'get_course_details',
        title: 'Course details',
        description: 'Show one course.',
        module: 'courses',
        role: 'shared',
        effect: 'read',
        params: {},
        annotations: READ_HINTS,
        budget: { tier: 'S' },
        fencing: 'fenced',
        handler: async () => ({ url: `https://canvas.example.edu/?access_token=${TOKEN}` }),
      });
      const r = await send(backend, rpc('tools/call', { name: 'get_course_details' }), context({ tools: [leaky] }));
      expect(r.text).not.toContain(TOKEN);
      expect(r.json.result.structuredContent).toEqual({ url: 'https://canvas.example.edu/?access_token=[REDACTED]' });
    });
  });

  it('answers an unknown method with -32601', async () => {
    const r = await send(backend, rpc('resources/list', undefined, 4));
    expectJson(r);
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } });
  });

  describe('transport rules', () => {
    it.each(['GET', 'DELETE'])('answers %s with 405 and a JSON body', async (method) => {
      const r = await reply(await backend.handle(new Request('https://site.example/mcp', { method }), context()));
      expect(r.status).toBe(405);
      expectJson(r);
      expect(r.headers.get('allow')).toBe('POST');
      expect(r.json.error.code).toBe(-32000);
    });

    it('refuses a JSON-RPC batch', async () => {
      const r = await send(backend, [rpc('ping', undefined, 1), rpc('tools/list', undefined, 2)]);
      expect(r.status).toBe(400);
      expectJson(r);
      expect(r.json.error.code).toBe(-32600);
      expect(r.json.result).toBeUndefined();
    });

    it('answers a body that is not JSON with -32700 and does not quote it', async () => {
      const r = await send(backend, '{"jsonrpc": "2.0", "secret-looking-text');
      expect(r.status).toBe(400);
      expectJson(r);
      expect(r.json.error.code).toBe(-32700);
      expect(r.text).not.toContain('secret-looking-text');
    });

    it('answers an empty body with -32700', async () => {
      const r = await send(backend, '');
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe(-32700);
    });

    it('requires Content-Type application/json', async () => {
      const r = await send(backend, rpc('ping'), context(), { 'content-type': 'text/plain', accept: LEGACY_HEADERS.accept });
      expect(r.status).toBe(415);
      expectJson(r);
    });

    it('accepts a Content-Type with parameters', async () => {
      const r = await send(backend, rpc('ping'), context(), {
        'content-type': 'application/json; charset=utf-8',
        accept: LEGACY_HEADERS.accept,
      });
      expect(r.status).toBe(200);
    });

    it.each([
      ['a JSON-only Accept header', { 'content-type': 'application/json', accept: 'application/json' }],
      ['no Accept header', { 'content-type': 'application/json' }],
    ])('serves a client with %s', async (_label, headers) => {
      const r = await send(backend, rpc('tools/list'), context(), headers);
      expect(r.status).toBe(200);
      expectJson(r);
      expect(r.json.result.tools).toHaveLength(3);
    });

    it('refuses a body over MAX_REQUEST_BYTES', async () => {
      const big = rpc('tools/call', { name: 'list_courses', arguments: { padding: 'x'.repeat(4000) } });
      const r = await send(backend, big, context({}, { MAX_REQUEST_BYTES: '1000' }));
      expect(r.status).toBe(413);
      expectJson(r);
    });

    it('uses a body the caller already parsed, without reading the request again', async () => {
      const body = rpc('tools/call', { name: 'list_courses', arguments: { limit: 2 } });
      const request = post(body);
      await request.text();
      expect(request.bodyUsed).toBe(true);
      const r = await reply(await backend.handle(request, context({ parsedBody: body })));
      expect(r.status).toBe(200);
      expect(r.json.result.content[0].text).toContain('(limit 2,');
    });

    it('refuses a body that is not a JSON-RPC message', async () => {
      for (const body of [{ hello: 'world' }, { jsonrpc: '2.0', id: null, method: 'ping' }, 'just a string', 42]) {
        const r = await send(backend, JSON.stringify(body));
        expect(r.status).toBe(400);
        expectJson(r);
        expect(r.json.error.code).toBe(-32600);
      }
    });

    it('accepts and drops a posted JSON-RPC response', async () => {
      const r = await send(backend, { jsonrpc: '2.0', id: 1, result: {} });
      expect(r.status).toBe(202);
      expect(r.text).toBe('');
    });
  });
});

describe('backend parity', () => {
  const native = createNativeBackend();
  const sdk = createSdkBackend();

  const requests: Array<[string, unknown]> = [
    ['initialize', rpc('initialize', INIT_PARAMS)],
    ['initialize with an unknown version', rpc('initialize', { ...INIT_PARAMS, protocolVersion: '2030-01-01' })],
    ['ping', rpc('ping')],
    ['tools/list', rpc('tools/list')],
    ['a text tool', rpc('tools/call', { name: 'list_courses', arguments: { limit: '4', include_concluded: false } })],
    ['a dict tool', rpc('tools/call', { name: 'list_conversations', arguments: { course_identifier: 60366 } })],
    ['a validation error', rpc('tools/call', { name: 'list_conversations', arguments: { scope: 7 } })],
    ['a missing arguments member', rpc('tools/call', { name: 'list_conversations' })],
    ['a thrown error', rpc('tools/call', { name: 'get_my_profile' })],
    ['an unknown tool', rpc('tools/call', { name: 'nope', arguments: {} })],
    ['an unknown method', rpc('prompts/list')],
    ['server/discover without the 2026 envelope', rpc('server/discover')],
  ];

  it.each(requests)('both backends give the same status and body for %s', async (_label, body) => {
    const fromNative = await send(native, body);
    const fromSdk = await send(sdk, body);
    expect(fromSdk.status).toBe(fromNative.status);
    expect(fromSdk.json).toEqual(fromNative.json);
    expect(fromSdk.headers.get('content-type')).toBe(fromNative.headers.get('content-type'));
    expect(fromSdk.headers.get('cache-control')).toBe(fromNative.headers.get('cache-control'));
  });

  it('both backends answer a notification alike', async () => {
    const body = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } };
    const fromNative = await send(native, body);
    const fromSdk = await send(sdk, body);
    expect([fromNative.status, fromNative.text]).toEqual([202, '']);
    expect([fromSdk.status, fromSdk.text]).toEqual([202, '']);
  });
});

// ---------------------------------------------------------------------------
// SDK backend only
// ---------------------------------------------------------------------------

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_META = {
  [VERSION_KEY]: '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0' },
};

function modern(method: string, params: Record<string, unknown> = {}, id: string | number = 1): [unknown, Record<string, string>] {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  return [{ jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } }, headers];
}

describe('sdk backend: 2026-07-28 protocol', () => {
  const backend = createSdkBackend();

  it('answers server/discover as plain JSON', async () => {
    const [body, headers] = modern('server/discover');
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(200);
    expectJson(r);
    expect(r.json.result.supportedVersions).toEqual(['2026-07-28']);
    expect(r.json.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.json.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(r.json.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'canvas-api', version: SERVER_VERSION });
  });

  it('lists tools as plain JSON with our input schema unchanged, marked private', async () => {
    const [body, headers] = modern('tools/list');
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(200);
    expectJson(r);
    expect(r.json.result.tools).toEqual(EXPECTED_TOOLS);
    for (const [index, def] of TOOLS.entries()) {
      expect(JSON.stringify(r.json.result.tools[index].inputSchema)).toBe(JSON.stringify(buildInputSchema(def.params)));
    }
    // The list depends on the deployment's settings, so a shared cache must not keep it.
    expect(r.json.result.cacheScope).toBe('private');
  });

  it('accepts discovery when Sites omits the modern method routing header', async () => {
    const [body, headers] = modern('server/discover');
    delete headers['mcp-method'];
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toEqual(['2026-07-28']);
  });

  it('accepts a tool call when Sites omits both modern routing headers', async () => {
    const [body, headers] = modern('tools/call', { name: 'list_courses', arguments: {} });
    delete headers['mcp-method'];
    delete headers['mcp-name'];
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(200);
    expect(r.json.result.content[0].text).toContain('era modern');
  });

  it.each(['mcp-method', 'mcp-name'])('still refuses a supplied %s that disagrees with the body', async (header) => {
    const [body, headers] = modern('tools/call', { name: 'list_courses', arguments: {} });
    headers[header] = header === 'mcp-method' ? 'tools/list' : 'get_my_profile';
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(400);
    expect(r.json.error).toBeDefined();
  });

  it('gives the same tool list in both eras', async () => {
    const [body, headers] = modern('tools/list');
    const modernList = await send(backend, body, context(), headers);
    const legacyList = await send(backend, rpc('tools/list'));
    expect(modernList.json.result.tools).toEqual(legacyList.json.result.tools);
  });

  it('calls a tool and answers as plain JSON, with the same result as the 2025 era', async () => {
    const [body, headers] = modern('tools/call', { name: 'list_conversations', arguments: { scope: 'sent' } });
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(200);
    expectJson(r);
    const legacy = await send(backend, rpc('tools/call', { name: 'list_conversations', arguments: { scope: 'sent' } }));
    const { content, structuredContent, isError } = r.json.result;
    expect({ content, structuredContent, isError }).toEqual(legacy.json.result);
    expect(content).toHaveLength(1);
  });

  it('tells the tool which era carried the call', async () => {
    const [body, headers] = modern('tools/call', { name: 'list_courses', arguments: {} });
    const r = await send(backend, body, context(), headers);
    expect(r.json.result.content[0].text).toContain('era modern');
  });

  it('keeps upstream wording for a bad argument instead of the SDK validation text', async () => {
    const [body, headers] = modern('tools/call', { name: 'list_courses', arguments: { limit: 'many' } });
    const r = await send(backend, body, context(), headers);
    expect(r.json.result.isError).toBe(true);
    expect(r.json.result.content[0].text).toBe(
      '{"error": "Parameter \'limit\' with value \'many\' could not be converted to int"}',
    );
    expect(r.text).not.toContain('Input validation error');
  });

  it('answers an unknown tool with -32602', async () => {
    const [body, headers] = modern('tools/call', { name: 'nope', arguments: {} });
    const r = await send(backend, body, context(), headers);
    expectJson(r);
    expect(r.json.error).toEqual({ code: -32602, message: 'Tool nope not found' });
  });

  it('answers a modern notification with 202', async () => {
    const r = await send(
      backend,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: MODERN_META } },
      context(),
      { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'notifications/cancelled' },
    );
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('answers the SDK ladder rejections as JSON with no-store too', async () => {
    const [body] = modern('tools/list');
    // The envelope names 2026-07-28 but the required protocol-version header is missing.
    const r = await send(backend, body, context(), { 'content-type': 'application/json' });
    expect(r.status).toBe(400);
    expectJson(r);
    expect(r.json.error.code).toBe(-32020);
  });

  it('logs only protocol shapes when a client supplies an incomplete modern envelope', async () => {
    const lines: string[] = [];
    const rc = context({ log: createLogger({ level: 'debug', redactPii: true, sink: (line) => lines.push(line) }) });
    const body = rpc('tools/call', { name: 'private-tool-value', arguments: { secret: 'private-argument-value' } });
    const r = await send(backend, body, rc, { ...LEGACY_HEADERS, 'mcp-protocol-version': '2026-07-28' });
    expect(r.status).toBe(400);
    const event = lines.map((line) => JSON.parse(line)).find((line) => line.event === 'mcp_protocol_refused');
    expect(event).toMatchObject({ method: 'tools/call', has_params_meta: false, has_top_level_meta: false,
      has_method_header: false, has_name_header: false });
    expect(lines.join('\n')).not.toContain('private-tool-value');
    expect(lines.join('\n')).not.toContain('private-argument-value');
  });

  it('answers an unsupported modern revision with the supported list', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...MODERN_META, [VERSION_KEY]: '2027-01-01' } } };
    const r = await send(backend, body, context(), {
      'content-type': 'application/json',
      'mcp-protocol-version': '2027-01-01',
      'mcp-method': 'tools/list',
    });
    expect(r.status).toBe(400);
    expectJson(r);
    expect(r.json.error.code).toBe(-32022);
    expect(r.json.error.data.supported).toEqual(['2026-07-28']);
  });

  it('never opens a stream: subscriptions/listen is answered as an unknown method', async () => {
    // Known gap in SDK 2.2.0: responseMode 'json' does not apply to subscriptions/listen, which is always SSE.
    const [body, headers] = modern('subscriptions/listen', { notifications: { toolsListChanged: true } }, 5);
    const r = await send(backend, body, context(), headers);
    expect(r.status).toBe(404);
    expectJson(r);
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found' } });
  });

  it('refuses a batch that carries modern requests', async () => {
    const [body] = modern('tools/list');
    const r = await send(backend, [body]);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });
});

describe('sdk backend: wiring', () => {
  it('keeps each request on its own context when one backend serves many at once', async () => {
    const backend = createSdkBackend();
    const identities = ['id:alpha', 'id:beta', 'id:gamma', 'id:delta'];
    const replies = await Promise.all(
      identities.flatMap((key, index) => {
        const rc = context({
          identity: { ...OWNER, key },
          tools: index % 2 === 0 ? [listCourses] : [listCourses, listConversations],
        });
        const [modernCall, modernHeaders] = modern('tools/call', { name: 'list_courses', arguments: {} });
        const [modernList, listHeaders] = modern('tools/list');
        return [
          send(backend, modernCall, rc, modernHeaders),
          send(backend, rpc('tools/call', { name: 'list_courses', arguments: {} }), rc),
          send(backend, modernList, rc, listHeaders),
        ];
      }),
    );
    identities.forEach((key, index) => {
      const [modernCall, legacyCall, list] = replies.slice(index * 3, index * 3 + 3) as [Reply, Reply, Reply];
      expect(modernCall.json.result.content[0].text).toContain(`Courses for ${key} `);
      expect(legacyCall.json.result.content[0].text).toContain(`Courses for ${key} `);
      expect(list.json.result.tools).toHaveLength(index % 2 === 0 ? 1 : 2);
    });
  });

  it('builds the modern handler once per backend, not once per request', async () => {
    // createMcpHandler warns each time it is constructed in JSON mode; one warning means one construction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const backend = createSdkBackend();
    await send(backend, rpc('tools/list'));
    await send(backend, rpc('ping'));
    expect(warn).toHaveBeenCalledTimes(0);
    for (let i = 0; i < 3; i += 1) {
      const [body, headers] = modern('tools/list', {}, i);
      expect((await send(backend, body, context(), headers)).status).toBe(200);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('answers 500 as JSON when the tool list cannot be built', async () => {
    const backend = createSdkBackend();
    const broken = context();
    Object.defineProperty(broken, 'tools', {
      get() {
        throw new Error('registry exploded');
      },
    });
    for (const [body, headers] of [[rpc('tools/list'), LEGACY_HEADERS] as const, modern('tools/list')]) {
      const r = await send(backend, body, broken, headers);
      expect(r.status).toBe(500);
      expectJson(r);
      expect(r.json.error.code).toBe(-32603);
      expect(r.text).not.toContain('registry exploded');
    }
  });
});

describe('standardSchemaFor', () => {
  it('advertises buildInputSchema and validates nothing', async () => {
    const schema = standardSchemaFor(listCourses)['~standard'];
    expect(schema.version).toBe(1);
    expect(schema.jsonSchema.input({ target: 'draft-2020-12' })).toEqual(buildInputSchema(listCourses.params));
    expect(await schema.validate({ limit: 'many', unknown: true })).toEqual({ value: { limit: 'many', unknown: true } });
    expect(await schema.validate(undefined)).toEqual({ value: {} });
  });
});

describe('dependencies of src/', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }
  const src = join(__dirname, '..', '..', 'src');

  it('never imports zod directly: the schemas are hand-built Standard Schemas', () => {
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      expect(/from\s+['"]zod(\/[^'"]*)?['"]|require\(\s*['"]zod/.test(text), file).toBe(false);
    }
  });

  it('imports the MCP SDK in the SDK backend only', () => {
    const importers = sourceFiles(src).filter((file) =>
      /(from|import)\s*\(?\s*['"]@modelcontextprotocol\//.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => file.slice(src.length + 1))).toEqual([join('mcp', 'handler.ts')]);
  });
});
