> Architect's detailed spec (input to docs/DESIGN.md). Where docs/design/review-findings.md disagrees, the review findings win.

# Design: canvas-mcp (Python, v1.13.0) to TypeScript on ChatGPT Sites

This document preserves the original migration specification. Current implementation results are recorded in docs/STATUS.md and docs/SPIKE.md; installation follows README.md and docs/DEPLOYMENT.md. The 2026-10-03 single-owner decision supersedes the historical multi-user proposals.

Abbreviations:
- `UP` = `.upstream/canvas-mcp`
- `REPO` = `<repository-root>`
- Upstream result markers are written as code points: U+274C (cross mark), U+26A0 (warning sign).

Checked against source this session:
- `UP/tools/TOOL_MANIFEST.json`, `TOOL_EFFECTS` and the `@mcp.tool` decorators each hold the same 104 names: 58 READ, 41 CANVAS_WRITE, 4 LOCAL_WRITE, 1 CODE_EXEC. The "57" comment in `tool_policy.py` is wrong.
- The community starter's Sites plugin only copies `.openai/hosting.json` to `dist/.openai/hosting.json` and `drizzle/**` to `dist/.openai/drizzle/**` in `closeBundle`.
- The community artifact validator `import()`s `dist/server/index.js` under Node and requires `default.fetch`.
- Upstream retries 429 for all HTTP methods (`UP/src/canvas_mcp/core/client.py:587-602`). A 429 after retries is `MAY_HAVE_WRITTEN`; a 403 is `REJECTED`.

## Where I disagree with the draft

1. **Tool schemas must be backend-neutral from day 1.** zod coercion cannot give both upstream's lenient parsing and typed JSON Schemas: `z.coerce.boolean()` is JS truthiness, and `z.stringbool()` / `z.preprocess` advertise string or `{}`. A `ParamSpec` layer generates the advertised schema and the lenient parser; the SDK and the hand-rolled JSON-RPC backend both consume it.
2. **Do not rely on `nodejs_compat`.** Whether Sites applies it to a non-vinext build is unknown. Use `@noble/hashes` for sync SHA-256/HMAC behind one seam (`src/core/hash.ts`).
3. **`dist/server/index.js` must be importable under plain Node.** No top-level `cloudflare:*` imports and no workerd-only calls at module scope.
4. **The owner gate needs a discovery/invocation split.** The platform probably snapshots `tools/list` at publish, possibly without user identity.
5. **No Canvas data in D1 by default.** The course code/id cache is a per-request memo, in line with upstream's "stateless, nothing stored" rule. A D1 cache is opt-in.
6. **R2 presigned URLs are not available** (no S3 credentials on Sites). Exports are served by an owner-gated Worker route.
7. **Partial pagination only for cap, budget or deadline.** A Canvas error mid-stream still returns no partial result (upstream parity). A truncated list may never feed a write (upstream issue 420).
8. **Annotations cannot be copied.** Ten upstream annotations are wrong under OpenAI's rules (section 9).
9. **The guard's advisory SELECT must never decide single-use.** Only the unique INSERT does. Release must be owner-scoped by a `claim_id`.

---

## 1. Repository layout

```
REPO/
  LICENSE                 MIT; own copyright plus upstream "Copyright (c) 2025 Vishal Sachdev" notice verbatim
  NOTICE                  "Portions derived from canvas-mcp (github.com/vishalsachdev/canvas-mcp), MIT"
  README.md               deploy steps, secrets list, tool batches, deviations from upstream
  AGENTS.md               tells Codex: src/ is hand-written; only entry/ and build files may be regenerated
  package.json            type:module; engines node>=22.13; scripts in section 12
  tsconfig.json           strict, ES2022, moduleResolution bundler, types @cloudflare/workers-types
  vite.config.ts          Variant A build: @cloudflare/vite-plugin, worker name "server", inline config
  vitest.config.ts        projects: "unit" (node) and "workers" (@cloudflare/vitest-plugin)
  drizzle.config.ts       drizzle-kit, used only to generate migrations
  .openai/hosting.json    Sites manifest (section 2)
  .dev.vars.example       every variable name with dummy values
  drizzle/0000_init.sql, drizzle/meta/_journal.json   D1 migrations (section 7)
  build/sites-package-plugin.ts   Vite plugin: copies hosting.json and drizzle/** into dist/.openai
  build/validate-artifact.mjs     asserts artifact contract; imports dist/server/index.js in Node
  build/esbuild.mjs               Variant B/D: deterministic single-file bundle
  entry/worker.ts         <=15 lines: export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) }
  entry/vinext/sites-worker.ts    Variant C only: routes /mcp, /api/*, /, /files/* to app, rest to vinext
  src/app.ts              createApp(): router, security gates, error boundary; the only web-standard handler
  src/env.ts              Env type; parseConfig(env) -> Config             [ports UP/src/canvas_mcp/core/config.py]
  src/version.ts          name, version, upstream version pin "1.13.0"
  src/http/router.ts      path/method table; never defines /signin-with-chatgpt, /signout-with-chatgpt, /callback
  src/http/security.ts    host/origin checks, body cap, security headers
  src/http/identity.ts    reads oai-authenticated-user-*; builds Identity      [replaces server.py:268-414]
  src/http/status-page.ts GET /, GET /api/status, POST /api/status/check, GET /healthz, /robots.txt
  src/auth/credentials.ts CredentialProvider, CanvasCredential                 [replaces core/credentials.py]
  src/auth/owner-secret-provider.ts   v1 provider
  src/auth/owner-gate.ts  discovery/invocation gate
  src/mcp/handler.ts      SDK backend: createMcpHandler, responseMode 'json', legacy 'stateless'
  src/mcp/jsonrpc-native.ts  fallback backend: hand-rolled stateless JSON-RPC, both protocol eras
  src/mcp/registry.ts     computeToolSet(config, identity); registers ToolDefs into either backend
  src/mcp/define-tool.ts  defineTool, ParamSpec, buildInputSchema
  src/mcp/dispatch.ts     runTool wrapper: context, coercion, budget, result mapping, audit
  src/mcp/result.ts       ToolResult mapping, isError rules               [ports core/tool_results.py]
  src/mcp/instructions.ts server instructions (key guidance in the first 512 chars)
  src/canvas/client.ts    CanvasClient                                    [ports core/client.py]
  src/canvas/link-header.ts  splitLink, nextPageUrl, validatePageUrl      [lifted from code_api/client.ts:182-249]
  src/canvas/encode.ts    query/form encoding with repeated keys          [client.py:523-565; requestUrl from client.ts:73-83]
  src/canvas/budget.ts    RequestBudget
  src/canvas/limiter.ts   per-call semaphore
  src/canvas/errors.ts    RequestFailure, WriteOutcome, NO_WRITE_STATUSES [ports core/write_outcome.py]
  src/canvas/course-resolver.ts   per-request course code/id resolution   [ports core/cache.py]
  src/canvas/files.ts     download with manual redirects; 3-step upload   [client.py:637-740, tools/files.py]
  src/canvas/cursor.ts    HMAC-signed continuation cursors
  src/core/anonymization.ts       scrub_identity, typed refinements       [ports core/anonymization.py]
  src/core/anonymization-tiers.ts endpoint -> tier                        [client.py:99-323]
  src/core/untrusted-content.ts   fencing, registry                       [ports core/untrusted_content.py]
  src/core/dates.ts, raw-dates.ts                                         [core/dates.py, core/raw_dates.py]
  src/core/validation.ts  lenient coercion, coerceCanvasId, formatError   [core/validation.py]
  src/core/tool-policy.ts TOOL_EFFECTS (all 104), resolveToolPolicy       [core/tool_policy.py]
  src/core/guarded-edit.ts                                                [core/guarded_edit.py]
  src/core/course-policy.ts                                               [core/course_policy.py]
  src/core/confirmation.ts  ConfirmationGuard, previewWithToken, redeemConfirmation, unconfirmedWriteWarning
                                                                          [core/write_confirmation.py]
  src/core/csv-safety.ts, file-validation.ts (sanitize_filename and MIME map only), enrollment.ts,
           peer-reviews.ts, peer-review-comments.ts                       [same-named core/*.py]
  src/core/html.ts        strip_html_tags, linear tag scanner for embedded media, entity decode
  src/core/pyformat.ts    restricted str.format for bulk message templates
  src/core/hash.ts        sha256Hex, hmacHex (sync, @noble/hashes), constantTimeEqual
  src/core/logging.ts, audit.ts                                           [core/logging.py, core/audit.py]
  src/store/nonce-store.ts  NonceStore interface; D1NonceStore; MemoryNonceStore (tests)
  src/store/schema.ts     drizzle table definitions (migration source only)
  src/store/bootstrap.ts  CREATE TABLE IF NOT EXISTS safety net (DB_BOOTSTRAP)
  src/store/export-store.ts R2 exports (batch 5)
  src/tools/index.ts      ALL_TOOLS: ToolDef[] in deterministic order
  src/tools/{self-identity,student,student-write,courses,assignments,enrollment,discussions,messaging,
             discovery,rubrics,peer-reviews,peer-review-comments,modules,pages,files,accessibility,admin,
             content-migrations}.ts      one file per UP/src/canvas_mcp/tools/<same>.py
  src/tools/diagnostics.ts  spike-only tools (DIAGNOSTICS_ENABLED)
  src/tools/upstream-metadata.json  generated: name, docstring, per-param descriptions, annotations
  scripts/extract-upstream-metadata.py  dev-only; reads the UP checkout, writes upstream-metadata.json
  scripts/parity/run-parity.ts          runs upstream stdio server and this handler, diffs normalized output
  test/unit, test/security, test/tools, test/integration, test/workers, test/helpers/fake-canvas.ts
  test/fixtures/canvas_raw_dates.json   copied from UP/tests/fixtures
  skills/<8 dirs>/SKILL.md              batch 5, reworded
  docs/SPIKE.md, docs/PORTING.md, docs/PARITY.md
```

