# Differences from upstream canvas-mcp v1.13.0

This file lists every place where the TypeScript port deliberately behaves differently from the Python source in `.upstream/canvas-mcp`. Anything not listed here is meant to match upstream, and a mismatch is a bug.

"Upstream" means canvas-mcp v1.13.0. "The port" means the code under `src/`.

## Scope

- The port contains the shared core, the Canvas client, the MCP layer, the HTTP app, two diagnostics tools and eleven upstream read tools: `list_courses`, `get_course_details`, `get_syllabus`, `get_my_profile`, `get_my_enrollments`, `get_my_course_grades`, `get_my_todo_items`, `get_my_upcoming_assignments`, `get_my_submission`, `list_assignments` and `get_assignment_details`. These business tools are included in the current owner-private, read-only deployment; diagnostics are disabled.
- `execute_typescript` and `list_code_api_modules` will not be ported. Their names stay in the tool policy table so that an upstream allowlist still parses.
- Upstream's stdio transport, its access-key and Entra gates, its access-request flow and its TypeScript sandbox have no counterpart. The port serves HTTP only, behind the Sites gateway.
- The port keeps no state between requests. Every upstream process-global (course cache, pseudonym cache, config singleton, timezone cache) is per request or per tool call here.

## Configuration (`src/env.ts`)

Variables:

- New variables: `AUTH_MODE`, `OWNER_EMAIL`, `OWNER_USER_ID_SHA256`, `CONFIRMATION_SECRET`, `PSEUDONYM_SALT`, `MCP_PATH`, `MCP_BACKEND`, `AUDIT_TO_D1`, `CANVAS_REQUEST_BUDGET`, `CANVAS_MAX_PAGES`, `TOOL_DEADLINE_MS`, `MAX_TOOL_RESULT_BYTES`, `MAX_REQUEST_BYTES`, `MAX_UPLOAD_MB`, `MAX_BULK_ITEMS`, `ALLOWED_HOSTS`, `DISABLED_TOOLS`, `DIAGNOSTICS_ENABLED`, `EXPORTS_ENABLED`, `DB_BOOTSTRAP`.
- Not read: `CANVAS_ALLOW_INSECURE_HTTP`, `DEBUG`, `LOG_API_REQUESTS`, `ANONYMIZATION_DEBUG`, `LOG_EXECUTION_EVENTS`, `AUDIT_LOG_DIR`, `CACHE_TTL`, `EXECUTE_TYPESCRIPT_ENABLED`, `ENABLE_TS_SANDBOX`, every `TS_SANDBOX_*`, `MCP_ACCESS_KEYS`, `MCP_ALLOW_UNAUTHENTICATED`, `ENTRA_AUTH_ENABLED`, `MCP_ENTRA_ALLOWED_OIDS`, every `ACCESS_*` and `ACS_*`.
- Different defaults (upstream value in brackets): `CANVAS_ROLE` `student` (`all`), `LOG_ACCESS_EVENTS` `true` (`false`), `API_TIMEOUT` 15 s (30), `MAX_CONCURRENT_REQUESTS` 3 (10), `READ_FILE_MAX_SIZE_MB` 5 (100).
- `MAX_CONCURRENT_REQUESTS` is clamped to 1..4 and `CANVAS_REQUEST_BUDGET` to 5..200.
- `LOG_LEVEL` is honoured (`debug`, `info`, `warn`, `error`; `warning` is read as `warn`).
- `CANVAS_API_TOKEN` is required for the single owner. Upstream's HTTP mode forbids it: each client sends its own token in `X-Canvas-Token`.

Parsing:

- `AUTH_MODE` is a compatibility setting accepting only unset or `owner` (case-insensitive). Other modes refuse requests. Credentials have only the `owner-secret` kind; provider failures are `not_configured` or `forbidden`. There is no account-linking state or personal credential store.

