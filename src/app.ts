// Replaces the ASGI stack of canvas-mcp src/canvas_mcp/server.py (CanvasCredentialMiddleware around FastMCP):
// one web-standard fetch handler that routes, applies the security gates in a fixed order, and catches everything.
import { createCredentialProvider } from './auth/credentials';
import { createCanvasClient } from './canvas/client';
import { sha256Hex } from './core/hash';
import { createLogger, identityTag } from './core/logging';
import { parseConfig, parseSecrets, secretValuesForRedaction } from './env';
import { createDiagnosticsAccess } from './http/diagnostics-access';
import { resolveIdentity } from './http/identity';
import {
  BASE_SECURITY_HEADERS,
  bodyLimitFor,
  browserRequestMarker,
  isAllowedHost,
  readBodyCapped,
  withoutAuthChallenge,
} from './http/security';
import { handleStatusRoute, matchStatusRoute } from './http/status-page';
import type { StatusContext, StatusRoute } from './http/status-page';
import {
  JSON_RPC_ERROR,
  batchNotSupportedResponse,
  echoableId,
  isJsonContentType,
  jsonRpcErrorResponse,
  methodNotAllowedResponse,
  unsupportedMediaTypeResponse,
} from './mcp/backend';
import type { JsonRpcId, McpBackendHandler, McpRequestContext } from './mcp/backend';
import { createNativeBackend } from './mcp/jsonrpc-native';
import { classifyMcpRequest } from './mcp/methods';
import { computeToolSet } from './mcp/registry';
import type { RegistryFeatures } from './mcp/registry';
import { ALL_TOOLS } from './tools/index';
import type { Config, CredentialProvider, Env, Identity, Logger, McpBackend } from './types';

export interface AppOverrides {
  /** Used for every outbound request (Canvas and the diagnostics probe). Default: the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Receives one JSON line per log event. Default: console.log. */
  logSink?: (line: string) => void;
}

/** The part of the Worker execution context this app uses. */
export interface AppExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  props?: Record<string, unknown>;
}

export interface App {
  fetch(request: Request, env: Env, ctx?: AppExecutionContext): Promise<Response>;
}

/**
 * JSON-RPC code of every refusal this app makes itself (owner gate, host,
 * browser request). Always sent with HTTP 403: a 401 would start the client's
 * OAuth discovery, and OAuth belongs to the Sites gateway.
 */
export const APP_DENIED_CODE = -32001;

export const FORBIDDEN_MESSAGE = 'Forbidden';
export const MISCONFIGURED_RPC_MESSAGE = 'Server misconfigured';

// The only module-level state: the two MCP backends. Neither holds request
// data; they are kept because the SDK warns each time its handler is rebuilt.
let nativeBackend: McpBackendHandler | undefined;
let sdkBackend: Promise<McpBackendHandler> | undefined;

/**
 * The SDK backend is loaded on first use, not at module load: a deployment
 * that runs MCP_BACKEND=native because the SDK does not work on its runtime
 * must not evaluate the SDK at all.
 */
function backendFor(kind: McpBackend): Promise<McpBackendHandler> {
  if (kind === 'native') {
    nativeBackend ??= createNativeBackend();
    return Promise.resolve(nativeBackend);
  }
  sdkBackend ??= import('./mcp/handler').then((module) => module.createSdkBackend());
  return sdkBackend.catch((error: unknown) => {
    sdkBackend = undefined;
    throw error;
  });
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }
}

/**
 * Key for the identity tag in log lines. Derived from the deployment's own
 * secrets so the tag cannot be recomputed from a guessed email; a deployment
 * that holds no secret (the diagnostics spike) falls back to its owner setting.
 */
function identityTagKey(secretValues: readonly string[], config: Config): string {
  const material = secretValues.length > 0 ? secretValues.join('\n') : `${config.ownerEmail ?? ''}\n${config.serverName}`;
  return sha256Hex(`canvas-gpt-sites/identity-tag-key/v1|${material}`);
}

const MIN_REDACTED_FRAGMENT_LENGTH = 8;

/**
 * The redaction list for text that quotes configuration: each secret, plus
 * its comma- or whitespace-separated pieces. List-valued settings
 * (ALLOWED_WRITE_TOOLS, DISABLED_TOOLS, STUDENT_WRITE_TOOLS) are split that
 * way before a message names their entries, so a secret pasted into one of
 * them would otherwise come back out in pieces that no longer match it.
 */
function withFragments(secretValues: readonly string[], structuredSecret?: string): string[] {
  const out = new Set<string>(secretValues);
  for (const secret of secretValues) {
    // A connection JSON includes public names and URLs. Split its tokens,
    // not the container, or ordinary display-name words would be redacted.
    if (secret === structuredSecret) continue;
    for (const piece of secret.split(/[\s,]+/)) {
      if (piece.length >= MIN_REDACTED_FRAGMENT_LENGTH) out.add(piece);
    }
  }
  return [...out];
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...BASE_SECURITY_HEADERS, 'Content-Type': 'application/json' },
  });
}