**Not ported:**
- `UP/src/canvas_mcp/core/access/*` and the Entra/admin routes
- `UP/src/canvas_mcp/tools/code_execution.py`
- `code_api/batching.ts`, `code_api/canvas/**` — reference only; `sendMessage.ts` has no preview guard and must not be exposed
- `resources/resources.py`: two resources and one prompt are deferred (ChatGPT ignores them); `code-api-file` is dropped

**Lifted from `UP/src/canvas_mcp/code_api/client.ts`:**
- `splitLink`, `nextPageUrl`, `validatePageUrl`, `requestUrl` (lines 73-83, 182-249), unchanged except exports.
- The write-outcome wording "Canvas write may have been applied…".
- Not lifted: module-global `config`, `process.env` auto-init, `redirect:'follow'` for GET, the 10,000-page cap, the retry loop.

**Runtime dependencies:** `@modelcontextprotocol/server` ^2.2.0, `zod` ^4.5, `@noble/hashes`, `entities`.

---

## 2. Entry and adapter strategy

**Invariant.** `src/app.ts` exports `createApp(): { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> }`. It uses only web-standard APIs plus the D1/R2 binding objects passed in `env`. Every adapter is a re-export.

**Variant A (default): plain Worker, Vite 8 + `@cloudflare/vite-plugin`.**
- `cloudflare({ config: { name: 'server', main: './entry/worker.ts', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'site-creator-d1', database_id: '00000000-0000-4000-8000-000000000000' }] } })` plus `sitesPackage()`.
- Reason: it is the bundler every Sites starter uses, it resolves the `workerd` export condition, and it emits `dist/server/wrangler.json` like vinext builds.
- I did not confirm that the plugin writes to `dist/<worker name>`. `build/validate-artifact.mjs` asserts `dist/server/index.js`; if the name differs, set `environments.server.build.outDir = 'dist/server'`.

**Variant B: `build/esbuild.mjs`.** One command: `format:'esm'`, `conditions:['workerd','worker','browser']`, `outfile:'dist/server/index.js'`, `external:['node:*','cloudflare:*']`, then the same copy step. Use it if the Vite plugin misbehaves in the Sites builder.

**Variant C: vinext wrapper.** Only if the builder or Codex insists on vinext. Add `vinext` and `react`, a one-page `app/`, and `entry/vinext/sites-worker.ts` as `main`.

**Variant D: buildless.** Commit Variant B's output as `worker/index.js` plus the manifest.

**`.openai/hosting.json`:**
```json
{ "d1": "DB", "r2": null, "capabilities": ["mcp"] }
```
- `project_id` is added by Sites and preserved.
- `r2` becomes `"FILES"` in batch 5.
- No secrets in this file.

**Spike build safety.**
- M0 deploys with no `CANVAS_API_TOKEN` secret, `DIAGNOSTICS_ENABLED=true` and `OWNER_GATE=observe`.
- `observe` logs gate decisions without blocking. The code refuses it (HTTP 500) whenever `CANVAS_API_TOKEN` is present.

**Spike questions and how each answer changes the design:**

| # | Question | If yes / expected | If no / otherwise |
|---|---|---|---|
| Q1 | Does a pushed plain-Worker repo build remotely and deploy? | Variant A | Try a locally built archive of A; then Variant C |
| Q2 | Does Codex adopt the repo without regenerating it? | Keep layout | Let Codex scaffold; drop `src/` in and route from its `build/sites-worker.ts` |
| Q3 | Is `capabilities:["mcp"]` enough, and is `mcp_url` `/mcp`? | `MCP_PATH=/mcp` | Set `MCP_PATH` to the reported path; add any manifest fields Codex writes |
| Q4 | Which headers reach `/mcp` (id, email, full-name, Authorization, Origin, Host)? | Identity from headers | See Q5 fallback; set `ALLOWED_HOSTS` from the observed Host |
| Q5 | Are caller-supplied `oai-authenticated-*` headers stripped (forge one and compare hashes)? | Header gate is sound | Stop. Do not deploy the token. Options: verify a forwarded gateway JWT if one exists, or `ALLOW_PLATFORM_TRUST` on a private Site, read-only |
| Q6 | Is the user id on `/mcp` equal to the one on web pages and stable across republish? | `Identity.key = id:<id>` | `Identity.key = email:<email>`; v2 linking keyed by email |
| Q7 | Does publish call `tools/list` without identity? | `DISCOVERY_REQUIRES_OWNER=false` | Keep `true` |
| Q8 | Which protocol era and version does ChatGPT send? | SDK default serves both | If modern-only features break, pin `legacy` handling; MRTR stays out of v1 |
| Q9 | Does the SDK bundle and run; is `node:crypto` importable? | `MCP_BACKEND=sdk` | `MCP_BACKEND=native`; `hash.ts` stays on noble either way |
| Q10 | Subrequest cap per invocation (sequential probe, n up to 120)? | Raise `CANVAS_REQUEST_BUDGET` up to 200 if >= 1000 | Keep 40; if < 50, set budget to cap minus 10 and disable L-tier tools |
| Q11 | CPU cap (spin probe) and tool-call timeout (wait probe at 10/30/60/120 s)? | `TOOL_DEADLINE_MS` = timeout minus 5 s | If CPU is ~10 ms: disable accessibility scan and peer-review analytics; anonymization memo is mandatory |
| Q12 | Largest tool result ChatGPT accepts? | Set `MAX_TOOL_RESULT_BYTES` to 80% of it | Keep 200,000 |
| Q13 | Does the plugin accept ~40 and ~100 tools? | Role `all` is usable | Keep `CANVAS_ROLE=student`; use `DISABLED_TOOLS` |
| Q14 | Are packaged migrations applied before traffic? | `DB_BOOTSTRAP=false` | Keep `DB_BOOTSTRAP=true` |
| Q15 | Are secrets plain `env` bindings; is a redeploy needed? | As designed | Adjust `parseConfig` source |
| Q16 | Is the Canvas host reachable, and does `redirect:'manual'` return the 3xx? | As designed | Ask the admin to allowlist the host; no workaround in code |
| Q17 | Does ChatGPT prompt the user for tools with `destructiveHint:true`? | Tokens plus prompt (double confirm is accepted) | Tokens remain the only step; say so in the README |
| Q18 | Does the `OAI-Sites-Authorization` bypass token work on `/mcp`? | Inspector can test production discovery | Production tests only through ChatGPT |
| Q19 | Do owner web requests to `/` carry identity headers? | Status page shows owner view | Status page shows only the public view; details via the diagnostics tool |
| Q20 | Can a Site-hosted plugin carry skills? | Ship `skills/` in batch 5 | Skills become README workflows |

**Spike tools** (registered only when `DIAGNOSTICS_ENABLED=true`):
- `hello`.
- `sites_diagnostics(probe, n)` with probes `headers | runtime | subrequests | cpu | wall | size | d1`.
- The `headers` probe reports header names, lengths and `sha256[:8]` of values. For `Authorization` it reports only presence, scheme, segment count, and JWT `iss`/`aud` if it parses.
- The `runtime` probe reports env binding names. Neither probe returns header values or secret values.

---

## 3. Request lifecycle for POST /mcp

1. **Adapter** calls `app.fetch`.
2. **Route.**
   - `MCP_PATH`: POST only; GET and DELETE return 405.
   - `/`, `/api/status`, `/api/status/check`, `/healthz`, `/robots.txt`: status module.
   - Anything else: 404.
3. **Config.** `parseConfig(env)` is memoized per isolate in a `WeakMap<Env, Config>`. Any fail-closed violation (section 4) returns HTTP 500 with JSON-RPC error -32603 "Server misconfigured". Detail goes to logs and the owner status view only.
4. **Host and Origin.**
   - If `ALLOWED_HOSTS` is set, Host must match, else 403.
   - If an Origin header is present, it must equal the Site origin or be in `ALLOWED_ORIGINS`, else 403.
   - A missing Origin passes.
5. **Body.**
   - Reject `Content-Length` over `MAX_REQUEST_BYTES` with 413.
   - Read the text once and parse JSON; a parse error returns -32700.
   - A batch array is gated by its strictest member.