- Nothing throws and nothing exits. A violation is recorded in `config.errors` with a code and a level: `request` refuses every `/mcp` request, `invocation` refuses tool calls but not discovery. A tolerated problem is recorded in `config.warnings`.
- Booleans: only `true` is true, as upstream. A blank value counts as unset and takes the default; upstream reads blank as false. A value that is neither `true` nor `false` is read as false, as upstream, and adds a warning.
- `ENABLE_DATA_ANONYMIZATION` and `LOG_REDACT_PII` accept only `true` or `false`. Any other value is a request-blocking error (`enable_data_anonymization_invalid`, `log_redact_pii_invalid`) and the protection stays on. Upstream reads such a value as false.
- An unknown `CANVAS_ROLE` is a request-blocking error. Upstream warns and uses `all`.
- An integer that must be positive falls back to its default, with a warning, when it is zero or negative. `inf` and `nan` are refused for floats. Upstream accepts both.
- `STUDENT_WRITE_TOOLS`: unknown names are dropped from the parsed list. Upstream keeps them and ignores them later. The warning text is the same.
- `DISABLED_TOOLS` names that are not in the tool table are kept, with a warning.
- Secrets are trimmed. A `CONFIRMATION_SECRET` under 32 characters counts as missing.

`CANVAS_API_URL`:

- `http` is always refused. There is no loopback exception.
- A port other than 443, userinfo and IP literals are refused. Upstream keeps `host:port`.
- The host must be a dotted DNS name, so `localhost` and single-label hosts are refused.
- A trailing dot on the host is removed.
- A value that a URL parser would silently repair is refused before parsing: backslashes, whitespace, control characters, `https:///host`.

Messages:

- A rejected value longer than 40 characters is shown by length only.
- The values of `CANVAS_API_TOKEN`, `CONFIRMATION_SECRET`, `PSEUDONYM_SALT`, `OWNER_EMAIL` and `OWNER_USER_ID_SHA256` are never shown, only their length.
- A rejected `CANVAS_API_URL` is shown as scheme and host when the host is a DNS name, otherwise by length.
- An entry of a list-valued variable is named only when it is made of letters, digits and underscores and is at most 64 characters. Any other entry is shown by length. Upstream echoes every entry.

Fail-closed rules with no upstream counterpart, all request-blocking:

- `canvas_token_invalid`: the token contains whitespace or non-ASCII characters.
- `owner_email_invalid`, `owner_user_id_sha256_invalid`.
- `auth_mode_invalid`: only unset or `owner` is accepted; the unused per-user implementation was removed.
- `diagnostics_with_credentials`: diagnostics mode with a Canvas token or a confirmation secret present, judged on the raw values.
- `runtime_bound_exceeded`: `TOOL_DEADLINE_MS` plus `API_TIMEOUT` must be under 300 seconds.

## Tool policy (`src/core/tool-policy.ts`)

- Only upstream's HTTP-transport semantics are ported: an unset allowlist means read-only.
- `all` combined with any other entry is refused. Upstream allows `all,execute_typescript`.
- `isToolAllowed` never allows a `code_exec` tool, even when `execute_typescript` is named. `resolveToolPolicy` still accepts the name.
- `isToolAllowed` refuses a name that is missing from the table, and treats a tool as a read only when both its definition and the table say so.
- `generate_peer_review_report` is `local_write` in the table and is registered as a read (`READ_EFFECT_OVERRIDES`).
- The table holds 58 reads. Upstream's comment says 57; the total of 104 matches `TOOL_MANIFEST.json`.

## Argument validation (`src/core/validation.ts`)

- Driven by `ParamSpecs` instead of Python type hints. The JSON Schema advertised for a tool is built from the same specs, with `additionalProperties: false`.
- `int` rejects booleans, fractional numbers, `1_000` and integers outside the safe range. Python's `int()` accepts `True`, truncates floats and allows underscores.
- `float` rejects booleans, `inf` and `nan`.
- `id` stringifies an integer and refuses booleans, fractions and containers. The message names the types as `string, integer`.
- `string` turns an object or array into JSON text. Upstream gives the Python repr.
- List items are checked against the item kind. String and id items must be strings or numbers and are delivered as strings; object items must be objects.
- A parameter with a default is not required, even if it is not marked optional.
- An explicit null for an optional parameter is treated as absent.
- `Missing required parameter 'x'`, `Unknown parameter 'x'` and `Arguments must be an object (got ...)` are the port's own wording. Upstream leaves these cases to FastMCP.
- A rejected value is shown as JSON and cut at 200 characters.
- `coerceCanvasId` uses the rule of `canvasId` in `src/canvas/path.ts`, so it also rejects numbers above 2^53.