function internalError(isMcp: boolean): Response {
  return isMcp
    ? jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, 'Internal server error')
    : jsonError(500, 'Internal server error');
}

function isBinding(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(error.name)) ? error.name : 'UnknownError';
}

interface RequestScope {
  request: Request;
  env: Env;
  ctx: AppExecutionContext | undefined;
  config: Config;
  identity: Identity | null;
  identityRejected: string | undefined;
  credentials: CredentialProvider;
  secretsToRedact: readonly string[];
  /** `secretsToRedact` plus the pieces of each secret; for text that quotes configuration. */
  configRedactions: readonly string[];
  pseudonymSalt: string | null;
  features: RegistryFeatures;
  log: Logger;
  requestId: string;
  overrides: AppOverrides;
}

function describeConfigErrors(config: Config, blocks: 'request' | 'invocation'): Array<{ code: string; message: string }> {
  return config.errors.filter((error) => error.blocks === blocks).map((error) => ({ code: error.code, message: error.message }));
}

/** A refusal on the MCP path: HTTP 403, JSON-RPC -32001, and exactly one security log line. */
function denyMcp(scope: RequestScope, reason: string, message: string, id: JsonRpcId = null, extra: Record<string, unknown> = {}): Response {
  scope.log.security('request_denied', {
    route: 'mcp',
    reason,
    ...(scope.identityRejected !== undefined && { identity_rejected: scope.identityRejected }),
    ...(scope.config.errors.length > 0 && { config_error_codes: scope.config.errors.map((error) => error.code) }),
    ...extra,
  });
  return jsonRpcErrorResponse(403, APP_DENIED_CODE, message, id);
}

async function handleMcp(scope: RequestScope): Promise<Response> {
  const { request, config, log, identity, credentials } = scope;

  if (request.method.toUpperCase() !== 'POST') {
    return methodNotAllowedResponse();
  }

  const requestErrors = describeConfigErrors(config, 'request');
  if (requestErrors.length > 0) {
    // Messages never hold the value of a secret-class variable, and the logger redacts on top of that.
    log.error('server_misconfigured', { blocks: 'request', errors: requestErrors });
    return jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, MISCONFIGURED_RPC_MESSAGE);
  }

  if (!isAllowedHost(request, config)) {
    return denyMcp(scope, 'host_not_allowed', FORBIDDEN_MESSAGE);
  }
  const marker = browserRequestMarker(request.headers);
  if (marker !== null) {
    return denyMcp(scope, 'browser_request', FORBIDDEN_MESSAGE, null, { header: marker });
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return unsupportedMediaTypeResponse();
  }

  // Authorization is decided from the headers alone, before one byte of the body is read.
  const authorization = credentials.authorize(identity);
  const maxBytes = bodyLimitFor(authorization.ok, config);
  const read = await readBodyCapped(request, maxBytes);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? jsonRpcErrorResponse(413, JSON_RPC_ERROR.SERVER_ERROR, `Payload Too Large: Request body must not exceed ${maxBytes} bytes`)
      : jsonRpcErrorResponse(400, JSON_RPC_ERROR.PARSE_ERROR, 'Parse error: the request body could not be read');
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text) as unknown;
  } catch {
    // The parser's own message quotes the body; it is not passed on.
    return jsonRpcErrorResponse(400, JSON_RPC_ERROR.PARSE_ERROR, 'Parse error: the request body is not valid JSON');
  }

  const requestClass = classifyMcpRequest(body, request.headers);
  if (requestClass === 'invalid') {
    return Array.isArray(body)
      ? batchNotSupportedResponse()
      : jsonRpcErrorResponse(400, JSON_RPC_ERROR.INVALID_REQUEST, 'Bad Request: the request body is not a valid JSON-RPC message');
  }
  const id = echoableId(body);

  // Diagnostics mode needs no identity: it exists to find out which identity
  // headers arrive at all, and configuration guarantees that no Canvas token
  // or confirmation secret is present while it is on.
  if (!config.diagnosticsEnabled) {
    if (!authorization.ok) {
      return denyMcp(scope, identity === null ? 'no_identity' : 'not_authorized', authorization.publicMessage, id, {
        request_class: requestClass,
      });
    }
    if (requestClass === 'invocation') {
      const invocationErrors = describeConfigErrors(config, 'invocation');
      if (invocationErrors.length > 0) {
        log.error('server_misconfigured', { blocks: 'invocation', errors: invocationErrors });
        return jsonRpcErrorResponse(200, JSON_RPC_ERROR.INTERNAL_ERROR, MISCONFIGURED_RPC_MESSAGE, id);
      }
    }
  }

  const toolSet = computeToolSet(ALL_TOOLS, config, scope.features);
  let backend: McpBackendHandler;
  try {
    backend = await backendFor(config.mcpBackend);
  } catch (error) {
    log.error('mcp_backend_unavailable', { backend: config.mcpBackend, error_name: errorName(error) });
    return jsonRpcErrorResponse(500, JSON_RPC_ERROR.INTERNAL_ERROR, 'Internal server error', id);
  }

  const outbound = scope.overrides.fetchImpl;
  const rc: McpRequestContext = {
    config,
    identity,
    credentials,
    tools: toolSet.tools,
    createClient: createCanvasClient,
    log,
    requestId: scope.requestId,
    pseudonymSalt: scope.pseudonymSalt,
    secretsToRedact: scope.secretsToRedact,
    parsedBody: body,
    ...(config.diagnosticsEnabled && {
      diagnostics: createDiagnosticsAccess(
        request,
        scope.env,
        scope.ctx,
        outbound ?? ((input, init) => fetch(input, init)),
      ),
    }),
    ...(outbound !== undefined && { fetchImpl: outbound }),
    ...(scope.overrides.now !== undefined && { now: scope.overrides.now }),
  };
  return backend.handle(request, rc);
}