6. **Identity.** `resolveIdentity(headers)` reads `oai-authenticated-user-id`, `-email`, `-full-name` (percent-decoded when the encoding header says so). Email is lowercased and trimmed.
7. **Owner gate.**
   - Method class `discovery` = `initialize`, `server/discover`, `tools/list`, `ping`, `notifications/*`. Everything else is `invocation`.
   - Invocation always needs an identity that passes `credentials.authorize`.
   - Discovery needs it only when `DISCOVERY_REQUIRES_OWNER=true`.
   - Missing identity returns HTTP 401; a non-owner returns HTTP 403. Both bodies are a generic JSON-RPC error -32001. A security log line is written with the identity hash only.
8. **Policy.** `computeToolSet(config, identity)` returns the allowed tool names (section 6). It is memoized per isolate and config.
9. **Server construction.** Per request, build a `RequestContext` and a fresh `McpServer` (or the native dispatcher) and register only allowed tools. Schemas are module-scope constants.
10. **Dispatch** (`runTool`), for `tools/call`:
    1. Unknown or unregistered tool: JSON-RPC -32602 (tool does not exist; same as upstream removal).
    2. `credentials.resolve(identity)`; failure returns an `isError` result with a fixed public message.
    3. Coerce and validate arguments via `ParamSpec`. Failure returns the text `{"error": "<msg>"}` with `isError`.
    4. Build `ToolContext` with a `CanvasClient` whose budget is `min(def.budget.requests, config.canvasRequestBudget)` and whose deadline is `startedAt + TOOL_DEADLINE_MS`.
    5. `await def.handler(args, ctx)`.
    6. Map the result (step 11).
11. **Result and error mapping.**
    - A string becomes one text block with no `structuredContent`.
    - An object becomes text `JSON.stringify(obj)` plus `structuredContent`.
    - `isError` is true when the text starts with `Error` or U+274C, or parses as a JSON object with an `error` key, or the object has `error`.
    - A thrown exception becomes `Error: <class-level message>`; the stack goes to logs.
    - An undisclosed truncation recorded on the client gets the standard notice appended (text) or a `truncated` field (object).
    - Output over `MAX_TOOL_RESULT_BYTES` is cut at a line boundary with an explicit notice. A confirmation preview is never cut; the tool returns an error asking for a smaller batch.
    - Final pass: if the credential token string occurs in the output, replace it with `[REDACTED]` and log a security event.
12. **Logging.** One JSON line per request and per tool call: request id, tool, effect, isError, ms, Canvas request count, truncation flag, identity hash. No arguments, bodies, headers, emails or URLs with queries. Write tools also insert a `write_audit` row via `ctx.waitUntil`.
13. **Response.** `application/json`, `Cache-Control: no-store`.

**Interfaces:**

```ts
export interface Identity {
  key: string;                       // "id:<oai-authenticated-user-id>" or "email:<lowercased email>"
  userId: string | null;
  email: string | null;
  fullName: string | null;
  source: 'sites-gateway' | 'local-dev';
}

export interface CanvasCredential {
  apiBaseUrl: string;                // normalized https://host/api/v1
  origin: string;
  token: string;                     // never logged, never returned
  callerId: string;                  // hmacHex(K_caller, token); upstream caller_identity()
  kind: 'owner-secret';
}

export type CredentialResult =
  | { ok: true; credential: CanvasCredential }
  | { ok: false; reason: 'not_configured' | 'forbidden'; publicMessage: string };

export interface CredentialProvider {
  readonly mode: 'owner';
  authorize(identity: Identity | null): { ok: true } | { ok: false; status: 403; publicMessage: string };
  resolve(identity: Identity | null): Promise<CredentialResult>;
}

export interface RequestContext {
  requestId: string;
  startedAt: number;
  deadline: number;
  config: Config;
  env: Env;
  identity: Identity | null;
  era: 'legacy' | 'modern';
  credentials: CredentialProvider;
  db: D1Database | null;
  files: R2Bucket | null;
  log: Logger;
  waitUntil(p: Promise<unknown>): void;
}

export type WriteOutcome = 'not_dispatched' | 'rejected' | 'may_have_written';
export interface RequestFailure { error: string; readonly outcome: WriteOutcome; status?: number;
                                  throttled?: boolean; budgetExhausted?: boolean }   // outcome non-enumerable
export type Scalar = string | number | boolean | null;
export type Params = Record<string, Scalar | Scalar[] | undefined>;
export type FormBody = Record<string, Scalar | Scalar[]> | Array<[string, Scalar]>;

export interface RequestOptions { params?: Params; data?: FormBody | unknown; useFormData?: boolean;
                                  multipart?: FormData; skipAnonymization?: boolean; apiRoot?: 'rest' | 'quiz' }
export interface PageOptions { maxPages?: number; maxItems?: number; skipAnonymization?: boolean;
                               label?: string; cursor?: string }
export interface Paged<T> { items: T[]; truncated: boolean; reason?: 'max_pages' | 'max_items' | 'budget' | 'deadline' | 'throttle';
                            pagesFetched: number; nextCursor?: string }

export interface CanvasClient {
  request<T = any>(method: 'get' | 'post' | 'put' | 'delete', endpoint: string, o?: RequestOptions): Promise<T | RequestFailure>;
  fetchAll<T = any>(endpoint: string, params?: Params, o?: PageOptions): Promise<Paged<T> | RequestFailure>;
  requireComplete<T>(p: Paged<T>, what: string): string | null;   // error text if truncated; use before any write
  disclose(p: Paged<unknown>, label: string): string;             // returns the notice and marks it disclosed
  downloadFile(fileUrl: string, o: { maxBytes: number }): Promise<{ bytes: Uint8Array; contentType: string } | RequestFailure>;
  uploadFile(step1Endpoint: string, file: { name: string; bytes: Uint8Array; contentType: string }, extra?: Params): Promise<any | RequestFailure>;
  readonly courses: { resolveId(identifier: string | number): Promise<string | RequestFailure>;
                      resolveCode(courseId: string): Promise<string | null> };
  readonly budget: { limit: number; used: number; remaining: number; reserve(n: number): void };
  readonly truncations: ReadonlyArray<{ label: string; reason: string; disclosed: boolean }>;
}
export function isFailure(x: unknown): x is RequestFailure;       // upstream `"error" in response`

export type Effect = 'read' | 'canvas_write' | 'local_write' | 'code_exec';
export type ParamSpec =
  | { kind: 'id' | 'string' | 'int' | 'float' | 'bool'; optional?: boolean; default?: Scalar; description: string }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean; default?: string; description: string }
  | { kind: 'list'; items: 'string' | 'id' | 'object'; optional?: boolean; description: string }
  | { kind: 'dict'; optional?: boolean; description: string };

export interface ToolDef<P extends Record<string, ParamSpec> = Record<string, ParamSpec>> {
  name: string;
  title: string;
  description: string;                      // upstream docstring, verbatim unless a param was removed
  module: string;                           // upstream file
  role: 'shared' | 'student' | 'educator';
  effect: Effect;
  gate?: { studentWrite?: true; accessibilityChecker?: 'ufixit'; needsD1?: true; needsR2?: true; needsConfirmSecret?: true };
  params: P;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  budget: { tier: 'S' | 'M' | 'L'; requests: number; min?: number };
  fencing: 'fenced' | 'safe' | 'deferred';
  output: 'text' | 'json';
  handler(args: InferArgs<P>, ctx: ToolContext): Promise<string | Record<string, unknown>>;
}
export function defineTool<P extends Record<string, ParamSpec>>(def: ToolDef<P>): ToolDef<P>;

export interface ToolContext extends RequestContext {
  tool: ToolDef; identity: Identity; credential: CanvasCredential; canvas: CanvasClient;
  confirm: ConfirmationService; coursePolicy: CoursePolicyService;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
```

**SDK binding gate (M1).** `buildInputSchema(params)` returns `{ jsonSchema, parse }`.
- First choice: hand the SDK a Standard Schema object whose `validate` is `parse` and whose JSON Schema is ours.
- An M1 test asserts that `tools/list` emits our schema unchanged.
- I did not verify that SDK 2.2.0 honours a non-zod Standard Schema for listing. If it does not, register zod schemas with accept-unions (`anyOf`) and coerce after validation, or switch to the native backend.

---

## 4. Configuration

Parsing rules are kept from upstream: booleans are true only for the string `true`; an invalid number falls back to the default and is reported on the status page.