## Logging (`src/core/logging.ts`)

- Output is one JSON object per line: `{timestamp, level, event, ...}`. Upstream writes `message | Context: {...}` text. There is no audit log file.
- `security` events are always written, whatever the level.
- `sanitizeUrl` masks digits in the path only. Upstream masks the whole URL, which damages a host that starts with a digit.
- Digit matching uses `\p{Nd}`, which matches what Python's `\d` matches.
- `redactSecrets` removes each secret in five forms: raw, `encodeURIComponent`, strict percent-encoding, form encoding and JSON-escaped.
- The logger applies the PII key rules to nested objects as well as the top level.
- An `Error` is logged as `{name, message}` with the message scrubbed and cut at 300 characters. No stack is logged.
- An identity is logged only as `identityTag`: 12 hex characters of HMAC-SHA256 over `identity-tag|<identity key>`.

## Canvas paths (`src/canvas/path.ts`)

- Every path is built with the `canvasPath` template tag. Each interpolated value is percent-encoded and stays one path segment.
- An interpolated `?`, `#`, `/`, `\` or `%` is encoded. Upstream refuses `?` and `#` and does not check the others.
- An interpolated empty string, `.`, `..`, control character or lone surrogate is refused. Numbers must be non-negative safe integers.
- Literal text is refused for `?`, `#`, `\`, whitespace, any other character outside the RFC 3986 path set, `//`, a malformed percent-escape and every encoded spelling of a dot segment. Upstream refuses `?`, `#` and a literal `..` segment.
- Upstream's refusal text is kept where it applies: `Invalid endpoint: '?' is not allowed in a request path` and the same for `..`. A refusal is thrown as `CanvasPathError` and never echoes the value.
- `rawCanvasPath` brands an already-encoded constant. Its only caller is the client's fixed `/courses` probe.
- `resolveCanvasUrl` returns a URL only when the parsed pathname equals the API base path plus the built path. The base must be `https`.
- `canvasId` trims whitespace as upstream does, rejects numbers above 2^53 and accepts bigint. JavaScript `trim()` and Python `strip()` differ on a few rare whitespace characters.

## Query and form encoding (`src/canvas/encode.ts`)

- `buildFormBody` applies the `true`/`false` and null-to-empty rules to tuple lists too. Upstream would send `True` and `None` there; its only tuple-list call sites pre-stringify, so no request differs.
- A space in a query is sent as `+`. httpx sends `%20`. Canvas decodes both the same way.

## Errors (`src/canvas/errors.ts`)

- A failure carries `outcome` (`not_dispatched`, `rejected`, `may_have_written`) and optionally `status`, `throttled` and `budgetExhausted`. `failureToWire` reduces it to upstream's `{error}` shape.
- `isFailure` requires a valid `outcome`. A bare `{error: ...}` object is not a failure. Upstream treats any dict with an `error` key as one.
- The `Details:` part of an HTTP error is the Python repr of the parsed body, as upstream prints it. Known gaps: a JSON `1.0` prints as `1`; integers above 2^53 lose precision; integer-like object keys are reordered; code points newer than CPython's Unicode tables print literally instead of escaped.

## Link header (`src/canvas/link-header.ts`)

- `splitLink` and `nextPageUrl` follow upstream's `code_api/client.ts`. Errors are thrown as `PaginationLinkError` with upstream's messages.
- Upstream's `validatePageUrl` is not ported. `isPinnedPageUrl` in `src/canvas/path.ts` takes its place and also requires `https`.

## Canvas client (`src/canvas/client.ts`)

Requests:

