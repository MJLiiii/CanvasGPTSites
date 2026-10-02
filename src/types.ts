/**
 * Shared contracts for the port. Modules depend on these interfaces, not on
 * each other's implementations, so that every layer can be built and tested
 * in isolation.
 *
 * Two rules these types enforce on purpose:
 *  - Tool handlers never see `env`, the Canvas token, or any other secret.
 *  - Canvas paths can only be built through `canvasPath` (see canvas/path.ts),
 *    which encodes every interpolated segment.
 */

// ---------------------------------------------------------------------------
// Environment and configuration
// ---------------------------------------------------------------------------

/** Bindings and variables the Sites runtime passes to `fetch(request, env, ctx)`. */
export interface Env {
  DB?: D1Database;
  FILES?: R2Bucket;
  [name: string]: unknown;
}

export type Role = 'student' | 'educator' | 'all';
export type AuthMode = 'owner';
export type McpBackend = 'sdk' | 'native';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A fail-closed configuration violation. `message` never contains a secret value. */
export interface ConfigError {
  code: string;
  message: string;
  /** `request` blocks every /mcp request; `invocation` blocks tool calls but not discovery. */
  blocks: 'request' | 'invocation';
}

/** Parsed, validated, secret-free configuration. Safe to hand to any module. */
export interface Config {
  authMode: AuthMode;
  /** Normalized `https://host/api/v1`, or null when unset/invalid. */
  canvasApiUrl: string | null;
  canvasOrigin: string | null;
  hasCanvasToken: boolean;
  /** Lowercased ASCII email of the Site owner. */
  ownerEmail: string | null;
  /** Hex SHA-256 of the owner's gateway user id; enforced only when the id header is present. */
  ownerUserIdSha256: string | null;
  hasConfirmationSecret: boolean;
  hasPseudonymSalt: boolean;

  serverName: string;
  mcpPath: string;
  mcpBackend: McpBackend;

  role: Role;
  /** Raw ALLOWED_WRITE_TOOLS value; null when unset (read-only). */
  allowedWriteToolsRaw: string | null;
  studentWriteTools: string[];
  coursePolicy: { enabled: boolean; defaultPosture: 'allow' | 'deny'; allowTtlSeconds: number; denyTtlSeconds: number };
  accessibilityCheckers: string[];
  disabledTools: string[];

  anonymizationEnabled: boolean;
  logRedactPii: boolean;
  logAccessEvents: boolean;
  logLevel: LogLevel;
  auditToD1: boolean;

  timezone: string;
  institutionName: string;

  apiTimeoutMs: number;
  maxConcurrentRequests: number;
  readFileMaxBytes: number;
  /** Subrequest budget per tool call; counts Canvas fetches and D1/R2 calls together. */
  requestBudget: number;
  maxPages: number;
  toolDeadlineMs: number;
  maxToolResultBytes: number;
  maxRequestBytes: number;
  maxUploadBytes: number;
  maxBulkItems: number;

  allowedHosts: string[];
  diagnosticsEnabled: boolean;
  exportsEnabled: boolean;
  dbBootstrap: boolean;

  errors: ConfigError[];
  warnings: string[];
}

/**
 * Secret values. Only auth/ and the modules that are handed a specific secret
 * in their constructor may hold these. Never placed on a context object.
 */
export interface Secrets {
  canvasToken: string | null;
  confirmationSecret: string | null;
  pseudonymSalt: string | null;
}

// ---------------------------------------------------------------------------
// Identity and credentials
// ---------------------------------------------------------------------------

export interface Identity {
  /** `id:<gateway user id>` when the id header is present, else `email:<email>`. */
  key: string;
  userId: string | null;
  email: string | null;
  fullName: string | null;
  source: 'sites-gateway';
}

export type CredentialKind = 'owner-secret';

/** Held only by auth/ and the CanvasClient that is built from it. */
export interface CanvasCredential {
  apiBaseUrl: string;
  origin: string;
  token: string;
  /** Stable, non-reversible identifier for the Canvas caller (keyed hash of the token). */
  callerId: string;
  kind: CredentialKind;
}

/** What tools may know about the credential in use. */
export interface CallerInfo {
  origin: string;
  callerId: string;
  kind: CredentialKind;
}

export type AuthorizeResult = { ok: true } | { ok: false; status: 403; publicMessage: string };