| Variable | Status | Default here (upstream) | Notes |
|---|---|---|---|
| `CANVAS_API_URL` | keep, secret | none | Normalized to `/api/v1`. Must be https, no userinfo, port 443 or none, no IP literal |
| `CANVAS_API_TOKEN` | keep, secret, meaning inverted | none | Required for the configured owner |
| `AUTH_MODE` | add | `owner` | Unset or `owner`; other values are request-blocking errors |
| `OWNER_EMAIL` | add, secret | none | Compared case-insensitively to the gateway email |
| `OWNER_USER_ID` | add, secret | none | If set, must also match the gateway user id |
| `ALLOW_PLATFORM_TRUST` | replaces `MCP_ALLOW_UNAUTHENTICATED` | false | Lets invocation proceed with no identity headers; owner mode only; forces read-only |
| `OWNER_GATE` | add | `enforce` | `observe` allowed only with no token configured |
| `DISCOVERY_REQUIRES_OWNER` | add | true | Q7 |
| `CONFIRMATION_SECRET` | add, secret | none | At least 32 chars. Missing: every guarded tool is unregistered |
| `PSEUDONYM_SALT` | add, secret | unset | Unset = upstream-compatible unsalted SHA-256 |
| `MCP_SERVER_NAME` | keep | `canvas-api` | |
| `MCP_PATH` | add | `/mcp` | |
| `MCP_BACKEND` | add | `sdk` | `sdk` or `native` |
| `CANVAS_ROLE` | keep | `student` (`all`) | Also scopes `list_courses` as upstream |
| `ALLOWED_WRITE_TOOLS` | keep | unset = read-only | Transport is always HTTP semantics |
| `STUDENT_WRITE_TOOLS` | keep | empty | Ceiling over the three student writes |
| `COURSE_AGENT_POLICY_ENABLED` / `_DEFAULT` / `_ALLOW_TTL` / `_DENY_TTL` | keep | true / deny / 30 / 300 | |
| `ACCESSIBILITY_CHECKERS` | keep | `ufixit` | |
| `ENABLE_DATA_ANONYMIZATION` | keep | true | |
| `LOG_REDACT_PII` | keep | true | |
| `LOG_ACCESS_EVENTS` | keep | true (false) | Console only |
| `LOG_LEVEL` | keep, now honoured | `info` | Replaces `DEBUG`, `LOG_API_REQUESTS`, `ANONYMIZATION_DEBUG` |
| `AUDIT_TO_D1` | replaces `AUDIT_LOG_DIR` | true | Write tools only |
| `TIMEZONE` | keep | `UTC` | |
| `INSTITUTION_NAME` | keep | empty | Status page only |
| `API_TIMEOUT` | keep | 15 (30) seconds | Also capped by the remaining deadline |
| `MAX_CONCURRENT_REQUESTS` | keep | 3 (10) | Clamped to 1..4 |
| `READ_FILE_MAX_SIZE_MB` | keep | 5 (100) | Clamp for `read_course_file` |
| `CACHE_TTL` | keep, now used | 300 | Only when `COURSE_CACHE=d1` |
| `COURSE_CACHE` | add | `request` | `request` or `d1` |
| `CANVAS_REQUEST_BUDGET` | add | 40 | Hard max 200 |
| `CANVAS_MAX_PAGES` | add | 10 | Per paginated list |
| `TOOL_DEADLINE_MS` | add | 25000 | |
| `MAX_TOOL_RESULT_BYTES` | add | 200000 | |
| `MAX_REQUEST_BYTES` | add | 1048576 | 8388608 when upload tools are allowed |
| `MAX_UPLOAD_MB` | add | 5 | Total decoded bytes per call |
| `MAX_BULK_ITEMS` | add | 20 | Further limited by budget |
| `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` | add | unset | Comma lists |
| `DISABLED_TOOLS` | add | empty | Removes named tools of any effect |
| `DIAGNOSTICS_ENABLED` | add | false | |
| `DB_BOOTSTRAP` | add | true until Q14 says otherwise | |
| `TOKEN_ENCRYPTION_KEY`, `CANVAS_OAUTH_CLIENT_ID`, `CANVAS_OAUTH_CLIENT_SECRET` | v2 | none | |

**Dropped:**
- `CANVAS_ALLOW_INSECURE_HTTP`
- `EXECUTE_TYPESCRIPT_ENABLED`, `ENABLE_TS_SANDBOX`, all `TS_SANDBOX_*`
- `MCP_ACCESS_KEYS`, `ENTRA_AUTH_ENABLED`, `MCP_ENTRA_ALLOWED_OIDS`
- all `ACCESS_*` and `ACS_*`
- `LOG_EXECUTION_EVENTS`
- the unimplemented `TOKEN_STORAGE_BACKEND`, `MCP_BIND_*`, `LOG_ROTATION_DAYS`, `SIEM_FORWARDING_ENABLED`

**Fail-closed rules:**
- **F1.** Owner mode with missing URL, token, or both owner identifiers: invocation refused; discovery still works.
- **F2.** Per-user mode with `CANVAS_API_TOKEN` set: every `/mcp` request returns 500.
- **F3.** Invalid `CANVAS_API_URL`: 500.
- **F4.** `ALLOWED_WRITE_TOOLS` unparseable (unknown name, read tool named, `none` combined): 500. Dropped tool names are known and accepted, but never registered.
- **F5.** Unknown `CANVAS_ROLE` or `AUTH_MODE`: 500.
- **F6.** No identity and no `ALLOW_PLATFORM_TRUST`: 401.
- **F7.** `ALLOW_PLATFORM_TRUST=true` with a non-empty write allowlist: 500.
- **F8.** Missing `CONFIRMATION_SECRET` or `DB`: guarded tools are unregistered and the status page says why.
- **F9.** A tool missing from `TOOL_EFFECTS` is never registered.

---

## 5. Canvas client spec

**Request shape.**
- One instance per tool call.
- URL = `apiBaseUrl` + endpoint, leading `/` forced.
- Endpoint refused locally (`not_dispatched`) if it contains `?`, `#`, a `..` segment, a backslash, or a control character.
- Headers: `Authorization: Bearer`, `Accept: application/json`, `User-Agent: canvas-gpt-sites/<version> (TypeScript port of canvas-mcp)`.
- `redirect: 'manual'` on every call. A 3xx on an API call is the failure `HTTP error: 302` (same as upstream).
- Timeout = min(`API_TIMEOUT`, time left to deadline).

**Encoding** (port of `client.py:523-565`).
- GET and DELETE put params in the query: lists become repeated keys, booleans become `true`/`false`, null becomes an empty string.
- POST/PUT with `useFormData` send urlencoded with repeated keys, and accept a tuple list for duplicate keys.
- Otherwise the body is JSON.

**Throttle detection.** A response is throttled if any of these holds:
- status 429
- 403 whose body contains `Rate Limit Exceeded`
- 403 with `X-Rate-Limit-Remaining` <= 0

**Retry rules.**
- GET, throttled: up to 2 retries. Wait = integer `Retry-After` if present, else 1 s then 2 s, plus up to 250 ms jitter. No retry if the wait would pass `deadline - 2 s` or the budget is empty.
- GET, network error or 502/503/504: 1 retry after 500 ms.
- POST/PUT/DELETE: never retried. Upstream retries 429 for writes; I drop that because a sleep inside a budgeted invocation is worse than returning.
- Outcome classification is unchanged from upstream: 400/401/403/404/422 are `rejected`; everything else, including 429 and timeouts, is `may_have_written`. Local refusals and budget exhaustion are `not_dispatched`.
- A non-JSON 2xx stays an error with `may_have_written`, as upstream.

**Proactive slowdown.**
- `X-Rate-Limit-Remaining` below 150: concurrency drops to 1 for the rest of the call.
- Below 50: pagination stops with reason `throttle`.

**Concurrency.** Per-client semaphore, default 3, max 4.

**Budget.**
- Every outbound fetch costs 1. That includes retries, redirect hops, each page, upload hops and course-resolution calls. D1 and R2 calls are not counted, but are capped at 20 per call.
- Tiers: S <= 6, M <= 20, L <= 40. A tool's effective budget is `min(def.budget.requests, CANVAS_REQUEST_BUDGET)`.
- If `def.budget.min` exceeds the configured budget, the tool is not registered.
- Write tools call `budget.reserve(n)` for their write and read-back steps before any read.
- Exhaustion: `fetchAll` returns `truncated` with reason `budget`; `request` returns a `not_dispatched` failure naming the budget.

**Pagination contract.**
- `per_page=100`. Follow the opaque `rel="next"` link using the lifted RFC 8288 parser.
- The next URL must keep origin and path, with no userinfo and no fragment. A cycle is an error.
- Stops: `maxPages` (default `CANVAS_MAX_PAGES`), `maxItems`, budget, deadline, throttle. Each returns `{items, truncated: true, reason}`.
- A Canvas error on any page returns the failure with no partial items.
- A non-array page is an error.
- Anonymization runs once over the merged list.

**Cursors.**
- `nextCursor` = base64url of `{v, tool, endpoint, query}` plus an HMAC under a key derived from `CONFIRMATION_SECRET`.
- A cursor is accepted only for the same tool and endpoint.
- Without the secret, no cursors are issued.

**Truncation disclosure (mandatory).**
- Text tools append: `U+26A0 Results truncated: showing <n> <label> from the first <p> page(s); more exist in Canvas. <hint>`.
- The hint is either `Call again with cursor="<c>" to continue.` or `Narrow the request (one course, a search term, or a date range).`
- JSON tools add `"truncated": true` and `"truncation": {label, reason, next_cursor}`.
- Aggregates over a truncated list are labelled partial.
- Any decision to write requires `requireComplete`.