- The client holds the token in a closure. Tools never receive it.
- A path that does not resolve under the API base is refused with `Invalid endpoint: the request path does not resolve under the Canvas API base`.
- `params` on POST or PUT, and a body on GET or DELETE, are refused. Upstream silently drops them.
- A 3xx response is never followed. Its error text is `HTTP error: 302, Text: `, as upstream.
- A 2xx body that is not JSON gives `Request failed: Expecting value: line L column C (char N)` when no JSON value starts the body, which matches Python. A body that fails later gives `Request failed: response body is not valid JSON`.
- A transport error gives `Request failed: <ErrorName>: <message>`. URLs in the message are reduced to scheme, host and path, and the token is redacted. A timeout gives `Request failed: the request timed out`. Upstream prints `str(e)`.
- A 2xx body with a top-level `error` key is returned as a failure with outcome `may_have_written`.
- An error body over 16384 characters is cut and ends with `... [truncated]`.
- The User-Agent is `canvas-gpt-sites/0.1.0 (TypeScript port of canvas-mcp/1.13.0)`.
- Every request counts against the subrequest budget of the tool call and is refused once the budget or the tool deadline is spent. The timeout is the smaller of `API_TIMEOUT` and the time left.

Retries and throttling:

- Only GET is retried: twice for a throttle (1 s, 2 s, or an integer `Retry-After`, plus up to 250 ms of jitter) and once after 500 ms for a network error, a timeout or 502/503/504. Upstream retries 429 three times for every method (2, 4, 8 s).
- Writes are never retried.
- A 403 with `Rate Limit Exceeded` in the body, or with `X-Rate-Limit-Remaining` at or below 0, counts as a throttle. The failure carries `throttled: true`; its outcome still comes from the status.
- When `X-Rate-Limit-Remaining` falls below 150 the client stops sending requests in parallel.

Pagination:

- A page cap (`CANVAS_MAX_PAGES`, default 10), an item cap, an exhausted budget, the deadline or `X-Rate-Limit-Remaining` below 50 returns a truncated `Paged` result with a reason. Upstream reads up to 10000 pages and then returns the error `Pagination exceeded N pages`.
- If the first page cannot be sent, `fetchAll` returns the `not_dispatched` failure, not an empty truncated page.
- A next link must be `https`, on the API origin, on the same pathname, with no userinfo and no fragment. Every refusal uses upstream's text `Invalid pagination link: origin or endpoint changed`.
- `requireComplete` and `disclose` have no upstream counterpart. A truncated list that a tool does not disclose is disclosed by the dispatcher.

Anonymization:

- The tier is chosen from the URL actually requested, with the API base removed, and can be raised with `forceTier`.
- `skipAnonymization` is honoured only on a client created with `allowRaw`. Otherwise the call is refused and logged as the security event `canvas_raw_access_refused`.
- A paginated list is anonymized once, after all pages are merged.

## Budget and concurrency (`src/canvas/budget.ts`, `src/canvas/limiter.ts`)

- No upstream counterpart. One `SubrequestMeter` per tool call counts Canvas fetches, D1 calls and R2 calls together, and can reserve slots for later mandatory steps.

## Course resolver (`src/canvas/course-resolver.ts`)

- The memo lives in the client of one tool call. Upstream caches per process.
- A numeric id must be ASCII digits and is trimmed.
- A value with the prefix `sis_course_id:`, `sis_integration_id:`, `lti_context_id:` or `uuid:` is passed through undecoded and encoded by `canvasPath`. An empty or control-character value after the prefix is refused.
- Every other value loads the course list once, at most 5 pages. Upstream does so only for values containing `_`.
- A miss without `_` gives `Course '<x>' not found. Use list_courses to get the course ID.` Upstream returns the raw value.
- If the list could not be loaded and the value has no `_`, the load failure's text is returned with outcome `not_dispatched`.
- `resolveCode` returns the id when a course has no `course_code`. Upstream returns an empty string or `None`. A failed per-id lookup is remembered and not repeated.

