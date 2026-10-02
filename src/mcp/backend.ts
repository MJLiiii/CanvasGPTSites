// No upstream counterpart: canvas-mcp lets FastMCP own the transport. Both backends here implement one
// interface and share the HTTP details below, so they cannot drift apart on status codes or headers.
import { readBodyCapped } from '../http/security';
import type { Config, CredentialProvider, DiagnosticsAccess, Identity, Logger, ToolDef } from '../types';
import { toSummary } from './define-tool';
import type { CanvasClientFactory, DispatchDeps } from './dispatch';

/** Everything one /mcp request needs. Built per request by the app layer; nothing in it outlives the request. */
export interface McpRequestContext {
  config: Config;
  identity: Identity | null;
  credentials: CredentialProvider;
  /** The tools registered for this request (the output of `computeToolSet`). */
  tools: ReadonlyArray<ToolDef>;
  createClient: CanvasClientFactory;
  log: Logger;
  requestId: string;
  pseudonymSalt: string | null;
  secretsToRedact: readonly string[];
  diagnostics?: DiagnosticsAccess;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * The request body, already parsed as JSON. Pass it when the caller has read
   * the body (to classify the request); the backend then never touches
   * `request.body`. Leave it out and the backend reads the body itself.
   */
  parsedBody?: unknown;
}

export interface McpBackendHandler {
  handle(request: Request, rc: McpRequestContext): Promise<Response>;
}

/**
 * The 2025-era protocol revisions served, newest first. An `initialize` naming
 * anything else is answered with the first entry. Both backends use this list,
 * so they negotiate alike.
 */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);

export const JSON_RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Transport-level refusals (wrong HTTP method, media type, body size), as the SDK numbers them. */
  SERVER_ERROR: -32000,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
});

export type JsonRpcId = string | number | null;

const NO_STORE = 'no-store';

/** A JSON response. Tool results carry Canvas data, so nothing may cache them. */
export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': NO_STORE },
  });
}

/** 202 with no body: the answer to a notification. */
export function acceptedResponse(): Response {
  return new Response(null, { status: 202, headers: { 'Cache-Control': NO_STORE } });
}

export function jsonRpcResultResponse(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

export function jsonRpcErrorResponse(
  httpStatus: number,
  code: number,
  message: string,
  id: JsonRpcId = null,
  data?: unknown,
  headers?: Record<string, string>,
): Response {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse({ jsonrpc: '2.0', id, error }, httpStatus, headers);
}

/** GET and DELETE are session operations of the 2025 transport; this server is stateless. */
export function methodNotAllowedResponse(): Response {
  return jsonRpcErrorResponse(405, JSON_RPC_ERROR.SERVER_ERROR, 'Method not allowed.', null, undefined, {
    Allow: 'POST',
  });
}

export function unsupportedMediaTypeResponse(): Response {
  return jsonRpcErrorResponse(
    415,
    JSON_RPC_ERROR.SERVER_ERROR,
    'Unsupported Media Type: Content-Type must be application/json',
  );
}

export function batchNotSupportedResponse(): Response {
  return jsonRpcErrorResponse(
    400,
    JSON_RPC_ERROR.INVALID_REQUEST,
    'Bad Request: JSON-RPC batches are not supported by this endpoint',
  );
}

/** True when the media type, parameters aside, is application/json. */
export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const essence = (value.split(';', 1)[0] ?? '').trim().toLowerCase();
  return essence === 'application/json';
}

/** The id to echo on an error: the body's own id when it is a request with a string or number id. */
export function echoableId(body: unknown): JsonRpcId {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { method, id } = body as { method?: unknown; id?: unknown };
  if (typeof method !== 'string') return null;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export type BodyOutcome = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * The request's JSON body: `rc.parsedBody` when the caller supplied one, else
 * the body read here once with the app's own bounded reader, counted against
 * MAX_REQUEST_BYTES while it streams.
 */
export async function readJsonBody(request: Request, rc: McpRequestContext): Promise<BodyOutcome> {
  if (rc.parsedBody !== undefined) {
    return { ok: true, body: rc.parsedBody };
  }
  const maxBytes = rc.config.maxRequestBytes;
  const read = await readBodyCapped(request, maxBytes);
  if (!read.ok) {
    return {
      ok: false,
      response:
        read.reason === 'too_large'
          ? jsonRpcErrorResponse(
              413,
              JSON_RPC_ERROR.SERVER_ERROR,
              `Payload Too Large: Request body must not exceed ${maxBytes} bytes`,
            )
          : jsonRpcErrorResponse(400, JSON_RPC_ERROR.PARSE_ERROR, 'Parse error: the request body could not be read'),
    };
  }
  const text = read.text;
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    // The parser's own message quotes the body; it is not passed on.
    return {
      ok: false,
      response: jsonRpcErrorResponse(400, JSON_RPC_ERROR.PARSE_ERROR, 'Parse error: the request body is not valid JSON'),
    };
  }
}

/** What `runTool` needs, taken from the request context. */
export function toDispatchDeps(rc: McpRequestContext, protocolEra?: 'legacy' | 'modern'): DispatchDeps {
  return {
    config: rc.config,
    identity: rc.identity,
    credentials: rc.credentials,
    createClient: rc.createClient,
    log: rc.log,
    requestId: rc.requestId,
    pseudonymSalt: rc.pseudonymSalt,
    secretsToRedact: rc.secretsToRedact,
    registeredTools: rc.tools.map(toSummary),
    ...(rc.diagnostics !== undefined && { diagnostics: rc.diagnostics }),
    ...(rc.fetchImpl !== undefined && { fetchImpl: rc.fetchImpl }),
    ...(rc.now !== undefined && { now: rc.now }),
    ...(protocolEra !== undefined && { protocolEra }),
  };
}