export type CredentialResult =
  | { ok: true; credential: CanvasCredential }
  | { ok: false; reason: 'not_configured' | 'forbidden'; publicMessage: string };

export interface CredentialProvider {
  readonly mode: AuthMode;
  authorize(identity: Identity | null): AuthorizeResult;
  /** Re-runs `authorize` itself; the only place a token is released. */
  resolve(identity: Identity | null): Promise<CredentialResult>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Always emitted regardless of level. */
  security(event: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Canvas client
// ---------------------------------------------------------------------------

declare const canvasPathBrand: unique symbol;
/** A path under the API base, built only by `canvasPath`/`rawCanvasPath` in canvas/path.ts. */
export type CanvasPath = string & { readonly [canvasPathBrand]: true };

export type WriteOutcome = 'not_dispatched' | 'rejected' | 'may_have_written';

/**
 * Upstream's dict-with-"error" failure shape. `error` text follows upstream
 * wording ("HTTP error: 404, Details: ..."); `outcome` drives confirmation release.
 */
export interface RequestFailure {
  error: string;
  outcome: WriteOutcome;
  status?: number;
  throttled?: boolean;
  budgetExhausted?: boolean;
}

export type Scalar = string | number | boolean | null;
export type Params = Record<string, Scalar | Scalar[] | undefined>;
/** A record, or a tuple list when the same key must repeat in a fixed order. */
export type FormBody = Record<string, Scalar | Scalar[] | undefined> | Array<[string, Scalar]>;

export type AnonymizationTier = 'none' | 'identity' | 'free_text' | 'full';

export interface RequestOptions {
  params?: Params;
  /** JSON body unless `useFormData` is set, in which case a `FormBody`. */
  data?: unknown;
  useFormData?: boolean;
  multipart?: FormData;
  /** Honoured only on clients created with `allowRaw`; otherwise the call is refused. */
  skipAnonymization?: boolean;
  /** Raise (never lower) the anonymization tier chosen from the path. */
  forceTier?: AnonymizationTier;
  /**
   * Let a GET spend slots set aside with `budget.reserve` (a read-back after a
   * write). POST/PUT/DELETE always draw on reservations first.
   */
  useReserved?: boolean;
}

export interface PageOptions {
  maxPages?: number;
  maxItems?: number;
  skipAnonymization?: boolean;
  forceTier?: AnonymizationTier;
  /** Noun used in the truncation notice, e.g. "assignments". */
  label?: string;
}

export type TruncationReason = 'max_pages' | 'max_items' | 'budget' | 'deadline' | 'throttle';

/** One list a client cut short during a tool call, and whether the tool's output has said so. */
export interface TruncationRecord {
  label: string;
  reason: TruncationReason;
  disclosed: boolean;
}

export interface Paged<T> {
  items: T[];
  truncated: boolean;
  reason?: TruncationReason;
  pagesFetched: number;
  label: string;
}

export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string;
}

export interface BudgetView {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** Set aside slots for later mandatory steps (write, read-back, D1). Throws nothing; returns false if unavailable. */
  reserve(n: number): boolean;
}

export interface CanvasClient {
  request<T = unknown>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: CanvasPath,
    options?: RequestOptions,
  ): Promise<T | RequestFailure>;
  fetchAll<T = unknown>(path: CanvasPath, params?: Params, options?: PageOptions): Promise<Paged<T> | RequestFailure>;
  /** Error text when `page` is truncated, else null. Call before any write that depends on the list. */
  requireComplete(page: Paged<unknown>, what: string): string | null;
  /** Returns the truncation notice for `page` (empty string if complete) and marks it disclosed. */
  disclose(page: Paged<unknown>, hint?: string): string;
  /**
   * Download a Canvas file URL. Redirects are followed by hand; once a hop leaves
   * the Canvas origin, Authorization is never attached again.
   */
  downloadFile(fileUrl: string, options: { maxBytes: number }): Promise<DownloadedFile | RequestFailure>;
  readonly courses: CourseResolver;
  readonly budget: BudgetView;
  readonly truncations: ReadonlyArray<TruncationRecord>;
  readonly caller: CallerInfo;
}