**File download.**
- Hop 0 must be on the Canvas origin and carries auth.
- On 3xx, the `Location` must be https. Same origin keeps auth; cross-origin drops it.
- At most 3 hops, each costing budget.
- The body is streamed with a byte counter and aborted over `maxBytes`. `Content-Length` is checked first.

**File upload.**
- Step 1: POST with auth returns `upload_url` and `upload_params`.
- Step 2: multipart POST to `upload_url`, https only, no auth, params in the given order with `file` last.
- Step 3: on 301/302/303, GET the `Location` with auth only if its origin equals the Canvas origin. Otherwise return `unconfirmedWriteWarning`. This fixes `client.py:706-719`.
- Bytes come from base64 input as a `Blob`; no temp file.

**Course identifier resolution** (replaces `core/cache.py`):
1. All digits: returned.
2. `sis_course_id:` prefix: the rest is validated (no `/ ? #` or control characters) and percent-encoded.
3. Otherwise load the caller's course list once per request (`/courses?per_page=100`, max 5 pages) into a memo and match `course_code` exactly.
4. Miss with `_` in the value: `sis_course_id:<encoded>` (upstream fallback).
5. Any other miss: error `Course '<x>' not found. Use list_courses to get the course ID.` Upstream interpolates the raw value into the path.

`resolveCode(id)` uses the memo, else one `GET /courses/{id}` if budget allows, else the id. With `COURSE_CACHE=d1` the memo is persisted in `cache_entry` under `scope = callerId` with `CACHE_TTL`.

---

## 6. Cross-cutting modules

**Anonymization** (`src/core/anonymization.ts`, `anonymization-tiers.ts`).
- Applied only inside the client; a lint rule bans tool modules from importing it.
- Tier selection is a line-for-line port of `_endpoint_anonymization_mode`:
  - exact `users/self` and `users/self/profile`: NONE
  - `submissions/self`: the `submissions` segment is stripped before matching
  - discussion `entries`/`view`/`entry_list`/`replies`: FULL
  - `users`/`submissions`/`enrollments`/`analytics`: FULL
  - `conversations`: FREE_TEXT
  - `pages`/`front_page`: IDENTITY
  - the page-slug exclusion is kept
- All field sets, regex order (SSN, email, phone) and typed refinements are ported as data tables.
- Pseudonym = `Student_` + first 8 hex of SHA-256 of the decimal id string. Email fields become `student_<hex>@example.edu`; a missing id becomes `[REDACTED]`.
- Hashing is synchronous via `@noble/hashes`: the scrubber is a sync recursive walk, WebCrypto digest is async-only, and `node:crypto` depends on a flag I cannot confirm.
- A per-request `Map` keyed by `prefix:id` memoizes hashes, so each distinct id is hashed once. This also fixes upstream's prefix collapse.
- Default is unsalted, for parity with upstream output and skills. Canvas ids are small integers, so the hash is brute-forceable.
- `PSEUDONYM_SALT` switches to HMAC. It remains optional for a single-owner Site.

**Fencing** (`untrusted-content.ts`).
- Exact marker strings, `UNTRUSTED_NOTICE`, `FENCE_LEAK_ERROR`.
- `neutralizeMarkerSpoofing` and `neutralizeInlineTerminator` are single-pass scans, not regex replaces.
- `containsFenceMarkers` is checked on every write input.
- The read-tool registry becomes `ToolDef.fencing`; a test requires a classification on every READ tool.
- Fencing is never applied in the client or the anonymizer.

**Dates.**
- `parseDate` tries upstream's eight formats in order; a naive value is UTC.
- `formatDate` returns `N/A` for empty and the input for unparseable values.
- It converts with `Intl.DateTimeFormat` in `TIMEZONE` and prints ISO seconds with `Z` at zero offset, else `+HH:MM`. An unknown zone falls back to UTC with one warning.
- `raw-dates.ts` is a pure port, tested with `canvas_raw_dates.json`.

**Validation.** `coerce(spec, value)` ports `validate_params`:
- int/float from numeric strings; empty string rejected
- bool from `true/yes/1/t/y` and `false/no/0/f/n`
- list from a JSON array string or comma-separated string
- dict from a JSON object string
- `coerceCanvasId` accepts only `^[0-9]+$`
- `id` params advertise `string | integer` exactly where upstream has `str | int`

**Result contract.** As in lifecycle step 11. String tools never get `structuredContent`. The ten dict tools (eight messaging, two content-migration) return both forms.

**Tool policy.**
- `TOOL_EFFECTS` is copied with all 104 names.
- `resolveToolPolicy(raw)` uses HTTP semantics only: unset or empty = none; `none`; `all` = CANVAS_WRITE plus LOCAL_WRITE; a list = exactly those.
- `computeToolSet` applies, in order: role gate, `STUDENT_WRITE_TOOLS`, `ACCESSIBILITY_CHECKERS`, feature gates (D1, R2, confirm secret, budget minimum), `DISABLED_TOOLS`, then the write policy.
- Only the result is registered.
- Tests: completeness, and READ if and only if `readOnlyHint`.

**Guarded edit.** Pure port of `BodyGuard`, `validateGuard`, `checkUpdatedAt` (whole-second compare), `checkBodyHash`, `checkRequire`, `applyFindReplace` (exactly one match), `prepareBody`, `readbackFailure`, `runGuardedWrite` (fetch, write, refetch). All message constants are verbatim.

**Course policy.**
- Port of `parsePolicyBody`: `agent_writes: allow|deny`, `allow_tools:`, `note:`; HTML stripped; conflict or malformed means deny.
- `assertNoIdentityOverride` is ported.
- `checkStudentWriteAllowed` checks the `STUDENT_WRITE_TOOLS` ceiling first, then the syllabus.
- Cache is a per-isolate `Map` keyed by `(callerId, courseId)` with the allow/deny TTLs. Read errors are not cached.
- It is correct without the cache, at one extra request per student write.

**Confirmation guard.**
- Token format unchanged: `expiry.nonce.authmac.fpmac`, 300 s TTL, max length 256.
- `K_guard = HMAC(CONFIRMATION_SECRET, "confirm-guard|" + guardName)`; `K_caller = HMAC(CONFIRMATION_SECRET, "caller")`.
- `authmac = HMAC(K_guard, "auth|expiry|nonce")[:32]`; `fpmac = HMAC(K_guard, "expiry|nonce|fingerprint")[:32]`.
- The fingerprint is SHA-256 over `callerId` and length-prefixed parts, as upstream.
- `issue` writes nothing.
- The 15 guard names: `delete_announcement`, `bulk_delete_announcements`, `criteria_delete`, `delete_page`, `content_migration`, `submission`, `delete_assignment`, `update_syllabus`, `delete_module`, `delete_module_item`, `bulk_message`, `send_conversation`, `reminder`, `campaign`, `rubric_update`. Each keeps its upstream `nothing_done` wording.

```sql
CREATE TABLE confirm_nonce (
  guard      TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('claimed','spent','burned')),
  claim_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,   -- the token's own signed expiry, epoch seconds
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guard, nonce)
);
CREATE INDEX idx_confirm_nonce_expires ON confirm_nonce (expires_at);

-- claim (reserve); success iff meta.changes = 1
INSERT INTO confirm_nonce (guard, nonce, state, claim_id, expires_at, created_at)
VALUES (?1, ?2, 'claimed', ?3, ?4, ?5)
ON CONFLICT (guard, nonce) DO NOTHING;

-- burn (authentic token, fingerprint mismatch, not expired)
INSERT INTO confirm_nonce (guard, nonce, state, claim_id, expires_at, created_at)
VALUES (?1, ?2, 'burned', ?3, ?4, ?5)
ON CONFLICT (guard, nonce) DO UPDATE SET state = 'burned';

-- release (owner only; outcome not_dispatched or rejected); released iff meta.changes = 1
DELETE FROM confirm_nonce WHERE guard = ?1 AND nonce = ?2 AND claim_id = ?3 AND state = 'claimed';

-- spend (any other outcome)
UPDATE confirm_nonce SET state = 'spent' WHERE guard = ?1 AND nonce = ?2 AND claim_id = ?3 AND state = 'claimed';

-- purge, via waitUntil, at most once per request
DELETE FROM confirm_nonce WHERE expires_at < ?1;   -- ?1 = now - 60
```

How upstream semantics survive across isolates:
- `check` keeps upstream's order and strings: malformed, then mismatch (burn), then expired, then already used.
- The "already used" SELECT is advisory, for wording only. The claim INSERT is the sole authority. It is a write on the D1 primary, so two isolates cannot both get `changes = 1`.
- Burn wins over a concurrent claim: the upsert sets `burned`, and the owner's release requires `state = 'claimed'`.
- Release is owner-only through `claim_id`. This is stricter than upstream's legacy `release(token)` and equal in every upstream call path.
- Purged rows are already past the signed expiry, so the expiry check rejects those tokens before any lookup.
- The secret and the claim store are both shared, which removes the hazard upstream's docstring gives for staying per-process.
- A D1 error fails closed: `U+274C Could not verify the confirmation (storage unavailable). <nothing_done>`.

**Student submission dedupe** (`student_write.py:100-140`):

