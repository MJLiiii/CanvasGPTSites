// No upstream counterpart: canvas-mcp has no web surface. This is the minimal status page of the Site: what the
// owner needs to see that the deployment is configured, and one sentence for everybody else.
import { matchOwner } from '../auth/owner-secret-provider';
import { SubrequestMeter } from '../canvas/budget';
import type { CanvasClientFactory } from '../canvas/client';
import { isFailure } from '../canvas/errors';
import { canvasPath } from '../canvas/path';
import { redactSecretsDeep } from '../core/logging';
import { resolveToolPolicy } from '../core/tool-policy';
import type { RegistryFeatures, ToolSet } from '../mcp/registry';
import type { Config, CredentialProvider, Identity, Logger } from '../types';
import { SERVER_VERSION, UPSTREAM_VERSION } from '../version';
import { BASE_SECURITY_HEADERS, HTML_SECURITY_HEADERS, hasSameOriginHeader } from './security';

export const PRIVATE_DEPLOYMENT_SENTENCE = 'This is a private Canvas MCP deployment.';
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export type StatusRoute = 'page' | 'json' | 'check' | 'health' | 'robots';

const ROUTES: Readonly<Record<string, StatusRoute>> = Object.freeze({
  '/': 'page',
  '/api/status': 'json',
  '/api/status/check': 'check',
  '/healthz': 'health',
  '/robots.txt': 'robots',
});

/** The status route a pathname names, or null. The reserved sign-in paths are never among them. */
export function matchStatusRoute(pathname: string): StatusRoute | null {
  return Object.hasOwn(ROUTES, pathname) ? (ROUTES[pathname] as StatusRoute) : null;
}

