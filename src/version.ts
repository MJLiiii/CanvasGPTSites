/** Version of this port. Keep in step with package.json. */
export const SERVER_VERSION = '0.1.0';

/** The canvas-mcp release this port follows (`.upstream/canvas-mcp` is pinned to it). */
export const UPSTREAM_VERSION = '1.13.0';

/** Sent on every Canvas request so a Canvas admin can tell where the traffic comes from. */
export const USER_AGENT = `canvas-gpt-sites/${SERVER_VERSION} (TypeScript port of canvas-mcp/${UPSTREAM_VERSION})`;