export interface CourseResolver {
  /**
   * Canvas course id (digits) or a `sis_course_id:`-style identifier, not yet
   * percent-encoded: pass it to `canvasPath`, which encodes it.
   */
  resolveId(identifier: string | number): Promise<string | RequestFailure>;
  /** Course code for display; falls back to the id string. Never throws. */
  resolveCode(courseId: string | number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type Effect = 'read' | 'canvas_write' | 'local_write' | 'code_exec';
export type ToolRole = 'shared' | 'student' | 'educator';

interface ParamBase {
  description: string;
  optional?: boolean;
}

export type ParamSpec =
  /** Canvas id or identifier: advertised as string|integer, delivered as string. */
  | (ParamBase & { kind: 'id'; default?: string })
  | (ParamBase & { kind: 'string'; default?: string })
  | (ParamBase & { kind: 'int'; default?: number })
  | (ParamBase & { kind: 'float'; default?: number })
  | (ParamBase & { kind: 'bool'; default?: boolean })
  | (ParamBase & { kind: 'enum'; values: readonly string[]; default?: string })
  | (ParamBase & { kind: 'list'; items: 'string' | 'id' | 'object' })
  | (ParamBase & { kind: 'dict' });

export type ParamSpecs = Record<string, ParamSpec>;

type ParamValue<S extends ParamSpec> = S extends { kind: 'id' | 'string' | 'enum' }
  ? string
  : S extends { kind: 'int' | 'float' }
    ? number
    : S extends { kind: 'bool' }
      ? boolean
      : S extends { kind: 'list'; items: 'object' }
        ? Array<Record<string, unknown>>
        : S extends { kind: 'list' }
          ? string[]
          : Record<string, unknown>;

/** Handler argument type: optional params without a default may be undefined. */
export type InferArgs<P extends ParamSpecs> = {
  [K in keyof P]: P[K] extends { optional: true }
    ? P[K] extends { default: Scalar }
      ? ParamValue<P[K]>
      : ParamValue<P[K]> | undefined
    : ParamValue<P[K]>;
};

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

export type BudgetTier = 'S' | 'M' | 'L';

export interface ToolGate {
  /** One of the three student write tools; also needs STUDENT_WRITE_TOOLS. */
  studentWrite?: true;
  accessibilityChecker?: 'ufixit';
  needsD1?: true;
  needsR2?: true;
  needsConfirmSecret?: true;
  diagnostics?: true;
}

export type ToolOutput = string | Record<string, unknown>;

export interface ToolDef<P extends ParamSpecs = ParamSpecs> {
  name: string;
  title: string;
  /** Upstream docstring, verbatim unless a parameter was removed or redesigned. */
  description: string;
  /** Upstream module the tool is ported from, e.g. "courses". */
  module: string;
  role: ToolRole;
  effect: Effect;
  gate?: ToolGate;
  params: P;
  annotations: ToolAnnotations;
  budget: { tier: BudgetTier; requests?: number };
  /** Whether output carries Canvas-authored text and how it is handled. */
  fencing: 'fenced' | 'safe';
  /** May call Canvas with anonymization off. Pinned by test to a fixed set of tools. */
  rawAccess?: true;
  handler(args: InferArgs<P>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  module: string;
  role: ToolRole;
  effect: Effect;
}

/** Everything a tool handler may touch. No env, no token, no secrets. */
export interface ToolContext {
  requestId: string;
  /** Epoch ms after which the handler must stop starting new work. */
  deadline: number;
  config: Config;
  identity: Identity;
  canvas: CanvasClient;
  log: Logger;
  /** Tools registered for this request (for search_canvas_tools). */
  registeredTools: ReadonlyArray<ToolSummary>;
  /** Spike probes; present only for tools gated on `diagnostics`. */
  diagnostics?: DiagnosticsAccess;
  /** Which protocol era carried this call, when the backend knows it. */
  protocolEra?: 'legacy' | 'modern';
}

export interface ProbeOutcome {
  attempted: number;
  succeeded: number;
  firstError?: string;
}

/**
 * What the Milestone 0 diagnostics tools may learn about the request and the
 * runtime. Implemented by the app layer. Nothing here returns a header value,
 * a secret or a binding object.
 */
export interface DiagnosticsAccess {
  headerSummary(): Array<{ name: string; length: number; sha256_8: string }>;
  authorizationShape(): { present: boolean; scheme?: string; segments?: number; jwtIss?: string; jwtAud?: string };
  bindingNames(): string[];
  ctxPropKeys(): string[];
  probeFetch(count: number): Promise<ProbeOutcome>;
  probeD1(count: number): Promise<ProbeOutcome>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
