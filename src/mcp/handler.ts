// No upstream counterpart: canvas-mcp serves MCP through FastMCP. This backend serves it through the
// official TypeScript SDK (@modelcontextprotocol/server 2.x), in both protocol eras, as plain JSON.
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  CallToolResult,
  McpHttpHandler,
  McpRequestContext as SdkFactoryContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type { ToolDef } from '../types';
import { SERVER_VERSION } from '../version';
import {
  JSON_RPC_ERROR,
  LEGACY_PROTOCOL_VERSIONS,
  batchNotSupportedResponse,
  echoableId,
  isJsonContentType,
  jsonRpcErrorResponse,
  methodNotAllowedResponse,
  readJsonBody,
  toDispatchDeps,
  unsupportedMediaTypeResponse,
} from './backend';
import type { McpBackendHandler, McpRequestContext } from './backend';
import { advertisedAnnotations, advertisedDescription, inputSchemaFor } from './define-tool';
import { runTool } from './dispatch';
import { SERVER_INSTRUCTIONS } from './instructions';

const SCHEMA_VENDOR = 'canvas-gpt-sites';
const CONTEXT_KEY = 'canvasRequestContext';

type ToolArgs = Record<string, unknown>;

/**
 * A Standard Schema whose JSON Schema is the tool's advertised schema and
 * whose `validate` accepts anything. The SDK needs the first for tools/list;
 * the second is left open because `runTool` does the lenient coercion and
 * reports problems in upstream's own `{"error": ...}` wording, which a
 * rejecting validator here would replace with the SDK's text.
 */
export function standardSchemaFor(def: Pick<ToolDef, 'params' | 'canvasScope'>): StandardSchemaWithJSON<ToolArgs, ToolArgs> {
  const jsonSchema = inputSchemaFor(def);
  return {
    '~standard': {
      version: 1,
      vendor: SCHEMA_VENDOR,
      validate: (value) => ({ value: (value ?? {}) as ToolArgs }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  };
}

/** A fresh server for one request, holding only the tools registered for it. */
function buildServer(rc: McpRequestContext, era: 'legacy' | 'modern'): McpServer {
  const server = new McpServer(
    { name: rc.config.serverName, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
      // The 2025 revisions only; the SDK adds the 2026 revision itself on the modern path.
      supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS],
    },
  );
  const deps = toDispatchDeps(rc, era);
  const seen = new Set<string>();
  for (const def of rc.tools) {
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: advertisedDescription(def),
        inputSchema: standardSchemaFor(def),
        annotations: advertisedAnnotations(def),
      },
      // Spread into a literal: the SDK's result type has an index signature that an interface type lacks.
      async (args: ToolArgs): Promise<CallToolResult> => ({ ...(await runTool(def, args, deps)) }),
    );
  }
  return server;
}

/**
 * The request context travels to the SDK's server factory inside
 * `authInfo.extra`, wrapped in a function: a function is passed along by
 * reference but serializes to nothing, so nothing reachable from the context
 * (the credential provider, the redaction list) can leak if `authInfo` is ever
 * logged. `token` stays empty; the Canvas token is never placed here.
 */
function carrier(rc: McpRequestContext): AuthInfo {
  return { token: '', clientId: 'sites-gateway', scopes: [], extra: { [CONTEXT_KEY]: () => rc } };
}

function contextFrom(authInfo: AuthInfo | undefined): McpRequestContext {
  const getter: unknown = authInfo?.extra?.[CONTEXT_KEY];
  if (typeof getter !== 'function') {
    throw new Error('MCP request context is missing');
  }
  return (getter as () => McpRequestContext)();
}

/** The request the SDK sees: no body (it is given the parsed one) and an Accept header its 2025 transport insists on. */
function forwardRequest(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  // The 2025 transport answers 406 unless the client accepts both JSON and
  // SSE. This server only ever answers JSON, so a JSON-only client is fine.
  headers.set('accept', 'application/json, text/event-stream');
  headers.delete('content-length');
  // Sites currently forwards the modern envelope and protocol version but
  // drops its routing headers. The app has already authorized the original
  // request. Restore only absent headers from the parsed body; supplied
  // headers remain intact so the SDK still rejects every cross-check mismatch.
  if (headers.get('mcp-protocol-version') === '2026-07-28' && body !== null && typeof body === 'object') {
    const message = body as { method?: unknown; params?: { name?: unknown } };
    if (!headers.has('mcp-method') && typeof message.method === 'string'
      && /^[A-Za-z][A-Za-z0-9_./-]{0,127}$/.test(message.method)) {
      headers.set('mcp-method', message.method);
    }
    if (!headers.has('mcp-name') && message.method === 'tools/call'
      && typeof message.params?.name === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(message.params.name)) {
      headers.set('mcp-name', message.params.name);
    }
  }
  return new Request(request.url, { method: 'POST', headers });
}