## File downloads (`src/canvas/files.ts`)

- Redirects are followed by hand. Upstream uses `follow_redirects=True`.
- The first request must be `https` on the Canvas origin. At most 3 redirects are followed after it.
- Once a redirect leaves the Canvas origin, `Authorization` is never attached again, even if a later redirect returns to Canvas.
- A non-2xx answer reports the status only (`HTTP error: 404`), never the body or the URL.
- A file over the limit gives `File exceeds the download size limit of <n> bytes`.

## Anonymization (`src/core/anonymization.ts`, `src/core/anonymization-tiers.ts`)

- The pseudonym memo is per tool call and keyed `prefix:id`. Upstream's process-wide cache is keyed by id alone, so a `Reviewer` or `Reviewee` prefix collapses into `Student`.
- With `PSEUDONYM_SALT` set, the digest is HMAC-SHA256(salt, id). An empty salt is treated as no salt, which gives upstream's unsalted SHA-256.
- `tierForPath` classifies both the literal segments, as upstream, and the percent-decoded reading, and returns the stricter. This can only raise the tier, and only for a path that contains `%`.
- `maxTier('identity', 'free_text')` is `full`.
- An unrecognised tier value is treated as `full`.
- The regexes use `\p{Nd}` and explicit `[\p{L}\p{N}_]` lookarounds, which match Python's `\d` and `\w` except for characters added in Unicode 17.
- Email redaction is a linear scan from each `@`. The output is the same as upstream's regex replace, which is quadratic on some inputs.
- Submission content redaction leaves an existing `[CONTENT_REDACTED]` value alone. Upstream rewrites it on a second pass.
- The 1000-character description limit counts code points, as Python's `len` does.
- Not ported: `create_anonymization_summary`, `get_anonymization_stats`, `clear_anonymization_cache`, and the wrappers `anonymize_user_data`, `anonymize_discussion_entry`, `anonymize_submission_data`, `anonymize_assignment_data`.

## Untrusted content (`src/core/untrusted-content.ts`)

- The fencing helpers give upstream's output with linear scanners instead of regexes. They follow Python's whitespace set and its case-insensitive matching.
- `closeOpenFence` is new. It ends a block fence that truncation cut open with the end marker, and an inline fence with `>>>`.
- `fenceUntrustedFields` visits each object once. Upstream would fence an object referenced twice two times.
- The per-tool registry is not ported. Each tool definition carries a `fencing` value instead.
- Upstream's `deferred` course-identity and minimized-self-profile exceptions map to `safe` in the port's two-category metadata: `list_courses`, `get_course_details`, `get_my_profile`, `get_my_enrollments` and `get_my_course_grades`. Their output wording and absence of fences match upstream; this mapping does not establish that arbitrary Canvas text is trusted.

## Initial read tools (`src/tools/`)

- `get_my_upcoming_assignments` refuses a look-ahead that exceeds JavaScript's date range before making a request, with `Error: days is outside the supported date range.` Python can instead raise an overflow exception. Shared integer validation also limits inputs to safe integers.
- Paginated tools disclose partial results using the Canvas client's bounded-pagination notice. The port does not silently present a budget-limited list as complete.
- Offline parity fixtures execute the selected functions from upstream revision `14fb51d0b1337707867494213e59509453bf5558` against fake responses. They preserve Python wire JSON, including negative zero, and check descriptions, output and request parameters. They do not validate live Canvas access.

## HTML helpers (`src/core/html.ts`)

- `stripHtmlTags` and `extractEmbeddedMedia` give upstream's output with linear scanners.
- `extractEmbeddedMedia` follows `html.parser` of Python 3.14, which treats `<iframe>` content as raw text.
- `decodeEntities` drops control characters and noncharacters written as numeric references, as `html.unescape` does. A numeric reference with more than 4300 digits becomes U+FFFD; Python raises.
- `formatMediaInventory` is exported from this module.

## Dates (`src/core/dates.ts`, `src/core/raw-dates.ts`)

