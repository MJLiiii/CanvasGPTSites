> Adversarial review of architecture-detail.md. These findings override the original spec.
> The 2026-10-03 single-owner decision removes the unused multi-user implementation. Multi-user findings below are retained as historical review evidence, not deployment instructions. Use README.md and docs/DEPLOYMENT.md for setup.


# Review: platform

1. **BLOCKER: the deploy pipeline in §2, §12 M0 and the "Variant A default" cannot be run as written.**
   - **Evidence:**
     - Sites has no CLI. Every save and deploy goes through Codex's Sites skill (`sites.py create/initialize/edit/checkpoint`) plus the native `codex_apps` tools. Git credentials stay inside that CLI ("Keep Git operations and source credentials inside the CLI"). The checkpoint step builds, packages, commits and pushes to Sites' own source repo (sites-hosting SKILL.md, https://codex-tool-reference.simonw.chatgpt.site/skills/sites-sites-hosting).
     - REPO's only remote is `git@github.com:MJLiiii/CanvasGPTSites.git`. That is not the Sites source repo, so "push, save and deploy privately" has no mechanism behind it.
     - The `sites_save_site_version` archive "must contain a supported OpenNext or vinext entrypoint and a valid .openai/hosting.json". It also says "for standard Sites/vinext projects, use … scripts/package-site.sh" (tool reference, #tool-mcp-codex-apps-sites-save-site-version).
     - Only two starter shapes are official: vinext (the default) and `--starter worker`. The worker starter is buildless, "deploys only `worker/index.js` and the hosting manifest", "without introducing Vite". OpenAI's own Data Analytics exporter uses it with D1 `DB` (sites-building SKILL.md; data-analytics publish-artifact-to-sites SKILL.md).
     - Variant A (Vite plus `@cloudflare/vite-plugin` without vinext) is neither shape. The stated reason, "the bundler every Sites starter uses", is false for the worker starter.
     - The only plain-esbuild Worker in the set, zimbra-mcp (`scripts/build.mjs:6-7`), does not copy hosting.json into `dist/.openai`. Its README L68 says the live plugin connection is still unvalidated, so it is not ground truth.
     - The established fact that the Codex starter's `build/sites-worker.ts` routes `/mcp` is wrong. The generated file (jroth1111 `build/sites-worker.ts:1-27`, identical in fishboard) only wraps vinext in an AsyncLocalStorage that carries CONNECTORS. jroth1111 serves `/mcp` from `app/mcp/route.ts:1-6`. Only ts-76 added a path switch (`build/sites-worker.ts:5-11`).
     - The skill does support adopting hand-written source: "For a Site template, pass the absolute retained `assets/source` directory as `--starter`; the template source itself is the starter … preserves the package manager, lockfile, architecture". It also says "Preserve each starter's build script". In managed-linux, `build` runs `vinext build` under a 3-minute `timeout` (jroth1111 `scripts/build-verified.sh`). `install:ci` is "the Linux Sites-build installer" (j-256 README L120).
   - **Change:**
     - Add an M0 step 0. In Codex (Work or desktop), create two throwaway owner-only Sites, one `--starter worker` and one default vinext with "add an MCP server". Record the generated files, scripts, build output, hosting.json changes and `/mcp` wiring in `docs/SPIKE.md`.
     - Make the default production shape the vinext starter checkout:
       - keep its `sites()` plugin, its scripts (`build` via `run-framework`/`build-verified`, `install:ci`, `start`) and the ALS wrapper in `build/sites-worker.ts`;
       - add the ts-76-style path switch (`/mcp`, `/api/*`, `/`, `/files/*` → `createApp().fetch`) inside that file, not as a new `entry/vinext/sites-worker.ts` main;
       - run the artifact validator as an extra script, not as a replacement `build`.
     - Fallback is the worker starter (Variant D), shaped to whatever step 0 captures. Use Variants A and B only as a local test harness.
     - Specify the loop: develop in REPO, then Codex `sites.py edit` → merge from GitHub into the Site checkout → `checkpoint` → `sites_save_site_version` → `sites_deploy_private_site_version` → `sites_get_deployment_status`. Alternatively create the Site with `--starter /abs/path/REPO`.
     - Keep the build under 3 minutes.

2. **MAJOR: "MCP layer: createMcpHandler in JSON response mode" does not give JSON to 2025-era clients.**
   - **Evidence:**
     - `responseMode` is documented as "Response shaping for modern (2026-07-28) request exchanges" (server 2.2.0 `CreateMcpHandlerOptions`).
     - The legacy leg builds `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, … })` with no `enableJsonResponse` (`packages/server/src/server/createMcpHandler.ts` v2.2.0 L339-343). Its comment reads "the legacy transport answers request-bearing POSTs over SSE" (≈L358-368). `enableJsonResponse` defaults to false (`streamableHttp.ts` L120, L281).
     - Both evidenced Sites servers return only `application/json` (jroth1111 `lib/mcp-handler.mjs:28,36-39`; zimbra `src/worker.js:5-7`). SSE through the Sites gateway: NOT FOUND.
     - The factory receives only `{era, authInfo, requestInfo}`, with no `env`. Building the handler per request also fires the `responseMode:'json'` `console.warn` on every request (`createMcpHandler.ts` L708-714).
   - **Change:**
     - Create the handler once at module scope: `createMcpHandler(factory, { legacy: 'reject', responseMode: 'json' })`.
     - In front of it, `if (await isLegacyRequest(req))`: serve the request with a fresh `McpServer` connected to `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`. Both are exported from `@modelcontextprotocol/server` 2.2.0, and `isLegacyRequest` reads a clone, so the body stays readable.
     - Pass `RequestContext` as `handler.fetch(req, { authInfo: { token: '', clientId: identity.key, scopes: [], extra: { rc } } })`. `AuthInfo.extra` exists. Never put the Canvas token in `authInfo`.
     - M1 test: `content-type: application/json` in both eras.
     - The native fallback should be legacy-only JSON mirroring jroth1111 (2025-11-25, 2025-06-18, 2025-03-26; 202 for notifications; 405 for GET/DELETE). A modern client falls back to `initialize` on a 400 (spec 2026-07-28 streamable-http "Backward Compatibility").

3. **MAJOR: Q5/Q18 (forged identity) is untestable as written and misses the real attack path.**
   - **Evidence:**
     - ChatGPT cannot be made to send forged headers.
     - The only way to reach the Worker with self-chosen headers is the SIWC bypass token: "bypasses a site's Sign in with ChatGPT gate". It cannot be revoked; it can only be rotated ("creates a token if none exists, or rotates") (tool reference, #tool-mcp-codex-apps-sites-generate-siwc-bypass-token).
     - Q18 proposes using that token for Inspector.
     - `Headers.get` comma-joins duplicate headers, so a gateway that appends instead of replacing yields `forged, real`.
   - **Change:**
     - Define Q5 concretely. Send a bypass-token request to `/mcp` carrying forged `oai-authenticated-user-email: <owner>` and `oai-authenticated-user-id`. Separately, send a signed-in owner-browser `fetch('/mcp')` with the same custom headers. Pass only if the Worker sees the headers absent or overwritten.
     - Record whether `oai-sites-authorization` itself reaches the Worker. If it does, treat any request that carries it as identity-less whatever the `oai-*` headers say.
     - Reject identity values containing `,` or control characters (fail closed).
     - Generate a bypass token only for this test. Drop production Inspector use except discovery-only.

4. **MAJOR: owner-only Site audience is not required in the design, though it is the strongest and cheapest gate.**
   - **Evidence:**
     - `sites_deploy_private_site_version` runs "only when verified owner-only access makes the current caller the sole explicitly allowed viewer and allows no groups". The checkpoint "selects private deployment" for owner-only Sites without asking again.
     - Help 20001547: "Recipients need access to both the plugin and its Site".
     - zimbra README L33 says to deploy owner-only.
     - j-256 `worker/index.ts:12-16` relies on the audience policy.
     - The design mentions a "private Site" only in the Q5 failure branch.
   - **Change:**
     - v1 requires `access_mode=custom` with only the owner, checked via `sites_get_site` before each deploy. Always deploy with `deploy_private_site_version`. The app owner gate stays as defence in depth.
     - Set `CANVAS_API_TOKEN` (`is_secret`) only in Site Settings, never through Codex chat or `update_environment_variables` arguments, which would put it in the transcript (zimbra README L34-35).

5. **MAJOR: the build would package local secrets.**
   - **Evidence:**
     - Cloudflare docs (workers/vite-plugin/reference/secrets): "The `vite build` command copies the relevant `.dev.vars` file to the output directory."
     - The Sites checkpoint uploads "the successful local build output" as the archive.
     - The design ships `.dev.vars.example` and runs the parity and live tests with the owner's token, under both Variant A and C (the plugin is used by both).
   - **Change:**
     - Never put real tokens in `.dev.vars` or `.env`. Parity and live tests read process env or an untracked `.parity.env` used only by `scripts/parity`.
     - In `closeBundle`, delete `dist/**/.dev.vars*` and `dist/**/.env*`.
     - `validate-artifact` fails if either exists, or if any dist file matches a Canvas-token pattern (`\d+~[A-Za-z0-9]{40,}`).

6. **MAJOR: §5 says "D1 and R2 calls are not counted" in the budget; they are subrequests.**
   - **Evidence:**
     - Cloudflare limits §Subrequests: "any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1"; "Each subrequest in a redirect chain counts".
     - Under Workers for Platforms custom limits, "the user Worker will immediately throw an exception". The dispatcher sets `cpuMs`/`subRequests`, so hitting the cap mid-write gives an uncatchable or ambiguous may-have-written outcome.
     - Self-fetch to the same zone fails ("Using global fetch() to call another Worker on the same zone without service bindings fails").
   - **Change:**
     - Use one `RequestBudget` covering fetch, D1, R2 and `waitUntil` audit and purge.
     - Reserve the confirm-claim, spend and audit slots before the first Canvas write. Collapse statements with `DB.batch()`.
     - Q10 probe: count fetch and D1 separately against a non-Site host (e.g. an unauthenticated Canvas `/api/v1/users/self`) and catch the throw. Read CPU-limit kills from `sites_get_site_worker_logs`, because the tool cannot report them itself.

7. **MINOR: `DB_BOOTSTRAP` can break platform migrations.**
   - **Evidence:**
     - j-256 README L110 ("Treat committed migrations as immutable history") and L112 ("Sites applies the packaged history before the new version receives traffic").
     - drizzle-kit emits plain `CREATE TABLE`. If bootstrap ever creates tables before the platform records the migration, migration 0000 fails and the deploy fails.
   - **Change:**
     - Write migrations with `CREATE TABLE/INDEX IF NOT EXISTS`.
     - Bootstrap executes the packaged `drizzle/*.sql` files embedded at build time, never separate DDL.
     - Evolve the schema only through new migrations, and remove bootstrap once Q14 passes.

8. **MINOR: the identity key and `OWNER_USER_ID` gate.**
   - **Evidence:**
     - openai/sites PR #29: "ChatGPT Work guarantees the authenticated email header but does not require the per-Site user ID".
     - One report says MCP hosting worked only in Work (x.com/hAru_mAki_ch/status/2105606303049728270).
     - zimbra README L45 says the user id is Site-scoped.
     - The diagnostics return only `sha256[:8]`, and the status page shows only the email, so the owner can never learn the raw `OWNER_USER_ID`.
   - **Change:**
     - `OWNER_EMAIL` is required.
     - Replace `OWNER_USER_ID` with `OWNER_USER_ID_SHA256`, enforced only when the id header is present. The diagnostics print the full SHA-256 of the id.
     - In v1 key D1 rows by `email:`, or store both forms.
     - Add "Chat vs Work surface" to the spike.

9. **MINOR: the SDK binding gate (§3) can be settled now.**
   - **Evidence:**
     - The SDK calls `~standard.jsonSchema.input({target:'draft-2020-12'})`, defaults the root to `type:object` and throws on a non-object root (`core-internal/src/util/standardSchema.ts` L183-234).
     - When `validate` fails, the SDK returns its own text: "Input validation error: Invalid arguments for tool X: …" (`mcp.ts` L326-330).
     - `fromJsonSchema()` validates strictly with cfworker.
     - Text is auto-appended only for non-object `structuredContent` (`wire/textFallback.ts`), so the design's text plus object output is not duplicated.
     - The Codex vinext starter pins `zod ^3.25.76` (jroth1111 `package.json:42`).
   - **Change:**
     - Hand-build a `StandardSchemaWithJSON` per tool with a permissive `validate` (`v => ({ value: v ?? {} })`) and do the lenient coercion in `runTool`, so upstream `{"error": …}` strings survive.
     - Do not use `fromJsonSchema`.
     - Drop the direct `zod ^4.5` dependency; the SDK brings its own zod `^4.2`.

10. **MINOR: the reasoning behind disagreement #2 ("do not rely on nodejs_compat").**
    - **Evidence:**
      - The generated starter imports `node:async_hooks` at the Worker entry (jroth1111 `lib/connector-context.ts:1`), so Sites already runs vinext-starter Workers with Node compatibility.
      - The published server 2.2.0 `./_shims` export order is workerd, browser, node, default. The workerd and browser shims use the CfWorker validator and have no `node:` imports.
      - Variant B's `external:['node:*']` would defer a stray Node import to a runtime crash.
    - **Change:** keep `@noble/hashes`. In any esbuild path make `node:*` a build error rather than an external. Also smoke-test the artifact under workerd, not only Node `import()`.

11. **MINOR: skills (batch 5 / Q20).**
    - **Evidence:**
      - developers.openai.com/plugins/build/mcp-server.md: skills come from SEP-2640, which needs the `io.modelcontextprotocol/skills` capability, `skills/list`, `skills/get` and `resources/read` for every file.
      - "The importer accepts up to five uniquely named skills".
      - The import happens at "Scan Tools" during submission; whether it happens for an auto-created Site plugin is unknown.
    - **Change:**
      - Rephrase Q20 accordingly.
      - Merge the 8 skills into at most 5.
      - Plan for `resources/read` (the "resources deferred" decision must flip).
      - Verify that SDK v2 has a skills API; otherwise use low-level request handlers or the native backend.

12. **MINOR: Worker-originated 401 on `/mcp` (§3 step 7).**
    - **Evidence:**
      - The gateway owns OAuth (jroth1111 README L109; zimbra README L37).
      - Under MCP auth, a 401 starts the client's authorization discovery.
    - **Change:** answer app-level denials with JSON-RPC -32001 at HTTP 200 or 403, never 401 or `WWW-Authenticate`. Observe the behaviour in M0.

13. **MINOR: local dev and test commands (§12).**
    - **Evidence:**
      - `wrangler dev` passes headers through unchanged.
      - The official `sites()` plugin strips `oai-authenticated-user-*` and injects `local_seedy`/`seedy@sites.test` via the `__sites_local_auth=1` cookie under `vite dev` (openai/sites `packages/sites-vite-plugin/src/index.ts:44-121,168-184`).
      - Inspector URL targets use `--transport http` and `--header`, and it offers `--strict` (inspector `clients/cli/README.md:74,80,125`).
      - `dist/server/wrangler.json` exists only for Vite builds.
      - `cloudflareTest` needs a wrangler config file.
    - **Change:**
      - Drop `DEV_IDENTITY_EMAIL`. Pass the identity headers with Inspector `--header`, and use the vendored `sites()` plugin instead of a custom `sitesPackage`.
      - Add `--transport http --strict` to the inspect scripts.
      - Keep a test-only wrangler config under `test/`, not at the repo root; the Sites starters commit none.

14. **MINOR: missing spike questions.**
    - **Evidence:** help 20001547: "New or changed tools are missing: Confirm that the owner published the updated Site and that the owner's connection is active". `shimsWorkerd.ts` runs `preloadSchemas()` at module scope. Cloudflare has a 1 s startup limit.
    - **Change:** add to Q1-Q20:
      - Do `mcp-protocol-version`, `mcp-method`, `mcp-name`, `accept` and `content-type` arrive intact, and does ChatGPT probe `server/discover` first?
      - Which `ctx.props` keys arrive?
      - Does changing `ALLOWED_WRITE_TOOLS` plus a redeploy refresh the plugin's tool snapshot? A stale snapshot calls unregistered tools (→ -32602) or hides new ones.
      - Bundle size and cold-start time with SDK `preloadSchemas()` plus 104 schemas.
      - Is each variant's archive accepted?

**Three changes that matter most:**
1. Rebuild M0 and deployment around the Codex Sites lifecycle and an official starter shape, not Variant A:
   - capture both starters first;
   - default to the vinext checkout with a path switch inside its `build/sites-worker.ts`, keeping its scripts and plugin; fall back to the worker starter;
   - use an owner-only Site with `deploy_private_site_version`;
   - set secrets only in Site Settings.
2. Return plain JSON in both protocol eras: `legacy:'reject'` plus `isLegacyRequest` routing to an `enableJsonResponse:true` transport, a module-scope handler, and context passed via `authInfo.extra`. The native fallback is legacy-only JSON mirroring jroth1111.
3. Close the credential-exposure paths before any token is configured:
   - test Q5 on the bypass-token path with forged and duplicated `oai-*` headers, and refuse any request that carries `oai-sites-authorization`;
   - keep `.dev.vars`/`.env` out of `dist`;
   - count D1/R2 calls in the budget, since dispatcher limits throw instead of truncating.

# Review: security

**Security and privacy review of the canvas-mcp → ChatGPT Sites design**

Paths:
- `UP` = `.upstream/canvas-mcp`
- `SR` = `<local-reference-path>` (Sites runtime report)

---

**1. BLOCKER: the endpoint check misses encoded `..`, so paths can be retargeted and anonymization skipped (§5 Request shape, §6 Anonymization tier, §1 "requestUrl lifted unchanged")**

Evidence:
- Upstream refuses only a literal `..` segment (`UP/src/canvas_mcp/core/client.py:455`). The lifted helper builds the URL with ``new URL(`${cfg.apiUrl}${endpoint}`)`` (`UP/src/canvas_mcp/code_api/client.ts:73-74`).
- The WHATWG URL parser resolves encoded dot segments. Checked in node:
  - `/api/v1/courses/1/pages/%2e%2e/assignments/5` becomes `/api/v1/courses/1/assignments/5`.
  - `.../submissions/self/%2e%2e/456` becomes `.../submissions/456`.
- Upstream puts raw page slugs into PUT and DELETE paths (`UP/src/canvas_mcp/tools/pages.py:66,192,475,541`; `courses.py:655,703`; `accessibility.py:81,338`).
- Only 7 call sites in `tools/` use `coerce_canvas_id`, so most string ids are not digit-checked either.
- The anonymization tier is computed from the template string, and it removes a `submissions/self` segment before matching (`client.py:259-293`).

Exploits:
- `delete_page(page_url_or_id="%2e%2e/assignments/5")`: the preview GETs the assignment, then the confirm DELETEs it.
- A slug like `x/%2e%2e/%2e%2e/assignments/2/submissions/self/%2e%2e/456` fetches another student's submission. The template is classified as IDENTITY, so the free-text and submission-content redactions are skipped.
- This works in read-only mode, through a prompt-injected slug.

Change:
- Build every path with a `canvasPath` tagged template that applies `encodeURIComponent` to each interpolated value and rejects `""`, `.` and `..`.
- After building the URL, require `url.pathname === apiBasePath + builtPath`. Anything else is `not_dispatched`.
- Compute the anonymization tier from the final `url.pathname`, not the template.
- Apply `coerceCanvasId` to every `kind:'id'` value that lands in a path.
- Add `%2e`, `.%2E`, `%2f` and `%5c` cases to the port of `test_path_segment_injection.py`.

---

**2. BLOCKER: `ALLOW_PLATFORM_TRUST` treats "no identity headers" as "the owner" (§4 config, F7, Q5 fallback, Risk 1)**

Evidence:
- The SIWC bypass token exists for "identity-less API requests that bypass a site's Sign in with ChatGPT gate" (SR:230-232). The design's own Q18 plans to mint one.
- How `/mcp` behaves on a Site with no sign-in is not documented anywhere (SR:226).
- Upstream's `MCP_ALLOW_UNAUTHENTICATED` was safe only because every caller still sent their own Canvas token (`UP/deploy/azure/README.md:35-38,353`). Here the switch would hand out the owner's token.
- "Read-only" still exposes grades, the inbox and rosters.

Change:
- Delete `ALLOW_PLATFORM_TRUST`.
- If Q5 fails, the only acceptable alternative is positive proof: a forwarded `Authorization` JWT verified against the issuer's JWKS, with `aud == mcp_connection.oauth_resource`, a valid `exp`, and `sub`/email equal to the configured owner. Otherwise do not deploy the token.
- Rotate the bypass token after Q18 testing.

---

**3. MAJOR: the owner check happens in one place and depends on parsing the request body (§3 steps 5-7, 10.2; `CredentialProvider`)**

Problems:
- `resolve(identity)` returns the owner credential without re-running `authorize`.
- The discovery/invocation split comes from the body `method`, while 2026-07-28 clients also send an `Mcp-Method` header. That is a parser difference, and it matters as soon as `DISCOVERY_REQUIRES_OWNER=false`.
- "OWNER_USER_ID, if set, must also match" does not say what happens when the header is missing. ChatGPT Work may omit the user id (SR:213).
- "Percent-decoded when the encoding header says so" could end up applied to the id or email.

Change:
- `OwnerSecretProvider.resolve()` calls `authorize()` itself and is the only code that releases the token. `runTool` checks again.
- Treat a request as discovery only if the body method and the `Mcp-Method` header (when present) both name a discovery method.
- Reject JSON-RPC batches.
- A configured identifier with a missing header means deny.
- Compare raw header values exactly. Lowercase only ASCII email and reject any value that is non-ASCII or contains a comma or whitespace (`Headers.get` joins duplicates with ", "). Percent-decode only the full name.
- Never use `_meta["openai/subject"]` for identity.

---

**4. MAJOR: the Q5 spike test cannot prove the header gate is safe as written ("forge one and compare hashes")**

A gateway that only overwrites the headers when it has an identity would pass forged values on identity-less paths. ChatGPT itself cannot send custom headers.

Change: Q5 passes only if forged `oai-authenticated-*` headers are dropped or overwritten in every one of these cases:
- an unauthenticated direct POST;
- a bypass-token request;
- an authenticated non-owner;
- case and underscore variants, and duplicate headers;
- a forged `-full-name-encoding` header;
- the web routes `/`, `/api/status/check` and `/files/exports/*`, because Q19 trusts those too.

Also record which header actually carries the owner, since in Work mode email is the de facto gate.

---

**5. MAJOR: every tool handler can reach the secrets, and the redaction pass covers too little (`RequestContext.env`, `ToolContext.credential.token`, step 11 redaction, F-rule error detail)**

Evidence:
- `env` holds `CANVAS_API_TOKEN`, `CONFIRMATION_SECRET`, `PSEUDONYM_SALT` and historical proposed v2 encryption/OAuth secrets (not implemented). The redaction pass scrubs only the token, and only in text output.
- F3 "detail goes to logs and the owner status view". An owner who pastes the token into `CANVAS_API_URL` would see it echoed.
- Upstream logs only the exception type, never its message (`client.py:622-628`). V8 `JSON.parse` errors include a snippet of the body.

Change:
- Remove `env` and `credential` from the tool context. The `CanvasClient` holds the token in a closure or `#private` field. Tools see only `{origin, callerId, kind}`.
- Redact every secret-class value, raw and URL-encoded, from text, `structuredContent`, errors and log lines.
- Config errors never echo the values of secret-class variables: print scheme and host, or "unparseable (len N)".
- Log `error.name` plus a sanitized message.

---

**6. MAJOR: R2 exports undo an upstream privacy rule and open a same-origin path to `/mcp` (§7 R2, batch 5, §3 step 4 Origin rule)**

Evidence:
- Upstream refuses to persist remote PII over HTTP: "must not persist remote PII" (`UP/tests/security/test_local_export_host_boundary.py`).
- The 24 h TTL is not enforceable: there is no cron, and deletion happens only "on access and on each new export". A real-name roster map can therefore sit in R2 indefinitely.
- `download_course_file` serves Canvas-sourced bytes (student HTML/SVG) from the Site origin, and `/mcp` accepts `Origin == Site origin`. If the gateway honours cookie sessions on `/mcp` (unknown), script on the Site origin becomes an MCP client.

Change:
- Put batch 5 behind `EXPORTS_ENABLED=false`, and forbid anonymization maps in per-user mode.
- Encrypt each object under a random key stored only in its D1 row, and purge expired rows on every request. Deleting the key enforces the TTL without cron. Make downloads single-use.
- Serve files as `application/octet-stream` with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'`.
- On `/mcp`, reject any request carrying `Origin` or `Sec-Fetch-*` (the connector calls server-to-server), and require `Content-Type: application/json`.
- If Q19 shows that web requests lack identity, never fall back to bearer "capability" links (they end up in shared ChatGPT conversations). Keep those tools unregistered instead.

---

**7. MAJOR: some notifying tools still say `destructiveHint:false` (§9)**

Evidence:
- `create_discussion_topic` is `destructive_hint=False` (`UP/src/canvas_mcp/tools/discussions.py:1196`), yet its docstring says the topic is "always created published" and unpublishing "does not undo that initial visibility". That is the same rationale §9 used to fix `create_announcement`.
- Also wrong: `assign_peer_review` (`assignments.py:155`, notifies the reviewer) and `create_assignment` when `published=true` (`assignments.py:676`).
- These tools have no confirmation token. ChatGPT's confirmation prompt, which is driven by these hints, is the only human step between an injected instruction and a course-wide post.

Change:
- Set `destructiveHint:true` on these three tools.
- Add a test that every write that can notify other users is marked destructive.
- In the README, tell the owner never to "always allow" destructive tools, because the model can redeem its own confirmation token (`write_confirmation.py:19-26`).

---

**8. Historical, removed from current scope: the multi-user seam (§11) is unsafe if switched on as designed**

- (a) `ALLOWED_WRITE_TOOLS`, `STUDENT_WRITE_TOOLS` and `CANVAS_ROLE` apply to the whole Site, so every linked user inherits the owner's write tools. Add a per-identity policy that defaults to none, with the Site setting as a ceiling.
- (b) `computeToolSet` is memoized by config only, so one user's tool set could be served to another. Key the memo by identity attributes, and emit `cacheScope: private` on `tools/list` when the list varies.
- (c) The `Identity.key` fallback from id to email must be a deploy-time constant, never decided per request. Refuse per-user mode when the user id is absent: email-keyed credentials follow an email when it is reassigned.
- (d) `callerId = HMAC(token)` changes hourly with Canvas OAuth. Bind fingerprints and caches to `HMAC(identity.key | canvas_origin | canvas_user_id)` instead.
- (e) `canvas_origin` must come from a configured allowlist (upstream "SSRF elimination", `UP/deploy/azure/README.md` §5.1).
- (f) Drop `kind 'pat'`, or restrict it to the owner identity.
- (g) Authorize exports and cache rows on the full identity key, not the truncated `identity_hash`.
- (h) `return_to` must be a relative path. `/canvas/unlink` and `/canvas/oauth/start` must be same-origin POSTs.
- (i) Extend F2: per-user mode also refuses `OWNER_GATE=observe`, `DIAGNOSTICS_ENABLED`, and an unset `PSEUDONYM_SALT`.

---

**9. MINOR: the D1 confirmation guard is essentially equivalent to upstream; four gaps remain (§6 Confirmation guard, submission dedupe)**

Mapping to upstream's state machine:
- INSERT claim = `reserve`.
- `spent` = `finish` with an outcome that may have written (`_claims=None`).
- DELETE by `claim_id` with `state='claimed'` = `finish` with `NOT_DISPATCHED`/`REJECTED`.
- The burn upsert = `_burned`, and a burned row blocks release.
- Stale or foreign handles cannot release.
- Bulk-message "reserve on any check error" (`UP/src/canvas_mcp/tools/messaging.py:884-888`) amounts to burning only an authentic, unexpired token, so it is covered.

Gaps:
- **(a) Clock.** Upstream uses a clock that cannot roll back and notes that dropping an unexpired claim resurrects the token (`write_confirmation.py:105-111,231-236`). With per-isolate `Date.now()`, more than 60 s of skew between machines reopens a replay window. Let D1's clock decide both validity and purge:
  - `INSERT ... SELECT ?1,?2,'claimed',?3,?4,unixepoch() WHERE ?4 >= unixepoch() ON CONFLICT DO NOTHING`
  - `DELETE ... WHERE expires_at < unixepoch()-60`
- **(b) Submission rows can expire mid-flight.** Upstream's active submission claims never expire while their owner is still waiting on I/O (`UP/src/canvas_mcp/tools/student_write.py:104,113-118`); here they expire at 330 s. Assert at config parse that the worst-case runtime (deadline plus fetch timeout) is under 300 s, and abort every fetch at the deadline.
- **(c) Release handles.** The nine delete guards must not expose any release handle (`write_confirmation.py:334-337`). Only the legacy `release(token)` callers (`messaging.py:786,907`; `student_write.py:140`) get `claim_id` handles.
- **(d) Retries.** Never retry the claim INSERT.

---

**10. MINOR: any tool can turn anonymization off**

`skipAnonymization` is open to every tool, while upstream uses it only in `admin_tools.py:333` and `core/enrollment.py:325`. Make raw access a capability granted only to `check_enrollment` and `create_student_anonymization_map`, with a test that pins that set. The new `search_term` path in `check_enrollment` must also run raw and output only the yes/no answer.

---

**11. MINOR: Python and JS regexes differ on Unicode digits**

`UP/src/canvas_mcp/core/anonymization.py:173-175` uses `\d` and `\b`. In Python 3 these match Unicode digits; in JS they are ASCII-only, so full-width or Arabic-Indic SSNs and phone numbers would pass unredacted. Use `\p{Nd}` with the `u` flag and explicit lookarounds, and add parity tests.

---

**12. MINOR: truncation and fencing coverage**

- Cutting output at `MAX_TOOL_RESULT_BYTES` can leave a block fence open. Close it with `FENCE_TEXT_END` before the notice.
- Every tool that returns Canvas-authored text needs a fencing classification, not only READ tools. The upstream registry includes local-write tools (`UP/src/canvas_mcp/core/untrusted_content.py:64-65,72`).
- Label the base64 output of `read_course_file`.

---

**13. MINOR: new outbound paths**

- `upload_course_file(source_url)` makes Canvas fetch any URL. That is an exfiltration channel through the query string, and an open-world action. Drop it, or require https with no query string, show the URL in a confirmation preview, and set `openWorldHint:true`.
- File downloads: once a redirect leaves the Canvas origin, never re-attach auth, even if a later `Location` returns to Canvas.

---

**14. MINOR: `title_regex` is still open to polynomial ReDoS**

Rejecting nested quantifiers and backreferences does not stop patterns like `.*.*.*.*.*x` over a 300-character title. Workers have no regex timeout. Allow only a linear subset (escaped text plus `*`/`?` globbing).

---

**15. MINOR: the body is read before the identity gate (§3 step 5)**

Anonymous callers can make the Worker buffer up to 8 MB, and chunked bodies have no `Content-Length`. Run the identity check from headers first, cap anonymous or non-owner bodies at 64 KB, and count bytes while streaming (as in upstream `test_public_route_limits.py`).

---

**16. MINOR: operational hygiene**

- `sites_diagnostics(subrequests)` must hit a fixed URL and never send credentials.
- Allow `observe` only in owner mode with no token and no `CONFIRMATION_SECRET`.
- Log identity as an HMAC, not as unsalted `sha256[:8]`.
- Non-secret Site variables come back in plaintext through `update_environment_variables`. Set the token and other secrets in the Site settings UI with is_secret, never via Codex chat.
- Gitignore `.dev.vars` and `.wrangler/`.
- Bind cursors to `callerId` and an expiry, sign them with a separate key label, and validate them against the normalized path.

---

**The three changes that matter most:**
1. Encode every path segment, require that the parsed pathname equals the built path, and compute anonymization tiers from the final URL. This closes `%2e%2e` retargeting of DELETE/PUT and the anonymization bypass (finding 1).
2. Remove `ALLOW_PLATFORM_TRUST`. Make `CredentialProvider.resolve()` the single, self-checking point where the owner token is released, and let the Q5 matrix (bypass-token path, duplicate and variant headers, web routes) or a verified gateway JWT decide whether the token is ever deployed (findings 2-4).
3. Take secrets out of the tool context, broaden redaction, and keep R2 exports off, encrypted and crypto-shredded, with `/mcp` rejecting any browser-originated request (findings 5-6).

# Review: coverage

**Completeness check:** it passes. `TOOL_MANIFEST.json`, `TOOL_EFFECTS` and the design's batches each hold the same 104 names. No name is missing, duplicated or invented. Batch 1 is exactly the 34 reads registered for `CANVAS_ROLE=student`. Batch 3 is the 23 educator-only reads plus `generate_peer_review_report`. Batch 5 holds 3 LOCAL_WRITE tools and `upload_course_file`. DROP holds `execute_typescript` and `list_code_api_modules`.

1. **BLOCKER: two redesigns send real student names to the model.**
   - Design part: §8 batch 3. `list_peer_reviews` uses one GET `…/peer_reviews?include[]=user` "replaces one call per submission". `list_groups` will "switch if [include[]=users] works". §6 says tier selection is a line-for-line port.
   - Evidence: `UP/src/canvas_mcp/core/client.py:213-262`. FULL anonymization applies only to `users`, `submissions`, `enrollments`, `analytics` and discussion entries/view. Paths `…/assignments/{a}/peer_reviews` and `/courses/{c}/groups` fall to NONE.
   - `UP/tests/security/test_anonymization_endpoints.py:63-65` pins `/courses/123/groups` as not anonymized.
   - Upstream takes names only from the FULL-tier `/courses/{c}/users` roster: `UP/src/canvas_mcp/tools/assignments.py:255-266`, and `UP/src/canvas_mcp/core/peer_review_comments.py:88-95`, even where it requests `include[]=user,assessor` (`:74-77`).
   - Canvas Group docs: `users` is "Returned only if include[]=users. WARNING: this collection's size is capped".
   - Change for `list_peer_reviews`: one GET of the peer_reviews endpoint without `include`, plus the FULL-tier roster. That is 1+ceil(N/100) requests, so 4-5 for 300 students. Never read `user` or `assessor` from embedded objects.
   - Change for `list_groups`: if `include[]=users` is used, add an explicit `RequestOptions.tier:'full'` (the tier code only sees the path, not params). Flag truncation when `users.length < members_count`. Add FERPA tests for both.

2. **MAJOR: `get_my_peer_reviews_todo` scans an endpoint that can never return a student's own review tasks.**
   - Design part: §8 batch 1. Scan mode is capped at "<= 30" requests and direct mode is "2 plus pages".
   - Evidence: the canvas-lms `PeerReviewsApiController#index` source says: unless the caller can `:grade`, `assessment_requests.for_assessee @current_user.id`. In `AssessmentRequest`, `scope :for_assessee, ->(user_id) { where(user_id:) }` is the assessee.
   - Upstream then keeps only `assessor_id == my_id` (`UP/src/canvas_mcp/tools/student_tools.py`, direct and scan branches). A student therefore never matches.
   - Result: direct mode always says "No pending peer review found for you", which is a false negative. Every scan request is wasted. Upstream issue #275 notes the scan "reportedly misses reviews".
   - Change: make Planner (`filter=incomplete_items`, `assessment_request`) the only source when the caller has no grade rights.
   - In direct mode, filter Planner items by the assignment id in `html_url` (`/assignments/<id>/`).
   - Run the scan only for grader roles. Never print "none found" based on the scan alone. Budget becomes about 4-5 requests.

3. **MAJOR: the request budget leaves out D1 and R2 calls, but the platform counts them.**
   - Design part: §5 Budget says "D1 and R2 calls are not counted, but are capped at 20 per call". Q10 rule: "if < 50, set budget to cap minus 10".
   - Evidence: developers.cloudflare.com/workers/platform/limits: "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1." The Workers for Platforms custom-limits page: "the user Worker will immediately throw an exception."
   - Worst cases: `delete_announcements_by_criteria` is 40 Canvas calls plus about 6 D1 calls (bootstrap, claim, spend, audit, purge). `submit_assignment` confirm is 21 plus about 8. On a 50 cap the design overruns, and the throw can land after the Canvas write.
   - Change: one `SubrequestMeter` covering fetch, D1 and R2 (a D1 `batch()` counts as 1). Reserve D1 slots before the first Canvas call in guarded tools. Q10 should measure fetch and D1 separately and combined. Set `CANVAS_REQUEST_BUDGET` = cap − max D1 per call − 2.

4. **MAJOR: course-code lookup costs one request per course, unlike upstream, and pushes multi-course tools over their tier.**
   - Design part: §5 `resolveCode` "uses the memo, else one GET /courses/{id}". The memo is filled only by `resolveId`.
   - Evidence: `UP/src/canvas_mcp/core/cache.py`, `get_course_code`: on a cold cache it calls `refresh_course_cache()` once (`/courses?per_page=100`, one page for 100 or fewer courses), then falls back per id.
   - `get_my_upcoming_assignments` and `get_my_todo_items` call `get_course_code` per item and are unmarked (S, up to 6 requests). For an 8-course student that is 1 + 8 = 9 > 6, so 2-3 courses show bare ids.
   - `get_discussion_entry_details` (view, entry_list, P(E), replies, topic, course code) is about 8 on a 300-entry thread, also above S.
   - Change: on the first miss, load the course-list memo (1 request). Use a per-id GET only for ids not in the list. Seed the memo from any `/courses` or `/courses/{id}` response already fetched in the call. Derive tiers from the fan-out formulas at 8 courses and 300 students, and move these three tools to M.

5. **MAJOR: cutting output at a line boundary breaks the JSON-string tools at real class sizes.**
   - Design part: §3 step 11, "cut at a line boundary".
   - Evidence: `UP/src/canvas_mcp/tools/peer_reviews.py:71,107,243` return `json.dumps(result, indent=2)`; the `peer_review_comments` and accessibility tools do the same.
   - At 300 students × 3 reviews = 900 entries, the output is roughly 300-900 KB, above the 200,000-byte cap. The cut yields invalid JSON, and the `{"error":…}` parse used for isError misfires.
   - Change: never byte-cut JSON. Trim the arrays and add `truncated:{shown,total,next_cursor}`. Add `limit`/`cursor` (or `student_ids`) params to `get_peer_review_assignments`, `get_peer_review_comments`, `analyze_peer_review_quality`, `identify_problematic_peer_reviews` and the scan. Point large datasets to `extract_peer_review_dataset`.

6. **MAJOR: the 20-per-call cap on `bulk_grade_submissions` ignores Canvas's bulk endpoint and leaves no path for 30+ students.**
   - Design part: batch 4 cap of 20, plus removal of Strategy C from the `canvas-bulk-grading` skill.
   - Evidence: Canvas `POST /courses/:c/assignments/:a/submissions/update_grades` takes `grade_data[<student_id>][posted_grade|rubric_assessment|text_comment]` and returns a Progress object.
   - `UP/skills/canvas-bulk-grading/SKILL.md:57-62,116` routes 30+ submissions to `execute_typescript`, which is dropped. A 300-student class therefore needs 15 tool calls.
   - Change: keep per-student PUTs up to the cap, which preserves per-row graded/failed reporting. Above it, send `update_grades` in chunks of up to 100: 1 POST + up to 3 `GET /progress/:id` + a ceil(N/100) verification read, about 8 requests for 300 students.
   - If the job is not finished by the deadline, return the progress id. Document that per-row failures come from the verification diff. Rewrite Strategy C in the skill to use this.

7. **MAJOR: the `check_enrollment` redesign brings back issue #199 and weakens the ambiguity guards.**
   - Design part: batch 3, search with `enrollment_type[]=<role>`, then "a truncated scan answers indeterminate, never not enrolled".
   - Evidence: `UP/src/canvas_mcp/core/enrollment.py`: "Deliberately NO type[] filter (issue #199)".
   - `_match_enrollment`'s second pass detects ambiguity, and `_identifiers_visible` checks visibility with `all()`. Both need the whole roster.
   - Canvas docs for `/courses/:id/users`: only "'active' and 'invited' enrollments are returned by default", which breaks `active_only=False`.
   - `lib/user_search.rb` matches login only with `:view_user_logins` and SIS id only with `:read_sis`, so a search miss is not evidence of absence.
   - Change: the search step uses no role filter and anonymization off. It may answer YES only on an exact `login_id`/`sis_user_id` match, with the role checked locally. Every other outcome goes to the `/enrollments` scan (4 requests for 300 students).
   - On a truncated scan, only an exact-match YES is allowed. Local-part matches, NO and `roles_held` become INDETERMINATE.

8. **MAJOR: batch 5 depends on Q19 but has no fallback.**
   - Design part: §7 R2 download "Requires the owner's web identity headers". Q19's "no" branch only changes the status page.
   - Problem: if Q19 fails, `create_student_anonymization_map` has no channel that keeps real names away from the model. A capability URL in the tool output would reach the model.
   - Change: make Q19 a gate for batch 5. If it fails, `create_student_anonymization_map` is not registered, and `download_course_file` and `extract_peer_review_dataset` return inline output or the Canvas link only.
   - Also: an R2 `put` of a stream needs a known length. Use `FixedLengthStream` with the file object's `size`; this conflicts with the byte-counter abort as written.

9. **MINOR: upstream "bug" #5 (unpaginated peer-review reads) is not a bug.**
   - Evidence: `peer_reviews_api_controller.rb#index` renders `assessment_requests_json(...)` with no `Api.paginate`, so Canvas returns every review in one response.
   - Change: remove it from the fixed-bugs list. Budget the endpoint as exactly 1 request and count the full response size.

10. **MINOR: the `read_course_file` redesign makes typical PDFs and slides unreadable, and the docstring is now wrong.**
    - Evidence: `UP/src/canvas_mcp/tools/files.py:169-190` says "return its content as base64", default 25 MB. The design returns non-text only up to 150 KB but keeps the docstring "verbatim".
    - Change: add a spike question on whether ChatGPT accepts an MCP `resource` blob (`application/pdf`) and how large. Otherwise do Worker-side PDF text extraction with page ranges, gated on Q11 CPU. Update the description.

11. **MINOR: existing endpoints would cut the group fan-out the design caps.**
    - Evidence: Canvas groups docs list `only_own_groups` for `GET /courses/:id/groups`. Upstream filters `group_category_id` on the client after listing every group (`UP/src/canvas_mcp/tools/discussions.py:290-297`), so the "max 2 pages" cap can truncate before the filter runs.
    - Change: use `only_own_groups=true` for the student role, and `GET /group_categories/:id/groups` (Group Categories API) when a category is given.

12. **MINOR: the generate/extract peer-review tools are classified inconsistently.**
    - Design part: §6 `computeToolSet` applies the write policy, which would drop the LOCAL_WRITE `generate_peer_review_report` even though §8 says it "is registered as a read".
    - Its `save_to_file` error points to `extract_peer_review_dataset`, which is batch 5 and off unless allowlisted.
    - Change: add an explicit, tested `effectOverride`. Move the inline mode of `extract_peer_review_dataset` to batch 3.

13. **MINOR: the annotation corrections are applied unevenly.**
    - Evidence: `create_discussion_topic` (`UP/src/canvas_mcp/tools/discussions.py:1198`), `create_assignment` (`UP/src/canvas_mcp/tools/assignments.py:678`) and `assign_peer_review` (`UP/src/canvas_mcp/tools/assignments.py:157`) all trigger Canvas notifications, the same reason used to flip `create_announcement`. OpenAI review counts irreversibility "through indirect side effects".
    - Change: mark them `destructiveHint: true`, or write down why not, and cover it in the annotation snapshot.

14. **MINOR: the M2 parity criterion contradicts the batch-1 redesigns.**
    - Evidence: `UP/tests/tools/test_truncation_disclosure.py:403-412` expects 10 `/items` reads and "Modules Analyzed for Items: 10 of 12".
    - Several batch-1 tools change output on purpose: `get_course_content_overview`, `get_course_structure`, `list_course_files`, `list_group_discussion_topics`, the discussion fallbacks, and the caps in `get_my_submission_status` and `get_my_peer_reviews_todo`.
    - Change: list expected deviations per tool in `docs/PARITY.md`, and run parity on under-cap fixtures only.

15. **MINOR: the cursor format cannot express fan-out continuation.**
    - Evidence: §5 defines cursors as `{v, tool, endpoint, query}`. `list_groups`, `list_group_discussion_topics`, the scan and `fix_accessibility_issues` need an offset into a parent list.
    - Change: add `offset` and a hash of the parent id list, and reject the cursor if the list changed.
    - Cursors need `CONFIRMATION_SECRET`, so schedule that secret in M2, not M3.

16. **MINOR: `bulk_delete_announcements` contradicts its own docstring and over-spends.**
    - Evidence: the upstream docstring says "pass a higher value to override" (`UP/src/canvas_mcp/tools/discussions.py:1662-1680`), but the design clamps to 18. Preview does one GET per id.
    - Change: resolve titles with one `discussion_topics?only_announcements=true` listing, raise the cap to about 35, and rewrite the refusal text.

17. **MINOR: `send_bulk_messages_from_list` templates lose Python format specs.**
    - Evidence: `UP/src/canvas_mcp/tools/messaging.py:125-127` uses `.format(**recipient)`, so `{score:.1f}` works upstream.
    - Change: support the `[fill][align][width][.prec][type]` subset, or say in the description that it is not supported.

18. **MINOR: an upstream bug is kept without disclosure.**
    - `get_my_submission_status` in all-courses mode silently drops courses whose assignment read fails, so "No assignments found" can be false.
    - Change: report which courses failed, in the issue-420 style.

19. **MINOR: `upload_course_file` `source_url` is described with the wrong flow.**
    - Evidence: Canvas file-upload docs. URL upload posts to `upload_url` with `target_url` and no file, then polls a Progress object. It is not "three-step with the pinned confirm hop".
    - Change: budget the polls and return the progress id if the upload is not done by the deadline.

20. **MINOR: course resolution regressions.**
    - Upstream `get_course_id` passes non-numeric identifiers without `_` through unchanged (`UP/src/canvas_mcp/core/cache.py`). That lets Canvas-native prefixes `lti_context_id:`, `uuid:` and `sis_integration_id:` work; design step 5 now errors on them.
    - Step 2 rejects `/` in SIS ids, which Canvas accepts as `%2F`.
    - Change: allow known Canvas id prefixes with percent-encoding.

**The three changes that matter most:**
- **(1)** Never take student names from NONE-tier endpoints. `list_peer_reviews` uses the FULL-tier roster; `list_groups` via `include[]=users` only with a forced FULL tier and a truncation check.
- **(3)** Count D1 and R2 calls in one subrequest meter, and reserve them before the first Canvas call.
- **(2)+(4)** Rebuild the student cross-course tools: Planner-only peer-review discovery, and a course-code lookup that loads the course list once. Set tiers from realistic fan-out.