```sql
CREATE TABLE submission_claim (
  fingerprint TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('active','retained')),
  claim_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- reserve fingerprint; success iff meta.changes = 1
INSERT INTO submission_claim (fingerprint, state, claim_id, expires_at, created_at)
VALUES (?1, 'active', ?2, ?3, ?4)            -- ?3 = now + 330
ON CONFLICT (fingerprint) DO UPDATE
  SET state = 'active', claim_id = excluded.claim_id, expires_at = excluded.expires_at, created_at = excluded.created_at
  WHERE submission_claim.expires_at < ?4;

-- finish: retain for one TTL
UPDATE submission_claim SET state = 'retained', expires_at = ?3 WHERE fingerprint = ?1 AND claim_id = ?2;  -- ?3 = now + 300
-- release: no submission was attempted
DELETE FROM submission_claim WHERE fingerprint = ?1 AND claim_id = ?2;
```

- Order as upstream: fingerprint first, then the nonce claim. If the nonce claim fails, the fingerprint row is released by `claim_id`.
- An `active` row gets a 330 s expiry, so an isolate that dies mid-flight still blocks a resubmit for one TTL, then frees itself.

**Logging and audit.**
- `console.log` of one JSON object per event.
- `sanitizeContext` and `sanitizeUrl` are ported: PII keys become `[REDACTED]`, id keys show the last 4 characters, numeric path segments become `/***`, query stripped.
- Identity appears only as `sha256(key)[:8]`. Email is never logged.
- Event types: `http`, `tool_call`, `data_access`, `security`, `config_error`.

---

## 7. D1 schema, R2 usage, migrations

**Migration 0000 (v1):** `confirm_nonce`, `submission_claim` (both above), plus:

```sql
CREATE TABLE write_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  request_id      TEXT NOT NULL,
  identity_hash   TEXT NOT NULL,
  tool            TEXT NOT NULL,
  effect          TEXT NOT NULL,
  phase           TEXT NOT NULL,     -- preview | confirm | direct | dry_run
  course_id       TEXT,
  target          TEXT,              -- ids only, e.g. "assignment:123"
  outcome         TEXT NOT NULL,     -- ok | rejected | may_have_written | not_dispatched | unconfirmed
  canvas_requests INTEGER NOT NULL
);
CREATE INDEX idx_write_audit_ts ON write_audit (ts);

CREATE TABLE cache_entry (           -- used only when COURSE_CACHE=d1
  scope      TEXT NOT NULL,          -- callerId
  kind       TEXT NOT NULL,          -- 'course_map'
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, kind, key)
);
```

`write_audit` rows older than 90 days are deleted opportunistically.

**Migration 0001 (batch 5):**

```sql
CREATE TABLE export_object (
  id            TEXT PRIMARY KEY,    -- 128-bit random, base64url
  identity_hash TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  kind          TEXT NOT NULL,       -- anonymization_map | peer_review_dataset | course_file
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_export_object_expires ON export_object (expires_at);
```

**Migration 0002 (v2):** section 11.

**Mechanism.**
- `src/store/schema.ts` plus `drizzle-kit generate` produce `drizzle/NNNN_<tag>.sql` and `drizzle/meta/_journal.json`. The build plugin copies them to `dist/.openai/drizzle/**`.
- Runtime uses raw D1 prepared statements; `drizzle-orm` is not bundled.
- Automatic application by Sites is a community claim, so `store/bootstrap.ts` runs the same DDL with `IF NOT EXISTS` on first use per isolate while `DB_BOOTSTRAP=true`.

**R2** (batch 5 only, binding `FILES`).
- Key: `exports/<identity_hash>/<id>/<sanitized filename>`.
- Download: `GET /files/exports/<id>`, served by the Worker with `Content-Disposition: attachment`. Requires the owner's web identity headers. 404 for anyone else.
- Expiry: 24 h. Expired objects are deleted on access and on each new export.
- Uploads stream with `FILES.put(key, response.body)`; nothing is buffered.

---

## 8. Tool plan (all 104)

Tier defaults: S <= 6, M <= 20, L <= 40 requests. Unmarked tools are S and port one-to-one.

**Batch 1: student and shared reads (34)**

- `get_my_profile`, `get_my_enrollments`, `get_my_course_grades`, `get_my_todo_items`, `get_my_submission`, `get_my_upcoming_assignments`
- `list_courses`, `get_course_details`, `get_syllabus`, `list_pages`, `get_page_content`, `get_page_details`, `get_front_page`, `list_module_items`
- `list_assignments`, `get_assignment_details`
- `list_discussion_topics`, `list_announcements`, `get_discussion_topic_details`, `get_discussion_entry_details`
- `list_conversations` (one page plus `more_available`, as upstream), `get_conversation_details` (sends `auto_mark_as_read=false`), `get_unread_count`
- `list_modules`, `get_course_structure` (M; fetch `/modules/{id}/items` for at most 10 modules where Canvas omitted inline items)
- `list_course_files` (M; max 5 pages, then truncation notice suggesting `search_term`)

Medium and hard in batch 1:
- `get_my_submission_status` (L).
  - One course: one paginated assignments call with `include[]=submission`.
  - All courses: one courses call, then per-course assignments in parallel (3), at most 12 courses and 2 pages each (<= 26 requests).
  - Courses beyond the cap are listed by code in the truncation notice.
- `get_my_peer_reviews_todo` (L).
  - Planner feed first (1-2 requests).
  - Direct mode: 2 plus pages.
  - Scan mode: at most 8 courses, assignments once per course (2 pages), at most 10 per-assignment peer-review calls, parallel 3 (<= 30).
  - The remainder goes under upstream's existing "could not check" wording.
- `get_course_content_overview` (M). One `GET /courses/{id}?include[]=syllabus_body` instead of two; pages max 3 pages; modules with inline items; per-module item fetch for at most 10 modules (<= 16).
- `list_group_discussion_topics` (L). Groups max 2 pages; topics for at most 15 groups per call, parallel 3, one page each; optional `cursor` for the rest.
- `list_discussion_entries`, `get_discussion_with_replies` (M).
  - With `include_replies`: one `GET …/discussion_topics/{id}/view?include_new_entries=1`.
  - On 403 (initial post required) or a second 503: fall back to the entries list with per-entry replies for at most 8 entries.
- `read_course_file` (S). REDESIGN:
  - Metadata call, then download with manual redirects.
  - Size clamp `READ_FILE_MAX_SIZE_MB` (5).
  - Text-like types return decoded text, fenced, up to 100,000 chars.
  - Other types return base64 only up to 150 KB.
  - Larger files return metadata and the Canvas page link. The verifier download URL is never returned.
- `search_canvas_tools`. REDESIGN: registry half only. Keeps `schema_version: 2`; the `code_execution_api` section is empty with `available: false`. Docstring count fixed.

**Batch 2: shared and student writes (6)**

- `post_discussion_entry`, `reply_to_discussion_entry`
- `mark_conversations_read` (form-encoded bracket keys, issue 208)
- `comment_on_my_submission`, `mark_module_item_done` (both behind `STUDENT_WRITE_TOOLS` and course policy)
- `submit_assignment` (L). REDESIGN:
  - `file_paths` is removed from the schema.
  - `file_contents`: at most 5 files and `MAX_UPLOAD_MB` total, checked by decoded size before decoding.
  - Bytes go to `FormData` directly.
  - Budget: preview 3; confirm 3 + 1 policy + 3 per file + submit + read-back (<= 21).
  - Uses `confirm_nonce` and `submission_claim`.

**Batch 3: educator reads (24)**

- `list_submissions`, `get_assignment_analytics`, `list_users`, `get_student_analytics` (M; max 10 pages; aggregates labelled partial when truncated)
- `get_rubric` (drops `include[]=assessments`, which upstream never displays), `get_rubric_assessment`, `list_rubrics`
- `get_peer_review_assignments`, `get_peer_review_completion_analytics`, `get_peer_review_comments`, `analyze_peer_review_quality`, `identify_problematic_peer_reviews` (M; peer-reviews endpoint now paginated)
- `fetch_ufixit_report`, `parse_ufixit_violations`, `format_accessibility_summary`
- `get_content_migration_status`
- `get_anonymization_status` (static config report)

Medium and hard in batch 3:
- `list_peer_reviews` (M). One paginated `GET /courses/{c}/assignments/{a}/peer_reviews?include[]=user` replaces one call per submission.
- `check_enrollment` (M).
  - First `GET /courses/{c}/users?search_term=<net_id>&enrollment_type[]=<role>&include[]=enrollments`.
  - If there is no definitive hit, a roster scan capped at 10 pages with anonymization off.
  - A truncated scan answers "indeterminate", never "not enrolled".
- `list_groups` (L). Groups max 2 pages; members for at most 20 groups per call, parallel 3; `cursor` for more. Not verified: whether the groups list honours `include[]=users`. Test it in M4 and switch if it works.
- `scan_course_content_accessibility` (M).
  - Pages listed with `include[]=body` (upstream never scans page bodies).
  - Max 3 pages each for pages and assignments.
  - Per-item cap 200 KB, per-call cap 3 MB, deadline-aware loop with `cursor`.
  - Regexes rewritten without the tempered-dot DOTALL form.