- The time zone is a parameter. Nothing is cached at module level and nothing is written to stderr.
- An unknown `TIMEZONE` is reported once, as a configuration warning. The "could not parse" warning is dropped.
- `parseDate` returns a `ParsedDate`, a `Date` subclass that keeps the original offset and has `isoformat()` with Python's output.
- `parseDate` accepts ASCII digits only. Python's `strptime` also accepts other Unicode digits.
- `formatDate` returns its input unchanged where upstream raises `OverflowError` (an instant outside years 1 to 9999).
- Zone names are resolved by `Intl`, which is case-insensitive and may accept offset identifiers such as `+05:30`. Python's `ZoneInfo` falls back to UTC for those.
- Chicago conversion prints `-05:00`, as Python does. One upstream test expects `-0500`.
- `renderRawDates` escapes non-ASCII characters as `\uXXXX`, as `json.dumps` does.

## CSV (`src/core/csv-safety.ts`)

- Booleans are written as `True` and `False`, as Python does. Numbers use JavaScript formatting, so `1.0` is written as `1`.

## Tool definitions and registry (`src/mcp/define-tool.ts`, `src/mcp/registry.ts`)

- A tool is a `ToolDef` checked once by `defineTool`: name, title, module, role, effect, fencing, all four annotation hints, budget tier and parameter defaults. The effect must agree with the tool policy table.
- `openWorldHint` is always false. A read must have `readOnlyHint: true`.
- `rawAccess` is allowed only for `check_enrollment` and `create_student_anonymization_map`.
- `computeToolSet` applies, in order: diagnostics mode, role, `STUDENT_WRITE_TOOLS`, `ACCESSIBILITY_CHECKERS`, the D1, R2, confirmation-secret and budget gates, `DISABLED_TOOLS`, then the write allowlist. A duplicate name is skipped.
- In diagnostics mode only the diagnostics tools are registered. `DISABLED_TOOLS` still applies.

## Tool dispatch and results (`src/mcp/dispatch.ts`, `src/mcp/result.ts`)

- Each call receives a detached, recursively frozen configuration snapshot shared by the handler and its Canvas client. Tools cannot mutate privacy switches, policy lists or the output size limit during a call.

- `runTool` authorizes the caller again before it asks for the credential. It refuses every non-diagnostics tool while `config.errors` is not empty.
- A handler has no access to the environment, the token or any secret.
- An argument validation error is returned as `{"error": "..."}` text written the way Python's `json.dumps` writes it.
- A thrown `Error` gives `Error: <message>`. Another class gives `Error: <Name>: <message>`. The message is the first line, cut at 200 characters and redacted. A `SyntaxError` keeps its name only.
- `isError` follows upstream's `_text_is_error`. `JSON.parse` does not accept `NaN` or `Infinity`, which Python's `json.loads` does.
- Text over `MAX_TOOL_RESULT_BYTES` is cut, on UTF-8 bytes, at the last line break that keeps at least half of what fits, otherwise at a character boundary. An open fence is closed before the notice.
- JSON over the limit (an object, or a string that parses as an object or array) is refused with an error. It is never cut.
- Every secret-class value is redacted from text, object keys and `structuredContent`, before the size limit and again after.
- A truncated list that the tool did not disclose adds the notice `the list of <label> is incomplete because <reason>` to text output and `"truncated": true` to object output.

## MCP transport (`src/mcp/backend.ts`, `src/mcp/handler.ts`, `src/mcp/jsonrpc-native.ts`)

- Sites currently omits `Mcp-Method` and `Mcp-Name` on modern requests. After the app authorizes the original request, the SDK adapter restores absent routing headers from the parsed body for revision 2026-07-28 (ASCII method names and tool names only). Supplied headers are preserved and cross-check mismatches remain errors. The required protocol-version header and modern envelope are still validated by the SDK.
- A rejected modern request logs only its known method and whether envelope/header fields exist, to diagnose Sites client compatibility. Request bodies, argument values, header values and SDK error text are never logged.