async function serveLegacy(request: Request, body: unknown, rc: McpRequestContext): Promise<Response> {
  const server = buildServer(rc, 'legacy');
  // `enableJsonResponse` is what makes this leg answer JSON; the SDK's own
  // stateless fallback leaves it off and answers over SSE.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = (error: Error): void => {
    rc.log.warn('mcp_transport_error', { error_name: error.name });
  };
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  }
}

/** Every response leaves with `Cache-Control: no-store`, and never as a stream. */
async function finalize(response: Response, body: unknown): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/event-stream')) {
    await response.body?.cancel().catch(() => undefined);
    return jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, 'Internal server error', echoableId(body));
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The SDK-backed MCP backend.
 *
 * - 2026-07-28 traffic goes to one `createMcpHandler` instance in JSON
 *   response mode. It is built on first use and kept for the life of the
 *   backend, because the SDK prints a warning each time one is constructed.
 *   It holds no request data: each request's context reaches the server
 *   factory through `authInfo.extra`.
 * - 2025-era traffic is routed here with the SDK's own `isLegacyRequest` and
 *   served by a per-request server on a transport with `enableJsonResponse`.
 * - JSON-RPC batches are refused, and `subscriptions/listen` (the one method
 *   the SDK always answers with a stream) is answered as an unknown method.
 */
export function createSdkBackend(): McpBackendHandler {
  let modern: McpHttpHandler | undefined;
  const modernHandler = (): McpHttpHandler => {
    modern ??= createMcpHandler(
      (ctx: SdkFactoryContext) => buildServer(contextFrom(ctx.authInfo), ctx.era),
      { legacy: 'reject', responseMode: 'json' },
    );
    return modern;
  };

  return {
    async handle(request: Request, rc: McpRequestContext): Promise<Response> {
      if (request.method.toUpperCase() !== 'POST') {
        return methodNotAllowedResponse();
      }
      if (!isJsonContentType(request.headers.get('content-type'))) {
        return unsupportedMediaTypeResponse();
      }
      const read = await readJsonBody(request, rc);
      if (!read.ok) return read.response;
      const body = read.body;
      if (Array.isArray(body)) {
        return batchNotSupportedResponse();
      }

      try {
        const forward = forwardRequest(request, body);
        if (await isLegacyRequest(forward, body)) {
          return await finalize(await serveLegacy(forward, body, rc), body);
        }
        const method: unknown = body !== null && typeof body === 'object' ? (body as { method?: unknown }).method : undefined;
        if (method === 'subscriptions/listen') {
          return jsonRpcErrorResponse(404, JSON_RPC_ERROR.METHOD_NOT_FOUND, 'Method not found', echoableId(body));
        }
        const response = await modernHandler().fetch(forward, { authInfo: carrier(rc), parsedBody: body });
        if (response.status === 400) {
          // Diagnose platform/client protocol mismatches without logging any
          // body, arguments, header value or SDK error text.
          const object = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
          const params = object.params !== null && typeof object.params === 'object'
            ? object.params as Record<string, unknown> : {};
          const knownMethods = ['initialize', 'server/discover', 'tools/list', 'tools/call', 'ping'];
          rc.log.warn('mcp_protocol_refused', {
            method: typeof method === 'string' && knownMethods.includes(method) ? method : 'other',
            has_params_meta: params._meta !== undefined,
            has_top_level_meta: object._meta !== undefined,
            has_method_header: request.headers.has('mcp-method'),
            has_name_header: request.headers.has('mcp-name'),
          });
        }
        return await finalize(response, body);
      } catch (error) {
        rc.log.error('mcp_sdk_error', { error_name: error instanceof Error ? error.name : 'UnknownError' });
        return jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, 'Internal server error', echoableId(body));
      }
    },
  };
}