- `generate_peer_review_feedback_report`, `get_peer_review_followup_list` (M). Fetch assignment, peer reviews, roster and submissions once and run both analyses on that data.
- `generate_peer_review_report` (M). REDESIGN: inline output only. `save_to_file=true` returns an error naming `extract_peer_review_dataset`. Effect stays in the table as LOCAL_WRITE for allowlist compatibility, but the tool is registered as a read.

**Batch 4: educator writes (34)**

One-to-one ports:
- `assign_peer_review`, `create_assignment`, `update_assignment` (guarded edit)
- `create_discussion_topic`, `update_discussion_topic`, `create_announcement`
- `grade_with_rubric`, `create_rubric` (strict JSON only), `associate_rubric`
- `create_module`, `update_module`, `add_module_item`, `update_module_item`
- `update_page_settings`, `create_page`, `edit_page_content` (guarded edit, 3 requests)

Confirmation-guarded (D1 store, otherwise unchanged):
- `update_syllabus`, `delete_assignment_with_confirmation`, `delete_announcement_with_confirmation`, `delete_module`, `delete_module_item`, `delete_page`, `update_rubric`
- `send_conversation` (claim/finish with outcome)
- `send_peer_review_inbox_messages`
- `send_peer_review_followup_campaign` (peer reviews paginated; course id resolved)

Redesigned for the budget. The item cap is `min(MAX_BULK_ITEMS, floor((budget - overhead) / cost per item))`. A caller-supplied list over the cap is rejected before any write, with the cap stated.
- `bulk_grade_submissions` (L).
  - Cap 20 grades per call, concurrency at most 3, no sleeps.
  - `max_concurrent` and `rate_limit_delay` are accepted and reported as not applied.
  - On a throttle the batch stops and lists graded, failed and not-attempted ids.
  - `dry_run` behaviour and output text are unchanged.
- `send_bulk_messages_from_list` (L).
  - Cap 20 recipients.
  - The preview renders every message; if it exceeds the output cap, the call errors.
  - Template rendering supports `{key}`, `{{`, `}}`. Any other form is an invalid-record error for that row.
- `bulk_update_pages` (M). Cap 20 slugs, parallel 3.
- `bulk_delete_announcements` (L). `limit` clamped to 18 (two requests per item on confirm).
- `delete_announcements_by_criteria` (L).
  - Listing max 5 pages; a truncated listing refuses to issue a token.
  - `limit` defaults to 15, max 18.
  - `title_regex`: at most 200 chars, nested quantifiers and backreferences rejected, Python-only syntax rejected with a message, titles cut to 300 chars for matching.
  - The token covers exactly the previewed ids.
- `create_rubric_from_csv` (M). At most 3 polls 1.5 s apart, then returns the import id as "still processing"; new optional `import_id` param re-polls. Upstream blocks for 20 s.
- `create_content_migration` (M). Occupancy preview counts each of the 5 lists with max 2 pages and prints "at least N" when truncated (<= 12 requests); confirm 3.
- `fix_accessibility_issues` (L).
  - Pages via `include[]=body` (no per-page GET).
  - At most 15 changed items written per call, with a signed `cursor` for the next chunk.
  - Real PUT failures are reported.
  - `dry_run` default true is kept.

**Batch 5: REDESIGN (4)**

- `upload_course_file`. `file_path` is replaced by `content_base64` plus `filename` (at most `MAX_UPLOAD_MB`), or `source_url` passed to Canvas's upload-by-URL. Three-step upload with the pinned confirm hop.
- `download_course_file`. Streams the file into R2 (at most 25 MB) and returns the owner-gated Site link; `save_directory` removed. Without R2 it returns metadata and the Canvas page link.
- `create_student_anonymization_map`. Roster with anonymization off; CSV with formula-safe cells written to R2. The tool returns only the link and a row count. No real name reaches the model.
- `extract_peer_review_dataset`. `save_locally` now means "store in R2 and return a link", default false. Inline JSON/CSV when under the output cap. One fetch for data and analytics. xlsx removed from the description.

Also in batch 5: the eight skills, reworded. `canvas-week-plan` works on batch 1 alone. Strategy C of `canvas-bulk-grading` is removed.

**DROP (2)**

- `execute_typescript`: needs a subprocess and runs arbitrary code with the caller's token; Workers cannot eval.
- `list_code_api_modules`: only serves `execute_typescript`.

Count: 34 + 6 + 24 + 34 + 4 + 2 = 104.

**Upstream bugs fixed in the port:**
1. Canvas 403 "Rate Limit Exceeded" is not treated as throttling.
2. The course cache is process-global, cross-user, never refreshed and has no TTL.
3. A course identifier with `/` or an unencoded SIS id is interpolated into the path.
4. Upload step 3 sends the token to an unpinned `Location`.
5. Peer-review reads are unpaginated (`core/peer_reviews.py:42`, `core/peer_review_comments.py:74`).
6. `send_conversation`, `send_bulk_messages_from_list` and `send_peer_review_followup_campaign` build `context_code` from an unresolved course code.
7. Duplicate fetches in the peer-review reports and in `get_course_content_overview`.
8. `scan_course_content_accessibility` lists pages without bodies.
9. `fix_accessibility_issues` ignores PUT failures and does N+1 reads.
10. `get_peer_review_followup_list` returns the fake `student@institution.edu`; the field becomes null with a note. `days_threshold` is stated as not applied.
11. `extract_peer_review_dataset` defaults to a mode that fails over HTTP.
12. `create_rubric` falls back to `ast.literal_eval`.
13. The anonymization cache collapses Reviewer/Reviewee/Student prefixes.
14. `list_peer_reviews` and discussion replies fan out per item.
15. Division by zero on a course with no students.
16. `list_users` and `get_student_analytics` accept only string course identifiers.
17. Wrong annotations (section 9).

Not fixed in v1: discussion write tools have no `group_id`.

**Kept byte-for-byte:**
- Tool names, parameter names and defaults (except removed filesystem params).
- Docstring descriptions and output templates.
- Fence markers, `UNTRUSTED_NOTICE`, `FENCE_LEAK_ERROR`.
- Token format, every guard error string, `preview_with_token` wording.
- `unconfirmed_write_warning` wording and guarded-edit messages.
- Course-policy grammar.
- Pseudonym and redaction placeholders.
- `format_date` output.
- `NO_WRITE_STATUSES`.
- CSV cell neutralization.
- `list_conversations` single page.
- Role and `STUDENT_WRITE_TOOLS` gating.

One deliberate difference: error details print as JSON, not Python `repr`; the parity normalizer accounts for it.

---

## 9. Annotation policy

Every tool sets all four hints explicitly. MCP defaults are `destructiveHint: true` and `openWorldHint: true`, so omission is not safe.

| Upstream | Port |
|---|---|
| `read_only_hint=True` | `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false` |
| `destructive_hint=X, idempotent_hint=Y` | `readOnlyHint: false, destructiveHint: X (never lowered), idempotentHint: Y, openWorldHint: false` |
| `openWorldHint` (never set upstream) | `false` on every tool: Canvas is one bounded account |

**Upstream annotations that are wrong, and the port's value:**
1. `send_conversation`, `send_peer_review_inbox_messages`, `send_bulk_messages_from_list`, `send_peer_review_followup_campaign`: `destructive=False`. Sending a message cannot be undone. Port: `destructiveHint: true`.
2. `post_discussion_entry`, `reply_to_discussion_entry`: `destructive=False`. They post to others and trigger notifications. Port: `true`.
3. `comment_on_my_submission`: `destructive=False`. The comment is permanent and visible to the instructor. Port: `true`.
4. `create_announcement`: `destructive=False`. It notifies the whole course and can issue a DELETE as cleanup. Port: `true`.
5. `generate_peer_review_report`: `destructive=True, idempotent=False` only because of the local file. Port: read-only.
6. `extract_peer_review_dataset`: `destructive=True, idempotent=True`. Port: `readOnlyHint: false` (it can write an R2 object), `destructiveHint: false`, `idempotentHint: false`.

Left as upstream:
- `idempotent=False` on plain PUT tools (`update_page_settings`, `bulk_update_pages`, `update_syllabus`). It is inaccurate, but OpenAI does not require the hint.
- `create_page`, `create_rubric`, `associate_rubric`: `destructive=True` (conservative).
- `download_course_file`, `create_student_anonymization_map`: unchanged; they write to R2.

`get_conversation_details` is read-only only because `auto_mark_as_read=false` is sent; a test pins that parameter.

Tests: a snapshot of the full annotation table, and READ effect if and only if `readOnlyHint`, with item 5 as the single listed exception.

---

## 10. Minimal status page

**Routes:**
- `GET /`: HTML, no JavaScript.
- `GET /api/status`: the same data as JSON.
- `POST /api/status/check`: owner only, same-origin `Origin` required. Runs `GET /users/self` and returns ok or the HTTP status.
- `GET /healthz`: `ok`.
- `GET /robots.txt`: disallow all.
- Batch 5 adds `GET /files/exports/<id>`.

