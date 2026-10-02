// No upstream counterpart: canvas-mcp serves MCP through FastMCP. This is the fallback for a runtime where the
// SDK cannot be bundled or run: a stateless JSON-RPC server for the 2025 protocol revisions, with no dependencies.
import { SERVER_VERSION } from '../version';
import type { ToolDef, ToolResult } from '../types';
import {
  JSON_RPC_ERROR,
  LEGACY_PROTOCOL_VERSIONS,
  acceptedResponse,
  batchNotSupportedResponse,
  isJsonContentType,
  jsonRpcErrorResponse,
  jsonRpcResultResponse,
  methodNotAllowedResponse,
  readJsonBody,
  toDispatchDeps,
  unsupportedMediaTypeResponse,
} from './backend';
import type { JsonRpcId, McpBackendHandler, McpRequestContext } from './backend';
import { advertisedAnnotations, inputSchemaFor } from './define-tool';
import { runTool } from './dispatch';
import { SERVER_INSTRUCTIONS } from './instructions';

/** Protocol revisions this backend speaks, newest first. */
export const NATIVE_PROTOCOL_VERSIONS: readonly string[] = LEGACY_PROTOCOL_VERSIONS;

/** The `_meta` key by which a 2026-07-28 request names its protocol revision. */
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const MAX_ECHOED_NAME = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(id: JsonRpcId = null): Response {
  return jsonRpcErrorResponse(
    400,
    JSON_RPC_ERROR.INVALID_REQUEST,
    'Bad Request: the request body is not a valid JSON-RPC message',
    id,
  );
}

/**
 * The answer to a request for a revision this backend does not speak. The
 * 2026-07-28 revision carries its version in every request and has no
 * handshake; a client that gets this error with the supported list falls back
 * to `initialize`, which is served.
 */
function unsupportedVersion(id: JsonRpcId, requested: string | undefined): Response {
  const data: Record<string, unknown> = { supported: [...NATIVE_PROTOCOL_VERSIONS] };
  if (requested !== undefined) data.requested = requested;
  return jsonRpcErrorResponse(
    400,
    JSON_RPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION,
    requested === undefined
      ? 'Unsupported protocol version: the request named no usable protocol version'
      : `Unsupported protocol version: ${requested.slice(0, MAX_ECHOED_NAME)}`,
    id,
    data,
  );
}

function invalidParams(id: JsonRpcId, message: string): Response {
  return jsonRpcErrorResponse(200, JSON_RPC_ERROR.INVALID_PARAMS, message, id);
}

/** A tool as tools/list advertises it; the SDK backend emits the same members in the same order. */
export function describeTool(def: ToolDef): Record<string, unknown> {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: inputSchemaFor(def),
    annotations: advertisedAnnotations(def),
  };
}

function initializeResult(params: unknown, rc: McpRequestContext): Record<string, unknown> | null {
  if (!isPlainObject(params) || typeof params.protocolVersion !== 'string') return null;
  // An unknown revision is answered with the newest one served here; the client decides whether it can use it.
  const protocolVersion = NATIVE_PROTOCOL_VERSIONS.includes(params.protocolVersion)
    ? params.protocolVersion
    : (NATIVE_PROTOCOL_VERSIONS[0] as string);
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: rc.config.serverName, version: SERVER_VERSION },
    instructions: SERVER_INSTRUCTIONS,
  };
}

async function callTool(id: JsonRpcId, params: unknown, rc: McpRequestContext): Promise<Response> {
  if (!isPlainObject(params) || typeof params.name !== 'string') {
    return invalidParams(id, 'Invalid tools/call request: params.name must be a string');
  }
  const rawArgs: unknown = params.arguments;
  if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
    return invalidParams(id, 'Invalid tools/call request: params.arguments must be an object');
  }
  const name = params.name;
  const def = rc.tools.find((tool) => tool.name === name);
  if (def === undefined) {
    // An unregistered tool does not exist, whatever the reason it is not registered.
    return invalidParams(id, `Tool ${name.slice(0, MAX_ECHOED_NAME)} not found`);
  }
  const result: ToolResult = await runTool(def, rawArgs ?? {}, toDispatchDeps(rc, 'legacy'));
  return jsonRpcResultResponse(id, result);
}

async function handle(request: Request, rc: McpRequestContext): Promise<Response> {
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
  if (!isPlainObject(body) || body.jsonrpc !== '2.0') {
    return invalidRequest();
  }
  if (!Object.hasOwn(body, 'method')) {
    // A posted response belongs to a server-to-client request; this server sends none. Accept and drop.
    const isResponse = Object.hasOwn(body, 'result') || Object.hasOwn(body, 'error');
    return isResponse ? acceptedResponse() : invalidRequest();
  }
  const method: unknown = body.method;
  if (typeof method !== 'string') {
    return invalidRequest();
  }
  if (!Object.hasOwn(body, 'id')) {
    // A notification: nothing here acts on one, and none gets a body back.
    return acceptedResponse();
  }
  const rawId: unknown = body.id;
  if (typeof rawId !== 'string' && !(typeof rawId === 'number' && Number.isFinite(rawId))) {
    return invalidRequest();
  }
  const id: JsonRpcId = rawId;
  const params: unknown = body.params;

  const meta: unknown = isPlainObject(params) ? params._meta : undefined;
  if (isPlainObject(meta) && Object.hasOwn(meta, PROTOCOL_VERSION_META_KEY)) {
    const claimed: unknown = meta[PROTOCOL_VERSION_META_KEY];
    return unsupportedVersion(id, typeof claimed === 'string' ? claimed : undefined);
  }
  if (method !== 'initialize') {
    // Absent header: the 2025 transport says to assume an early revision, so the request is served.
    const headerVersion = request.headers.get('mcp-protocol-version')?.trim();
    if (headerVersion !== undefined && !NATIVE_PROTOCOL_VERSIONS.includes(headerVersion)) {
      return unsupportedVersion(id, headerVersion);
    }
  }

  switch (method) {
    case 'initialize': {
      const result = initializeResult(params, rc);
      return result === null
        ? invalidParams(id, 'Invalid initialize request: params.protocolVersion must be a string')
        : jsonRpcResultResponse(id, result);
    }
    case 'ping':
      return jsonRpcResultResponse(id, {});
    case 'tools/list':
      return jsonRpcResultResponse(id, { tools: rc.tools.map(describeTool) });
    case 'tools/call':
      return callTool(id, params, rc);
    default:
      return jsonRpcErrorResponse(200, JSON_RPC_ERROR.METHOD_NOT_FOUND, 'Method not found', id);
  }
}

/**
 * The dependency-free MCP backend. Stateless: every request is answered from
 * its own `McpRequestContext`, with a JSON body and no stream.
 *
 * It serves protocol revisions 2025-11-25, 2025-06-18 and 2025-03-26. A
 * 2026-07-28 request (per-request `_meta` envelope, `server/discover`) is
 * answered with HTTP 400 and the unsupported-protocol-version error naming
 * those revisions, which is the documented cue for a modern client to fall
 * back to the `initialize` handshake.
 */
export function createNativeBackend(): McpBackendHandler {
  return {
    async handle(request: Request, rc: McpRequestContext): Promise<Response> {
      try {
        return await handle(request, rc);
      } catch (error) {
        rc.log.error('mcp_native_error', { error_name: error instanceof Error ? error.name : 'UnknownError' });
        return jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, 'Internal server error');
      }
    },
  };
}