async function handleStatus(scope: RequestScope, route: StatusRoute): Promise<Response> {
  if (!isAllowedHost(scope.request, scope.config)) {
    scope.log.security('request_denied', { route, reason: 'host_not_allowed' });
    return jsonError(403, FORBIDDEN_MESSAGE);
  }
  const sc: StatusContext = {
    request: scope.request,
    config: scope.config,
    identity: scope.identity,
    credentials: scope.credentials,
    toolSet: computeToolSet(ALL_TOOLS, scope.config, scope.features),
    features: scope.features,
    secretsToRedact: scope.configRedactions,
    log: scope.log,
    createClient: createCanvasClient,
    pseudonymSalt: scope.pseudonymSalt,
    ...(scope.overrides.fetchImpl !== undefined && { fetchImpl: scope.overrides.fetchImpl }),
    ...(scope.overrides.now !== undefined && { now: scope.overrides.now }),
  };
  return handleStatusRoute(route, sc);
}

async function serve(request: Request, env: Env, ctx: AppExecutionContext | undefined, overrides: AppOverrides): Promise<Response> {
  const now = overrides.now ?? Date.now;
  const startedAt = now();
  const config = parseConfig(env);
  const secretsToRedact = secretValuesForRedaction(env);
  const configRedactions = withFragments(secretsToRedact, typeof env.CANVAS_CONNECTIONS === 'string' ? env.CANVAS_CONNECTIONS : undefined);
  const resolution = resolveIdentity(request.headers);
  const requestId = newRequestId();
  const log = createLogger({
    level: config.logLevel,
    redactPii: config.logRedactPii,
    secrets: configRedactions,
    ...(overrides.logSink !== undefined && { sink: overrides.logSink }),
    base: {
      request_id: requestId,
      ...(resolution.identity !== null && {
        identity_tag: identityTag(resolution.identity.key, identityTagKey(secretsToRedact, config)),
      }),
    },
  });

  let route = 'not_found';
  let isMcp = false;
  let response: Response;
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    const statusRoute = matchStatusRoute(pathname);
    isMcp = pathname === config.mcpPath;
    route = isMcp ? 'mcp' : (statusRoute ?? 'not_found');

    if (!isMcp && statusRoute === null) {
      response = jsonError(404, 'Not found');
    } else {
      const secrets = parseSecrets(env);
      const scope: RequestScope = {
        request,
        env,
        ctx,
        config,
        identity: resolution.identity,
        identityRejected: resolution.rejected,
        credentials: createCredentialProvider(config, secrets, { log }),
        secretsToRedact,
        configRedactions,
        pseudonymSalt: secrets.pseudonymSalt,
        features: { hasD1: isBinding(env.DB), hasR2: isBinding(env.FILES) },
        log,
        requestId,
        overrides,
      };
      response = isMcp ? await handleMcp(scope) : await handleStatus(scope, statusRoute as StatusRoute);
    }
  } catch (error) {
    log.error('unhandled_error', { route, error_name: errorName(error) });
    response = internalError(isMcp);
  }

  response = withoutAuthChallenge(response);
  log.info('http_request', {
    route,
    method: request.method,
    status: response.status,
    ms: Math.max(0, now() - startedAt),
    ...(resolution.rejected !== undefined && { identity_rejected: resolution.rejected }),
  });
  return response;
}

/**
 * The application. `fetch` is the whole public surface:
 *
 * - `config.mcpPath` (POST only): the MCP endpoint, behind the owner gate.
 * - `/`, `/api/status`, `/api/status/check`, `/healthz`, `/robots.txt`: the status module.
 * - anything else: 404. `/signin-with-chatgpt`, `/signout-with-chatgpt` and
 *   `/callback` belong to the Sites gateway and are never defined here.
 *
 * Configuration, secrets, identity and the credential provider are rebuilt
 * from `env` and the request on every call; nothing is remembered between
 * requests. `fetch` never rejects, and no response is ever a 401 or carries
 * `WWW-Authenticate`.
 */
export function createApp(overrides: AppOverrides = {}): App {
  return {
    async fetch(request: Request, env: Env, ctx?: AppExecutionContext): Promise<Response> {
      try {
        return await serve(request, env !== null && typeof env === 'object' ? env : {}, ctx, overrides);
      } catch {
        // Only configuration parsing or the logger itself can fail out here, so there is nothing to log with.
        return internalError(false);
      }
    },
  };
}