/** Everything the status routes need for one request. Nothing in it outlives the request. */
export interface StatusContext {
  request: Request;
  config: Config;
  identity: Identity | null;
  credentials: CredentialProvider;
  toolSet: ToolSet;
  features: RegistryFeatures;
  /** Every secret-class value of the deployment; none may appear in a response. */
  secretsToRedact: readonly string[];
  log: Logger;
  createClient: CanvasClientFactory;
  pseudonymSalt: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface StatusReport {
  server: { version: string; upstream_version: string; name: string; institution: string };
  auth_mode: string;
  role: string;
  mcp: { path: string; endpoint: string; backend: string };
  /** The viewer's own email, as the gateway reported it. */
  signed_in_as: string | null;
  /** Names and yes/no only. */
  settings: Array<{ name: string; required: boolean; present: boolean }>;
  canvas_host: string | null;
  tools: {
    count: number;
    registered: Array<{ name: string; module: string; effect: string }>;
    not_registered: Array<{ name: string; reason: string }>;
  };
  write_allowlist: { state: 'read_only' | 'tools' | 'invalid'; tools: string[] };
  student_write_tools: string[];
  disabled_tools: string[];
  config_errors: Array<{ code: string; blocks: string; message: string }>;
  config_warnings: string[];
  bindings: { d1: boolean; r2: boolean };
  switches: Record<string, boolean | string>;
  limits: Record<string, number>;
}

const CHECK_DEADLINE_MS = 15_000;
const CHECK_BUDGET = 3;

function isOwnerView(sc: StatusContext): boolean {
  return matchOwner(sc.config, sc.identity).ok;
}

function requestOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

function canvasHost(config: Config): string | null {
  if (config.canvasOrigin === null) return null;
  try {
    return new URL(config.canvasOrigin).hostname;
  } catch {
    return null;
  }
}

/**
 * The owner's view as data. Built from the secret-free Config and the tool
 * set only; no secret value is an input. The redaction pass at the end is a
 * second line: it covers a secret an owner pasted into a non-secret variable
 * that a warning then echoes.
 */
export function buildStatusReport(sc: StatusContext): StatusReport {
  const { config } = sc;
  const policy = resolveToolPolicy(config.allowedWriteToolsRaw);
  const allowed = policy.ok ? [...policy.allowedWrites].sort() : [];

  const report: StatusReport = {
    server: {
      version: SERVER_VERSION,
      upstream_version: UPSTREAM_VERSION,
      name: config.serverName,
      institution: config.institutionName,
    },
    auth_mode: config.authMode,
    role: config.role,
    mcp: {
      path: config.mcpPath,
      endpoint: `${requestOrigin(sc.request)}${config.mcpPath}`,
      backend: config.mcpBackend,
    },
    signed_in_as: sc.identity?.email ?? null,
    settings: [
      { name: 'CANVAS_API_URL', required: true, present: config.canvasApiUrl !== null },
      { name: 'CANVAS_API_TOKEN', required: true, present: config.hasCanvasToken },
      { name: 'OWNER_EMAIL', required: true, present: config.ownerEmail !== null },
      { name: 'OWNER_USER_ID_SHA256', required: false, present: config.ownerUserIdSha256 !== null },
      { name: 'CONFIRMATION_SECRET', required: false, present: config.hasConfirmationSecret },
      { name: 'PSEUDONYM_SALT', required: false, present: config.hasPseudonymSalt },
    ],
    canvas_host: canvasHost(config),
    tools: {
      count: sc.toolSet.tools.length,
      registered: sc.toolSet.tools.map((def) => ({ name: def.name, module: def.module, effect: def.effect })),
      not_registered: sc.toolSet.skipped.map((entry) => ({ name: entry.name, reason: entry.reason })),
    },
    write_allowlist: {
      state: !policy.ok ? 'invalid' : allowed.length === 0 ? 'read_only' : 'tools',
      tools: allowed,
    },
    student_write_tools: [...config.studentWriteTools],
    disabled_tools: [...config.disabledTools],
    config_errors: config.errors.map((error) => ({ code: error.code, blocks: error.blocks, message: error.message })),
    config_warnings: [...config.warnings],
    bindings: { d1: sc.features.hasD1, r2: sc.features.hasR2 },
    switches: {
      anonymization: config.anonymizationEnabled,
      diagnostics: config.diagnosticsEnabled,
      exports: config.exportsEnabled,
      log_redact_pii: config.logRedactPii,
      log_access_events: config.logAccessEvents,
      audit_to_d1: config.auditToD1,
      db_bootstrap: config.dbBootstrap,
      course_policy: config.coursePolicy.enabled,
      course_policy_default: config.coursePolicy.defaultPosture,
      log_level: config.logLevel,
      timezone: config.timezone,
    },
    limits: {
      request_budget: config.requestBudget,
      max_pages: config.maxPages,
      tool_deadline_ms: config.toolDeadlineMs,
      api_timeout_ms: config.apiTimeoutMs,
      max_concurrent_requests: config.maxConcurrentRequests,
      max_tool_result_bytes: config.maxToolResultBytes,
      max_request_bytes: config.maxRequestBytes,
      max_upload_bytes: config.maxUploadBytes,
      read_file_max_bytes: config.readFileMaxBytes,
      max_bulk_items: config.maxBulkItems,
    },
  };
  return redactSecretsDeep(report, sc.secretsToRedact);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem;color:#1a1a1a}' +
  'h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}' +
  'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #ddd;vertical-align:top}' +
  'th{font-weight:600;width:16rem}code{font-family:ui-monospace,monospace;font-size:.9em}' +
  '.bad{color:#a40000;font-weight:600}.ok{color:#0a6b2d}.muted{color:#666}';

function page(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    `<title>${escapeHtml(title)}</title>\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<style>${STYLE}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`
  );
}

function rows(entries: ReadonlyArray<readonly [string, string]>): string {
  return `<table>\n${entries.map(([name, html]) => `<tr><th>${escapeHtml(name)}</th><td>${html}</td></tr>`).join('\n')}\n</table>`;
}

function code(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function yesNo(value: boolean): string {
  return value ? '<span class="ok">yes</span>' : '<span class="muted">no</span>';
}

function list(values: readonly string[], empty: string): string {
  return values.length === 0 ? `<span class="muted">${escapeHtml(empty)}</span>` : values.map(code).join(', ');
}

/** The page everyone but the owner gets: one sentence and nothing about the deployment. */
export function renderPublicHtml(): string {
  return page('Canvas MCP', `<p>${escapeHtml(PRIVATE_DEPLOYMENT_SENTENCE)}</p>`);
}

/** The owner's page. Every interpolated value goes through `escapeHtml`; the page has no script. */
export function renderOwnerHtml(report: StatusReport): string {
  const parts: string[] = [`<h1>${escapeHtml(report.server.name)} status</h1>`];

  if (report.config_errors.length > 0) {
    parts.push(
      '<h2 class="bad">Configuration errors</h2>',
      rows(
        report.config_errors.map((error) => [
          error.code,
          `${escapeHtml(error.message)} <span class="muted">(blocks ${escapeHtml(error.blocks)})</span>`,
        ]),
      ),
    );
  }
  if (report.config_warnings.length > 0) {
    parts.push('<h2>Configuration warnings</h2>', `<ul>${report.config_warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
  }

  parts.push(
    '<h2>Deployment</h2>',
    rows([
      ['Version', code(report.server.version)],
      ['Upstream canvas-mcp', code(report.server.upstream_version)],
      ['Institution', report.server.institution === '' ? '<span class="muted">not set</span>' : escapeHtml(report.server.institution)],
      ['Auth mode', code(report.auth_mode)],
      ['Role', code(report.role)],
      ['MCP path', code(report.mcp.path)],
      ['MCP endpoint', code(report.mcp.endpoint)],
      ['MCP backend', code(report.mcp.backend)],
      ['Canvas host', report.canvas_host === null ? '<span class="muted">not configured</span>' : code(report.canvas_host)],
      ['Signed in as', report.signed_in_as === null ? '<span class="muted">unknown</span>' : escapeHtml(report.signed_in_as)],
      ['D1 binding (DB)', yesNo(report.bindings.d1)],
      ['R2 binding (FILES)', yesNo(report.bindings.r2)],
    ]),
    '<h2>Settings present</h2>',
    rows(
      report.settings.map((setting) => [
        setting.name,
        setting.present
          ? '<span class="ok">yes</span>'
          : setting.required
            ? '<span class="bad">no (required)</span>'
            : '<span class="muted">no (optional)</span>',
      ]),
    ),
    '<h2>Canvas check</h2>',
    '<form method="post" action="/api/status/check"><button type="submit">Check the Canvas token</button></form>',
    '<p class="muted">Calls <code>GET /users/self</code> once and shows only whether it worked and the HTTP status.</p>',
    '<h2>Write policy</h2>',
    rows([
      [
        'ALLOWED_WRITE_TOOLS resolves to',
        report.write_allowlist.state === 'invalid'
          ? '<span class="bad">invalid (see configuration errors)</span>'
          : list(report.write_allowlist.tools, 'none (read-only)'),
      ],
      ['STUDENT_WRITE_TOOLS', list(report.student_write_tools, 'none')],
      ['DISABLED_TOOLS', list(report.disabled_tools, 'none')],
    ]),
    `<h2>Registered tools (${escapeHtml(report.tools.count)})</h2>`,
    report.tools.registered.length === 0
      ? '<p class="muted">No tools are registered.</p>'
      : `<table>\n<tr><th>Tool</th><td>Module</td><td>Effect</td></tr>\n${report.tools.registered
          .map((tool) => `<tr><th>${code(tool.name)}</th><td>${escapeHtml(tool.module)}</td><td>${escapeHtml(tool.effect)}</td></tr>`)
          .join('\n')}\n</table>`,
  );
  if (report.tools.not_registered.length > 0) {
    parts.push(
      `<h2>Not registered (${escapeHtml(report.tools.not_registered.length)})</h2>`,
      rows(report.tools.not_registered.map((tool) => [tool.name, escapeHtml(tool.reason)])),
    );
  }
  parts.push(
    '<h2>Switches</h2>',
    rows(Object.entries(report.switches).map(([name, value]) => [name, typeof value === 'boolean' ? yesNo(value) : code(value)])),
    '<h2>Limits in force</h2>',
    rows(Object.entries(report.limits).map(([name, value]) => [name, code(value)])),
  );
  return page(`${report.server.name} status`, parts.join('\n'));
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_SECURITY_HEADERS, ...headers, 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { ...BASE_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { ...HTML_SECURITY_HEADERS } });
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: 'Method not allowed' }, 405, { Allow: allow });
}

/** GET /: the owner's view for the owner, one sentence for everyone else. Always 200. */
export function statusPageResponse(sc: StatusContext): Response {
  return htmlResponse(isOwnerView(sc) ? renderOwnerHtml(buildStatusReport(sc)) : renderPublicHtml());
}

/** GET /api/status: the same data as JSON. */
export function statusJsonResponse(sc: StatusContext): Response {
  if (!isOwnerView(sc)) {
    return jsonResponse({ private: true, message: PRIVATE_DEPLOYMENT_SENTENCE });
  }
  return jsonResponse({ private: false, status: buildStatusReport(sc) });
}

/**
 * POST /api/status/check: one `GET /users/self` with the owner's token. The
 * answer is whether it worked and the HTTP status, never the profile.
 *
 * It spends the owner's Canvas quota, so it is refused unless the request
 * names this Site as its `Origin` (a form on another site cannot trigger it)
 * and the provider releases the credential to the caller.
 */
export async function statusCheckResponse(sc: StatusContext): Promise<Response> {
  if (!hasSameOriginHeader(sc.request)) {
    sc.log.security('status_check_denied', { reason: 'origin' });
    return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
  }
  if (!isOwnerView(sc)) {
    sc.log.security('status_check_denied', { reason: 'not_owner' });
    return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
  }
  const resolved = await sc.credentials.resolve(sc.identity);
  if (!resolved.ok) {
    if (resolved.reason === 'forbidden') {
      sc.log.security('status_check_denied', { reason: 'not_authorized' });
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }
    return jsonResponse({ ok: false, status: null, reason: resolved.reason });
  }
  const now = sc.now ?? Date.now;
  const client = sc.createClient({
    credential: resolved.credential,
    config: sc.config,
    meter: new SubrequestMeter(CHECK_BUDGET),
    deadline: now() + Math.min(CHECK_DEADLINE_MS, sc.config.toolDeadlineMs),
    log: sc.log,
    allowRaw: false,
    pseudonymSalt: sc.pseudonymSalt,
    ...(sc.fetchImpl !== undefined && { fetchImpl: sc.fetchImpl }),
    ...(sc.now !== undefined && { now: sc.now }),
  });
  const result = await client.request('get', canvasPath`/users/self`);
  if (isFailure(result)) {
    return jsonResponse({ ok: false, status: result.status ?? null });
  }
  return jsonResponse({ ok: true, status: 200 });
}

/** GET /healthz. Says nothing about configuration. */
export function healthResponse(): Response {
  return textResponse('ok');
}

/** GET /robots.txt: nothing here is for a crawler. */
export function robotsResponse(): Response {
  return textResponse(ROBOTS_TXT);
}

/** Serve one status route. GET routes also answer HEAD, without a body. */
export async function handleStatusRoute(route: StatusRoute, sc: StatusContext): Promise<Response> {
  const method = sc.request.method.toUpperCase();
  if (route === 'check') {
    return method === 'POST' ? statusCheckResponse(sc) : methodNotAllowed('POST');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return methodNotAllowed('GET, HEAD');
  }
  let response: Response;
  switch (route) {
    case 'page':
      response = statusPageResponse(sc);
      break;
    case 'json':
      response = statusJsonResponse(sc);
      break;
    case 'health':
      response = healthResponse();
      break;
    default:
      response = robotsResponse();
  }
  return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