- Upstream serves MCP through FastMCP. The port has two backends behind one interface, chosen with `MCP_BACKEND`: the official TypeScript SDK and a dependency-free JSON-RPC server.
- Every response is plain JSON. Nothing is streamed. GET and DELETE are answered with 405.
- JSON-RPC batches are refused by both backends (HTTP 400, code -32600).
- Both backends advertise `capabilities: { tools: { listChanged: false } }` and send server instructions. Upstream sends no instructions.
- The native backend serves protocol revisions 2025-11-25, 2025-06-18 and 2025-03-26 only. A request that claims another revision gets HTTP 400 with code -32022 and the supported list. A `server/discover` with no claim gets -32601.
- The SDK backend serves 2025-era requests with a per-request server on a JSON-response transport, and 2026-07-28 requests with one handler in JSON mode.
- The SDK backend answers `subscriptions/listen` with 404 and -32601, and replaces any event-stream response with a 500 JSON error.
- Argument schemas are hand-built Standard Schemas with a permissive `validate`. Coercion happens in `runTool`.

## HTTP app, identity and owner gate (`src/app.ts`, `src/http/`, `src/auth/`)

No upstream counterpart, except the JSON bodies `{"error": "Not found"}` and `{"error": "Method not allowed"}` and the bounded body reader.

- The caller is identified by the Sites gateway headers `oai-authenticated-user-id` and `oai-authenticated-user-email`. Upstream's `X-Canvas-Token` header is not used.
- A request that carries `oai-sites-authorization` has no identity.
- An id or email that is empty, non-ASCII, over 320 characters, or contains a comma, whitespace or a control character rejects the identity.
- The full name is percent-decoded only when the encoding header says so, cut at 200 characters, and dropped if it does not decode.
- The Canvas token is the Site owner's secret. It is released only to a request whose email equals `OWNER_EMAIL`. When `OWNER_USER_ID_SHA256` is set and the request has a user id, the id's SHA-256 must match as well. A request without the id header passes on the email and is logged as `owner_id_header_absent`.
- `resolve()` withholds the token when `config.errors` is not empty or diagnostics mode is on.
- Per-user mode requires a gateway user id and releases no credential: linking a Canvas account is not implemented.
- A refusal by the app is HTTP 403 with JSON-RPC code -32001. No response is a 401 or carries `WWW-Authenticate`.
- A request to `/mcp` with an `Origin` or any `Sec-Fetch-*` header is refused. The content type must be `application/json`.
- Status HTML uses `Referrer-Policy: same-origin` so its form POST retains the same-origin `Origin` needed by the Canvas check. External referrers are suppressed. JSON responses retain `no-referrer`; a missing or null check origin remains refused.
- The body is read after the identity check. A caller who is not authorized may send at most 64 KiB. A body that is not valid UTF-8 is answered with -32700.
- A request is treated as discovery only when the body method and the `Mcp-Method` header, if present, both name a discovery method.
- A request-blocking configuration error answers HTTP 500 with -32603. An invocation-blocking one answers a tool call with -32603 at HTTP 200.
- The SDK backend is loaded on first use, so `MCP_BACKEND=native` never evaluates the SDK.
- The status page shows the owner the configuration without any secret value, and everyone else one sentence. Log lines and the status page also redact the comma- or whitespace-separated pieces of each secret that are 8 characters or longer.
- `POST /api/status/check` calls `GET /users/self` once and reports only success and the HTTP status. It requires an `Origin` header naming the Site.

## Diagnostics tools (`src/tools/diagnostics.ts`)

- `hello` and `sites_diagnostics` do not exist upstream. They are registered only when `DIAGNOSTICS_ENABLED=true`, which is refused while a Canvas token or a confirmation secret is configured.
- They return header names, lengths and short hashes, never a header value. The exception is the full SHA-256 of the gateway user id, which is the value for `OWNER_USER_ID_SHA256`.

## Shared text helpers (`src/core/python-text.ts`)

- No upstream counterpart. It holds the Python behaviours the port has to reproduce: `str.isspace`, `str.strip`, the `\w` of str patterns, and the non-ASCII escaping of `json.dumps`.
