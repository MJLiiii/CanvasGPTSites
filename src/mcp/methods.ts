// No upstream counterpart: canvas-mcp authenticates every request alike. Here the owner gate
// treats discovery and invocation differently, so the split must not depend on one parser's view.

export type McpRequestClass = 'discovery' | 'invocation' | 'invalid';

/** Methods that reveal the tool list and nothing about Canvas. `notifications/*` is discovery too. */
export const DISCOVERY_METHODS: ReadonlySet<string> = new Set(['initialize', 'server/discover', 'tools/list', 'ping']);

export function isDiscoveryMethod(method: unknown): boolean {
  return typeof method === 'string' && (DISCOVERY_METHODS.has(method) || method.startsWith('notifications/'));
}

/**
 * Classify a parsed /mcp body for the owner gate.
 *
 * - `invalid`: a JSON-RPC batch (an array), or a body that is not an object.
 *   Batches are refused outright rather than gated by their strictest member.
 * - `discovery`: the body's method is a discovery method AND, when the request
 *   carries an `Mcp-Method` header, the header names a discovery method too.
 *   2026-era clients send the method twice; if the two disagree, the request
 *   gets the stricter gate whichever one the backend ends up believing.
 * - `invocation`: everything else, including a body with no usable method.
 *
 * `Headers.get` joins repeated headers with ", ", so a duplicated header never
 * equals a discovery method and falls to `invocation`.
 */
export function classifyMcpRequest(body: unknown, headers: Headers): McpRequestClass {
  if (Array.isArray(body) || body === null || typeof body !== 'object') {
    return 'invalid';
  }
  const method: unknown = (body as Record<string, unknown>).method;
  if (!isDiscoveryMethod(method)) {
    return 'invocation';
  }
  const header = headers.get('mcp-method');
  if (header !== null && !isDiscoveryMethod(header.replace(/^[ \t]+|[ \t]+$/g, ''))) {
    return 'invocation';
  }
  return 'discovery';
}