**Owner view shows:**
- version, upstream pin, build time
- `AUTH_MODE`, role, MCP path and full endpoint URL
- backend (`sdk`/`native`)
- which required settings are present (names and yes/no only)
- Canvas host
- registered tool count and names by batch
- write allowlist as resolved
- config errors (F1-F9)
- D1 and R2 binding presence and table check
- limits in force
- the owner's own email as seen by the gateway
- result of the on-demand Canvas check

**Everyone else sees** one sentence saying this is a private Canvas MCP deployment. Status 200, no configuration.

**Never shown, to anyone:**
- token or any secret value or derivative
- `CONFIRMATION_SECRET`
- Canvas data (courses, names, grades)
- raw request headers
- other identities
- stack traces
- D1 rows

**Headers:** `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

---

## 11. Single-owner deployment

The historical multi-user seam is removed by the approved 2026-10-03 decision. Each person creates a separate private Site and plugin, using that Site's owner-only Canvas secret. There are no account-linking routes, encrypted user-token tables, OAuth refresh handlers, or per-user credential kinds in the current implementation.

`CredentialProvider` remains a request-scoped boundary with owner authorization repeated inside `resolve`. `AUTH_MODE` may be unset or `owner`; any other value is a configuration error. `PSEUDONYM_SALT` remains optional for single-owner privacy. Historical security concerns about a shared multi-user deployment remain in review-findings.md and are not instructions for enabling it.

## 12. Testing and verification

**Scripts:**
- `npm run typecheck` → `tsc --noEmit`
- `npm test` → `vitest run --project unit`
- `npm run test:workers` → `vitest run --project workers`
- `npm run build` → `vite build && node build/validate-artifact.mjs`
- `npm start` → `wrangler dev --config dist/server/wrangler.json --local --persist-to .wrangler/state`
- `npm run inspect:legacy` → `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --method tools/list --protocol-era legacy` (and `modern`)
- `npm run parity` → `tsx scripts/parity/run-parity.ts`

**Local identity.** `DEV_IDENTITY_EMAIL` is honoured only in a dev build and only for a loopback host. It is compiled out of production builds, and a test asserts the string is absent from `dist/server/index.js`.

**M0: platform spike.**
- Build `hello` and `sites_diagnostics`.
- Run `npm run build`, push, save and deploy privately, publish, install the plugin, then run every probe from ChatGPT.
- Accept: `docs/SPIKE.md` has an answer for Q1-Q20; build variant, `MCP_PATH`, backend, budget and deadline are fixed from them. Q5 must pass before any token is configured.

**M1: core skeleton.**
- Unit: config (port of `UP/tests/core/test_config.py`), link header and pagination (ports of `UP/tests/code_api/pagination-*.test.ts`), encoding, budget, retry and throttle, redirects, dates (`test_dates.py`), anonymization (`test_anonymization_endpoints.py`, `test_anonymization_shapes.py`, `test_ferpa_compliance.py`), fencing (`test_untrusted_content*.py`), tool policy (`test_tool_policy.py`), result contract (`test_tool_results.py`), path injection (`test_path_segment_injection.py`), PII logging (`test_pii_sanitization.py`).
- Integration: an in-process MCP client against `app.fetch` on both backends and both eras.
- Accept:
  - `tools/list` schemas match the snapshot (SDK binding gate).
  - Owner gate matrix passes: no identity, wrong identity, owner, discovery split.
  - No test can make a request leave the pinned origin or carry auth across origins.
  - The artifact imports under Node.

**M2: batch 1.**
- Port `UP/tests/tools/` cases for the 34 tools using `fake-canvas.ts` (route table plus Link headers).
- Add truncation tests (port of `test_truncation_disclosure.py`).
- `npm run test:workers`, then `npm start` with the Inspector in both eras, then deploy.
- Accept:
  - Every tool stays within its tier on a fake 50-subrequest cap.
  - Every truncated path prints the notice.
  - Parity diff against upstream on the owner's account is empty after normalization for all 34 tools except the two redesigns.
  - `canvas-week-plan` works in ChatGPT.

**M3: batch 2.**
- Port `test_confirmation_state_machine.py`, `test_confirmation_claims.py`, `test_student_write_invariants.py`, `test_student_write.py` against `D1NonceStore` in the workers project, with migrations applied by `applyD1Migrations`.
- Add a two-isolate race test: two concurrent confirms, exactly one write.
- Accept:
  - Preview in one isolate confirms in another.
  - Replay, mismatch-burn, expiry and release-on-rejected behave as upstream.
  - With `ALLOWED_WRITE_TOOLS` unset, none of the six tools is listed or callable.

**M4: batch 3.**
- Accept: fan-out tests show `list_peer_reviews`, `check_enrollment`, `list_groups` and the scan within budget on a 300-student fixture. Analytics over truncated data are labelled. Parity run with an educator token if one is available.

**M5: batch 4.**
- Port `test_delete_confirmation.py`, `test_guarded_edits.py`, `test_bulk_grading.py`, `test_messaging.py`, `test_rubric_grading_safety.py`, `test_csv_formula_injection.py`.
- Accept:
  - Every bulk tool rejects over-cap input before the first write.
  - A truncated read never leads to a write.
  - Annotation snapshot matches section 9.
  - Live tests only against a sandbox course.

**M6: batch 5.**
- Add R2 to `hosting.json` and apply migration 0001.
- Accept:
  - Export links 404 for a non-owner.
  - The anonymization-map tool output contains no roster name (asserted against the fixture).
  - Expired objects are removed on access.

**M7: hardening and publish.**
- Full parity report in `docs/PARITY.md`; dependency audit; secrets set; `DIAGNOSTICS_ENABLED=false`; publish.
- Accept: the status page shows no config errors; a forged-header request and a non-owner request are refused in production; logs for a full session contain no token, email or message body.

---

## 13. Risks, ranked by likelihood times impact

1. **Identity headers absent or forgeable on `/mcp`.**
   - Impact: anyone who reaches the endpoint uses the owner's token.
   - Mitigation: Q4/Q5 before any token is set; fail closed.
   - Decision point: if Q5 fails, ship only on a private Site with `ALLOW_PLATFORM_TRUST` and read-only, or wait for a verifiable gateway token.
2. **Sites runtime limits are lower than assumed.**
   - Mitigation: budget, tiers, deadline, `DISABLED_TOOLS`; Q10/Q11 set the numbers.
   - Decision point: under 50 subrequests or ~10 ms CPU, batches 3-4 ship with L-tier tools disabled.
3. **Prompt injection through Canvas content leading to a write or exfiltration.**
   - Mitigation: read-only default, fencing, the write allowlist, confirmation tokens, corrected destructive hints.
   - Residual risk: the model can redeem its own token, so the allowlist is the real boundary.
4. **Builder or Codex rejects or regenerates a plain Worker.**
   - Mitigation: Variants B, C, D; `AGENTS.md`; `src/` has no framework imports.
5. **SDK does not bundle, validate or list schemas as needed.**
   - Mitigation: native backend behind the same `ToolDef`; M1 gate.
6. **ChatGPT tool-call timeout or result-size limit is hit.**
   - Mitigation: 25 s deadline, no sleeps, cursors, 200 KB cap; Q11/Q12.
7. **Too many tools for plugin quality.**
   - Mitigation: `CANVAS_ROLE=student` default (about 34 tools), batches, `DISABLED_TOOLS`; Q13.
8. **Base64 file arguments are impractical from ChatGPT.**
   - Impact: `submit_assignment` uploads and `upload_course_file` may be unusable in practice.
   - Decision point: if M3 shows this, keep text and URL submission and `source_url` upload only.
9. **Student token expiry or admin-disabled tokens.** Student tokens last at most 120 days.
   - Mitigation: status-page check and clear 401 message; v2 OAuth.
10. **Migrations not applied, or secret changes not picked up.**
    - Mitigation: `DB_BOOTSTRAP`; README states that secret changes need a redeploy.
11. **CPU-heavy regex work (accessibility scan, user regex).**
    - Mitigation: linear patterns, size caps, pattern checks, deadline-aware loops.
12. **Canvas throttling during fan-out.**
    - Mitigation: concurrency 3, slowdown on low quota, no write retries.
13. **Unsalted pseudonyms are reversible by brute force.**
    - Mitigation: `PSEUDONYM_SALT`; optional in the single-owner deployment.
14. **Upstream drift.**
    - Mitigation: metadata extraction pinned to v1.13.0; `docs/PORTING.md` lists every deviation.
15. **Site URL change breaks the plugin.**
    - Mitigation: choose the slug before publishing; hosts come from config, not code.

### Critical Files for Implementation
- .upstream/canvas-mcp/src/canvas_mcp/core/client.py
- .upstream/canvas-mcp/src/canvas_mcp/code_api/client.ts
- .upstream/canvas-mcp/src/canvas_mcp/core/write_confirmation.py
- .upstream/canvas-mcp/src/canvas_mcp/core/tool_policy.py
- .upstream/canvas-mcp/src/canvas_mcp/core/anonymization.py