// Ports the applicable cases of canvas-mcp tests/core/test_config.py, plus the fail-closed rules this port adds.
import { describe, expect, it } from 'vitest';
import {
  STUDENT_WRITE_TOOL_NAMES,
  normalizeCanvasUrl,
  parseConfig,
  parseSecrets,
  secretValuesForRedaction,
} from '../../src/env';
import type { Config, Env } from '../../src/types';

const TOKEN = '7~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz01';
const CONFIRMATION = 'confirmation-secret-0123456789-abcdefghij';
const SALT = 'pseudonym-salt-0123456789';

/** A complete owner-mode deployment. */
function ownerEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    CANVAS_API_URL: 'https://canvas.school.edu',
    CANVAS_API_TOKEN: TOKEN,
    OWNER_EMAIL: 'owner@school.edu',
    CONFIRMATION_SECRET: CONFIRMATION,
    ...overrides,
  };
}

function codes(config: Config): string[] {
  return config.errors.map((error) => error.code);
}

function errorFor(config: Config, code: string) {
  const found = config.errors.find((error) => error.code === code);
  if (found === undefined) throw new Error(`no ${code} error; got ${JSON.stringify(codes(config))}`);
  return found;
}

function allMessages(config: Config): string {
  return [...config.errors.map((error) => error.message), ...config.warnings].join('\n');
}

describe('defaults', () => {
  it('parses a complete owner deployment without errors or warnings', () => {
    const config = parseConfig(ownerEnv());
    expect(config.errors).toEqual([]);
    expect(config.warnings).toEqual([]);
    expect(config).toMatchObject({
      authMode: 'owner',
      canvasApiUrl: 'https://canvas.school.edu/api/v1',
      canvasOrigin: 'https://canvas.school.edu',
      hasCanvasToken: true,
      ownerEmail: 'owner@school.edu',
      ownerUserIdSha256: null,
      hasConfirmationSecret: true,
      hasPseudonymSalt: false,
    });
  });

  it('uses the documented default for every variable', () => {
    const config = parseConfig(ownerEnv());
    expect(config).toMatchObject({
      serverName: 'canvas-api',
      mcpPath: '/mcp',
      mcpBackend: 'sdk',
      role: 'student',
      allowedWriteToolsRaw: null,
      studentWriteTools: [],
      coursePolicy: { enabled: true, defaultPosture: 'deny', allowTtlSeconds: 30, denyTtlSeconds: 300 },
      accessibilityCheckers: ['ufixit'],
      disabledTools: [],
      anonymizationEnabled: true,
      logRedactPii: true,
      logAccessEvents: true,
      logLevel: 'info',
      auditToD1: true,
      timezone: 'UTC',
      institutionName: '',
      apiTimeoutMs: 15_000,
      maxConcurrentRequests: 3,
      readFileMaxBytes: 5 * 1024 * 1024,
      requestBudget: 40,
      maxPages: 10,
      toolDeadlineMs: 25_000,
      maxToolResultBytes: 200_000,
      maxRequestBytes: 1_048_576,
      maxUploadBytes: 5 * 1024 * 1024,
      maxBulkItems: 20,
      allowedHosts: [],
      diagnosticsEnabled: false,
      exportsEnabled: false,
      dbBootstrap: true,
    });
  });

  it('enables anonymization by default', () => {
    // FERPA anonymization is opt-out, never opt-in.
    expect(parseConfig({}).anonymizationEnabled).toBe(true);
    expect(parseConfig({}).logRedactPii).toBe(true);
  });

  it('is read-only by default', () => {
    expect(parseConfig(ownerEnv()).allowedWriteToolsRaw).toBeNull();
  });

  it('never puts a secret value on the config', () => {
    const config = parseConfig(ownerEnv({ PSEUDONYM_SALT: SALT }));
    const text = JSON.stringify(config);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CONFIRMATION);
    expect(text).not.toContain(SALT);
  });

  it('has no switch that lets a request through without an identity', () => {
    const config = parseConfig(
      ownerEnv({
        ALLOW_PLATFORM_TRUST: 'true',
        MCP_ALLOW_UNAUTHENTICATED: 'true',
        OWNER_GATE: 'observe',
        DISCOVERY_REQUIRES_OWNER: 'false',
      }),
    );
    expect(config).toEqual(parseConfig(ownerEnv()));
    expect(Object.keys(config).filter((key) => /trust|unauth|observe|gate/i.test(key))).toEqual([]);
  });
});

describe('purity', () => {
  it('rebuilds from the env it is given, with nothing cached between calls', () => {
    expect(parseConfig(ownerEnv({ MCP_SERVER_NAME: 'before' })).serverName).toBe('before');
    expect(parseConfig(ownerEnv({ MCP_SERVER_NAME: 'after' })).serverName).toBe('after');
  });

  it('does not carry an invalid-number warning into the next parse', () => {
    const bad = parseConfig(ownerEnv({ API_TIMEOUT: 'not-an-int' }));
    expect(bad.warnings).toEqual(["API_TIMEOUT expects an integer; using default value (got 'not-an-int')"]);
    expect(bad.apiTimeoutMs).toBe(15_000);
    const good = parseConfig(ownerEnv({ API_TIMEOUT: '45' }));
    expect(good.warnings).toEqual([]);
    expect(good.apiTimeoutMs).toBe(45_000);
  });

  it('returns independent objects and does not touch the env', () => {
    const env = ownerEnv({ STUDENT_WRITE_TOOLS: 'submit_assignment' });
    const snapshot = JSON.stringify(env);
    const first = parseConfig(env);
    const second = parseConfig(env);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.studentWriteTools.push('mutated');
    first.errors.push({ code: 'x', message: 'x', blocks: 'request' });
    expect(parseConfig(env).studentWriteTools).toEqual(['submit_assignment']);
    expect(parseConfig(env).errors).toEqual([]);
    expect(JSON.stringify(env)).toBe(snapshot);
  });

  it('ignores bindings and other non-text values', () => {
    const config = parseConfig(ownerEnv({ DB: {}, FILES: {}, MCP_SERVER_NAME: { nested: true }, API_TIMEOUT: 20 }));
    expect(config.serverName).toBe('canvas-api');
    expect(config.apiTimeoutMs).toBe(20_000);
    expect(config.errors).toEqual([]);
  });
});

describe('CANVAS_API_URL normalization', () => {
  it.each([
    // Base host (the common footgun) gets the suffix appended.
    ['https://canvas.school.edu', 'https://canvas.school.edu/api/v1'],
    // Trailing slash is stripped before appending.
    ['https://canvas.school.edu/', 'https://canvas.school.edu/api/v1'],
    // Already-canonical form is unchanged.
    ['https://canvas.school.edu/api/v1', 'https://canvas.school.edu/api/v1'],
    // Canonical form with a trailing slash is normalized.
    ['https://canvas.school.edu/api/v1/', 'https://canvas.school.edu/api/v1'],
    // Surrounding whitespace is trimmed.
    ['  https://canvas.school.edu/api/v1  ', 'https://canvas.school.edu/api/v1'],
    // A stray query string is dropped before normalization (not duplicated).
    ['https://canvas.school.edu?x=1', 'https://canvas.school.edu/api/v1'],
    ['https://canvas.school.edu/api/v1?x=1', 'https://canvas.school.edu/api/v1'],
    // A stray fragment is dropped too.
    ['https://canvas.school.edu/api/v1#frag', 'https://canvas.school.edu/api/v1'],
    // Over-specified path (copied from a browser) is truncated, not double-appended.
    ['https://canvas.school.edu/api/v1/courses', 'https://canvas.school.edu/api/v1'],
    // Alternate Canvas API roots are not inferred from CANVAS_API_URL.
    ['https://canvas.school.edu/api/quiz/v1', 'https://canvas.school.edu/api/v1'],
    // An explicit version segment is preserved, and trailing sub-paths after it are dropped.
    ['https://canvas.school.edu/api/v2', 'https://canvas.school.edu/api/v2'],
    ['https://canvas.school.edu/api/v2/foo', 'https://canvas.school.edu/api/v2'],
    ['https://canvas.school.edu/api/v10', 'https://canvas.school.edu/api/v10'],
    // A version must end at a segment boundary.
    ['https://canvas.school.edu/api/v1x', 'https://canvas.school.edu/api/v1'],
    // A Canvas install under a sub-path keeps that prefix.
    ['https://canvas.school.edu/lms/api/v1', 'https://canvas.school.edu/lms/api/v1'],
    // The default port is the same origin.
    ['https://canvas.school.edu:443', 'https://canvas.school.edu/api/v1'],
    ['https://canvas.school.edu:443/api/v1/', 'https://canvas.school.edu/api/v1'],
    // Scheme and host are case-insensitive.
    ['HTTPS://Canvas.School.EDU/api/v1', 'https://canvas.school.edu/api/v1'],
  ])('normalizes %j to %j', (raw, expected) => {
    const outcome = normalizeCanvasUrl(raw);
    expect(outcome.error).toBeNull();
    expect(outcome.apiUrl).toBe(expected);
    expect(outcome.origin).toBe('https://canvas.school.edu');
  });

  it.each(['', '   '])('treats the blank value %j as unset, not as invalid', (raw) => {
    expect(normalizeCanvasUrl(raw)).toEqual({ apiUrl: null, origin: null, error: null });
  });

  it('normalizes the value from the environment on parse', () => {
    const config = parseConfig(ownerEnv({ CANVAS_API_URL: 'https://canvas.school.edu' }));
    expect(config.canvasApiUrl).toBe('https://canvas.school.edu/api/v1');
    expect(config.canvasOrigin).toBe('https://canvas.school.edu');
  });

  it('produces a base path the URL parser leaves unchanged', () => {
    for (const raw of ['https://canvas.school.edu/a/../lms/./api/v1/x', 'https://canvas.school.edu/l%6Ds/api/v1']) {
      const outcome = normalizeCanvasUrl(raw);
      expect(outcome.error).toBeNull();
      expect(new URL(outcome.apiUrl as string).href).toBe(outcome.apiUrl);
    }
    expect(normalizeCanvasUrl('https://canvas.school.edu/api/v1/../v2').apiUrl).toBe('https://canvas.school.edu/api/v2');
  });
});

describe('CANVAS_API_URL refusals', () => {
  function refused(raw: string) {
    const config = parseConfig(ownerEnv({ CANVAS_API_URL: raw }));
    expect(config.canvasApiUrl).toBeNull();
    expect(config.canvasOrigin).toBeNull();
    const error = errorFor(config, 'canvas_url_invalid');
    expect(error.blocks).toBe('request');
    // An invalid value is reported once, not also as "missing".
    expect(codes(config)).not.toContain('canvas_url_missing');
    return error.message;
  }

  it('names the missing scheme', () => {
    // Scheme-less: the defect is the missing scheme, not a missing host.
    expect(refused('canvas.school.edu')).toContain("should start with 'https://'");
    expect(refused('ftp://canvas.school.edu')).toContain("should start with 'https://'");
    expect(refused('https:/canvas.school.edu')).toContain("should start with 'https://'");
  });

  it('names the missing hostname', () => {
    // Triple-slash (scheme present, empty host).
    expect(refused('https:///canvas.school.edu')).toContain('missing a hostname');
    expect(refused('https://')).toContain('missing a hostname');
  });

  it('refuses cleartext http, with no loopback escape hatch', () => {
    // The Canvas token is sent on every request, so a cleartext origin puts it on the wire.
    expect(refused('http://canvas.school.edu')).toContain(
      "CANVAS_API_URL must use 'https://'. The Canvas API token is sent on every request, " +
        'so a cleartext URL exposes it on the network.',
    );
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const config = parseConfig(ownerEnv({ CANVAS_API_URL: url, CANVAS_ALLOW_INSECURE_HTTP: 'true' }));
      expect(config.canvasApiUrl).toBeNull();
      expect(codes(config)).toContain('canvas_url_invalid');
    }
  });

  it('refuses userinfo', () => {
    expect(refused('https://user:pass@canvas.school.edu')).toContain('must not contain a username or password');
    expect(refused('https://user@canvas.school.edu')).toContain('must not contain a username or password');
    expect(refused('https://@canvas.school.edu')).toContain('must not contain a username or password');
  });

  it('refuses a port other than 443 (deviation: upstream preserves host:port)', () => {
    expect(refused('https://canvas.school.edu:8443')).toContain('must not name a port other than 443');
    expect(refused('https://canvas.school.edu:80/api/v1')).toContain('must not name a port other than 443');
  });

  it.each([
    'https://127.0.0.1',
    'https://10.1.2.3/api/v1',
    'https://[::1]',
    'https://[2001:db8::1]/api/v1',
    'https://2130706433', // decimal form of 127.0.0.1
    'https://0x7f.1', // hex and short forms
    'https://017700000001',
  ])('refuses the IP-literal host in %j', (raw) => {
    expect(refused(raw)).toContain('must name a host, not an IP address');
  });

  it.each(['https://localhost', 'https://canvas', 'https://canvas_lms.school.edu', 'https://-canvas.school.edu'])(
    'refuses %j, which is not a fully qualified DNS name',
    (raw) => {
      expect(refused(raw)).toContain('must name a fully qualified host such as canvas.school.edu');
    },
  );

  it('accepts an internationalized host name in its ASCII form', () => {
    expect(normalizeCanvasUrl('https://bücher.example/api/v1').apiUrl).toBe('https://xn--bcher-kva.example/api/v1');
  });

  it('strips a trailing dot from the host, so the origin matches the links Canvas writes', () => {
    expect(normalizeCanvasUrl('https://canvas.school.edu./')).toEqual({
      apiUrl: 'https://canvas.school.edu/api/v1',
      origin: 'https://canvas.school.edu',
      error: null,
    });
    expect(normalizeCanvasUrl('https://CANVAS.School.edu.:443/api/v1/courses').apiUrl).toBe(
      'https://canvas.school.edu/api/v1',
    );
    const config = parseConfig(ownerEnv({ CANVAS_API_URL: 'https://canvas.school.edu.' }));
    expect(config.errors).toEqual([]);
    expect(config.canvasApiUrl).toBe('https://canvas.school.edu/api/v1');
    expect(config.canvasOrigin).toBe('https://canvas.school.edu');
  });

  it('refuses a host that ends in more than one dot', () => {
    refused('https://canvas.school.edu../api/v1');
  });

  it.each([
    'https://canvas.school.edu\\@evil.example',
    'https://canvas.school.edu/api v1',
    'https://canvas.\tschool.edu',
    'https://canvas.school.edu\n.evil.example',
    'https:\\\\canvas.school.edu',
  ])('refuses %j, which a URL parser would silently repair', (raw) => {
    refused(raw);
  });

  it('refuses a host the URL parser rejects', () => {
    expect(refused('https://canvas school')).toBeTruthy();
    expect(refused('https://exa<mple.edu')).toContain('not a valid URL');
    expect(refused('https://canvas.school.edu:notaport')).toContain('not a valid URL');
  });

  it('shows only the scheme and host of a rejected value', () => {
    expect(refused('http://canvas.school.edu/api/v1?access_token=SECRETVALUE')).toContain(
      'Configured value: scheme and host http://canvas.school.edu.',
    );
    const withUserinfo = refused(`https://owner:${TOKEN}@canvas.school.edu/path/SECRETPATH?q=SECRETQUERY#SECRETFRAG`);
    expect(withUserinfo).toContain('Configured value: scheme and host https://canvas.school.edu.');
    for (const secret of [TOKEN, 'owner', 'SECRETPATH', 'SECRETQUERY', 'SECRETFRAG']) {
      expect(withUserinfo).not.toContain(secret);
    }
    expect(refused('https://canvas.school.edu:8443/SECRETPATH')).not.toContain('SECRETPATH');
  });

  it('shows only the length of a value that does not parse', () => {
    expect(refused('canvas.school.edu')).toContain('Configured value: unparseable (length 17).');
    expect(refused(TOKEN)).toContain(`Configured value: unparseable (length ${TOKEN.length}).`);
  });

  it('never echoes a token pasted into CANVAS_API_URL, wherever it lands', () => {
    const pasted = [
      TOKEN,
      `https://${TOKEN}`,
      `http://${TOKEN}`,
      `https://${TOKEN}/api/v1`,
      `https://${TOKEN}@canvas.school.edu`,
      `http://canvas.school.edu/?access_token=${TOKEN}`,
      `http://canvas.school.edu/${TOKEN}`,
      `https://canvas.school.edu:8443/#${TOKEN}`,
      `Bearer ${TOKEN}`,
      `https://canvas.school.edu ${TOKEN}`,
    ];
    for (const raw of pasted) {
      const config = parseConfig(ownerEnv({ CANVAS_API_URL: raw }));
      const text = `${allMessages(config)}\n${JSON.stringify(config)}`;
      expect(text, raw.replace(TOKEN, '<token>')).not.toContain(TOKEN);
      expect(text.toLowerCase(), raw.replace(TOKEN, '<token>')).not.toContain(TOKEN.toLowerCase());
      expect(text).not.toContain(TOKEN.slice(2, 20));
      expect(config.canvasApiUrl).toBeNull();
    }
  });

  it('drops a token that sits in the path or query of an otherwise valid URL', () => {
    const config = parseConfig(ownerEnv({ CANVAS_API_URL: `https://canvas.school.edu/api/v1/x?access_token=${TOKEN}` }));
    expect(config.errors).toEqual([]);
    expect(config.canvasApiUrl).toBe('https://canvas.school.edu/api/v1');
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });
});

describe('booleans', () => {
  it.each(['true', 'TRUE', 'True', ' true '])('reads %j as true', (text) => {
    const config = parseConfig(ownerEnv({ EXPORTS_ENABLED: text, ENABLE_DATA_ANONYMIZATION: text }));
    expect(config.exportsEnabled).toBe(true);
    expect(config.anonymizationEnabled).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  it('reads "false" as false without a warning', () => {
    const config = parseConfig(ownerEnv({ ENABLE_DATA_ANONYMIZATION: 'false', DB_BOOTSTRAP: 'FALSE' }));
    expect(config.anonymizationEnabled).toBe(false);
    expect(config.dbBootstrap).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it.each(['yes', '1', 'on', 'y', 'enabled', 'truee'])('reads %j as false, as upstream does, and says so', (text) => {
    const config = parseConfig(ownerEnv({ EXPORTS_ENABLED: text, LOG_ACCESS_EVENTS: text }));
    expect(config.exportsEnabled).toBe(false);
    expect(config.logAccessEvents).toBe(false);
    expect(config.errors).toEqual([]);
    expect(config.warnings).toContain(`EXPORTS_ENABLED expects 'true' or 'false'; treating it as false (got '${text}')`);
    expect(config.warnings).toContain(`LOG_ACCESS_EVENTS expects 'true' or 'false'; treating it as false (got '${text}')`);
  });

  // Deviation from upstream, which reads these as false and so switches the protection off.
  it.each(['yes', '1', 'on', 'y', 'enabled', 'truee', 'flase', '0', 'no'])(
    'refuses every request when a privacy flag is %j, and leaves the protection on',
    (text) => {
      const config = parseConfig(ownerEnv({ ENABLE_DATA_ANONYMIZATION: text, LOG_REDACT_PII: text }));
      expect(config.anonymizationEnabled).toBe(true);
      expect(config.logRedactPii).toBe(true);
      expect(config.errors).toEqual([
        {
          code: 'enable_data_anonymization_invalid',
          message: `ENABLE_DATA_ANONYMIZATION expects 'true' or 'false' (got '${text}')`,
          blocks: 'request',
        },
        {
          code: 'log_redact_pii_invalid',
          message: `LOG_REDACT_PII expects 'true' or 'false' (got '${text}')`,
          blocks: 'request',
        },
      ]);
      expect(config.warnings).toEqual([]);
    },
  );

  it('judges each privacy flag on its own', () => {
    const config = parseConfig(ownerEnv({ ENABLE_DATA_ANONYMIZATION: 'false', LOG_REDACT_PII: 'yes' }));
    expect(config.anonymizationEnabled).toBe(false);
    expect(config.logRedactPii).toBe(true);
    expect(codes(config)).toEqual(['log_redact_pii_invalid']);
  });

  it('never echoes a long value given to a privacy flag', () => {
    const config = parseConfig(ownerEnv({ ENABLE_DATA_ANONYMIZATION: TOKEN }));
    expect(errorFor(config, 'enable_data_anonymization_invalid').message).toBe(
      `ENABLE_DATA_ANONYMIZATION expects 'true' or 'false' (got <${TOKEN.length} characters>)`,
    );
  });

  it('treats a blank value as unset, so a cleared privacy flag keeps its safe default', () => {
    const config = parseConfig(
      ownerEnv({ ENABLE_DATA_ANONYMIZATION: '', LOG_REDACT_PII: '   ', DIAGNOSTICS_ENABLED: '', EXPORTS_ENABLED: ' ' }),
    );
    expect(config.anonymizationEnabled).toBe(true);
    expect(config.logRedactPii).toBe(true);
    expect(config.diagnosticsEnabled).toBe(false);
    expect(config.exportsEnabled).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it('accepts a real boolean from a JSON-typed variable', () => {
    expect(parseConfig(ownerEnv({ EXPORTS_ENABLED: true })).exportsEnabled).toBe(true);
    expect(parseConfig(ownerEnv({ ENABLE_DATA_ANONYMIZATION: false })).anonymizationEnabled).toBe(false);
  });

  it('parses every boolean variable', () => {
    const off = parseConfig(
      ownerEnv({
        COURSE_AGENT_POLICY_ENABLED: 'false',
        ENABLE_DATA_ANONYMIZATION: 'false',
        LOG_REDACT_PII: 'false',
        LOG_ACCESS_EVENTS: 'false',
        AUDIT_TO_D1: 'false',
        DB_BOOTSTRAP: 'false',
        EXPORTS_ENABLED: 'true',
      }),
    );
    expect(off).toMatchObject({
      coursePolicy: { enabled: false },
      anonymizationEnabled: false,
      logRedactPii: false,
      logAccessEvents: false,
      auditToD1: false,
      dbBootstrap: false,
      exportsEnabled: true,
    });
  });
});

describe('numbers', () => {
  it('parses every numeric variable', () => {
    const config = parseConfig(
      ownerEnv({
        API_TIMEOUT: '20',
        MAX_CONCURRENT_REQUESTS: '2',
        READ_FILE_MAX_SIZE_MB: '2.5',
        CANVAS_REQUEST_BUDGET: '60',
        CANVAS_MAX_PAGES: '4',
        TOOL_DEADLINE_MS: '20000',
        MAX_TOOL_RESULT_BYTES: '100000',
        MAX_REQUEST_BYTES: '8388608',
        MAX_UPLOAD_MB: '1',
        MAX_BULK_ITEMS: '10',
        COURSE_AGENT_POLICY_ALLOW_TTL: '0',
        COURSE_AGENT_POLICY_DENY_TTL: '600',
      }),
    );
    expect(config.warnings).toEqual([]);
    expect(config).toMatchObject({
      apiTimeoutMs: 20_000,
      maxConcurrentRequests: 2,
      readFileMaxBytes: 2_621_440,
      requestBudget: 60,
      maxPages: 4,
      toolDeadlineMs: 20_000,
      maxToolResultBytes: 100_000,
      maxRequestBytes: 8_388_608,
      maxUploadBytes: 1_048_576,
      maxBulkItems: 10,
      coursePolicy: { allowTtlSeconds: 0, denyTtlSeconds: 600 },
    });
  });

  it.each(['abc', '12.5', '1e3', '0x10', '1_000', '12 34', '99999999999999999999'])(
    'falls back to the default for the invalid integer %j, with a warning',
    (text) => {
      const config = parseConfig(ownerEnv({ CANVAS_MAX_PAGES: text }));
      expect(config.maxPages).toBe(10);
      expect(config.warnings).toEqual([`CANVAS_MAX_PAGES expects an integer; using default value (got '${text}')`]);
      expect(config.errors).toEqual([]);
    },
  );

  it('falls back to the default for a blank number without a warning', () => {
    const config = parseConfig(ownerEnv({ API_TIMEOUT: '', CANVAS_MAX_PAGES: '   ', READ_FILE_MAX_SIZE_MB: '' }));
    expect(config).toMatchObject({ apiTimeoutMs: 15_000, maxPages: 10, readFileMaxBytes: 5 * 1024 * 1024 });
    expect(config.warnings).toEqual([]);
  });

  it.each(['0', '-1', 'abc', 'inf', 'nan', 'Infinity'])(
    'falls back to the default for the invalid size %j, with a warning',
    (text) => {
      const config = parseConfig(ownerEnv({ READ_FILE_MAX_SIZE_MB: text, MAX_UPLOAD_MB: text }));
      expect(config.readFileMaxBytes).toBe(5 * 1024 * 1024);
      expect(config.maxUploadBytes).toBe(5 * 1024 * 1024);
      expect(config.warnings).toEqual([
        `READ_FILE_MAX_SIZE_MB expects a positive number; using default value (got '${text}')`,
        `MAX_UPLOAD_MB expects a positive number; using default value (got '${text}')`,
      ]);
    },
  );

  it('refuses zero and negative values where a positive integer is needed', () => {
    for (const name of [
      'API_TIMEOUT',
      'CANVAS_MAX_PAGES',
      'TOOL_DEADLINE_MS',
      'MAX_TOOL_RESULT_BYTES',
      'MAX_REQUEST_BYTES',
      'MAX_BULK_ITEMS',
    ]) {
      for (const text of ['0', '-5']) {
        const config = parseConfig(ownerEnv({ [name]: text }));
        expect(config).toMatchObject(parseConfigNumbers(ownerEnv()));
        expect(config.warnings).toEqual([`${name} expects an integer of at least 1; using default value (got '${text}')`]);
      }
    }
    const ttl = parseConfig(ownerEnv({ COURSE_AGENT_POLICY_DENY_TTL: '-1' }));
    expect(ttl.coursePolicy.denyTtlSeconds).toBe(300);
    expect(ttl.warnings).toHaveLength(1);
  });

  it.each([
    ['MAX_CONCURRENT_REQUESTS', '10', 4, 'maxConcurrentRequests', 1, 4],
    ['MAX_CONCURRENT_REQUESTS', '0', 1, 'maxConcurrentRequests', 1, 4],
    ['MAX_CONCURRENT_REQUESTS', '-3', 1, 'maxConcurrentRequests', 1, 4],
    ['CANVAS_REQUEST_BUDGET', '1000', 200, 'requestBudget', 5, 200],
    ['CANVAS_REQUEST_BUDGET', '1', 5, 'requestBudget', 5, 200],
  ] as const)('clamps %s=%s to %i', (name, text, expected, field, low, high) => {
    const config = parseConfig(ownerEnv({ [name]: text }));
    expect(config[field]).toBe(expected);
    expect(config.warnings).toEqual([`${name} must be between ${low} and ${high}; using ${expected} (got '${text}')`]);
  });

  it.each([
    ['MAX_CONCURRENT_REQUESTS', '1', 'maxConcurrentRequests', 1],
    ['MAX_CONCURRENT_REQUESTS', '4', 'maxConcurrentRequests', 4],
    ['CANVAS_REQUEST_BUDGET', '5', 'requestBudget', 5],
    ['CANVAS_REQUEST_BUDGET', '200', 'requestBudget', 200],
  ] as const)('accepts the bound %s=%s', (name, text, field, expected) => {
    const config = parseConfig(ownerEnv({ [name]: text }));
    expect(config[field]).toBe(expected);
    expect(config.warnings).toEqual([]);
  });

  it('refuses to run when a tool call could outlive a submission claim', () => {
    const config = parseConfig(ownerEnv({ TOOL_DEADLINE_MS: '290000', API_TIMEOUT: '10' }));
    expect(errorFor(config, 'runtime_bound_exceeded').blocks).toBe('request');
    expect(codes(parseConfig(ownerEnv({ TOOL_DEADLINE_MS: '289999', API_TIMEOUT: '10' })))).toEqual([]);
    expect(codes(parseConfig(ownerEnv({ API_TIMEOUT: '600' })))).toEqual(['runtime_bound_exceeded']);
  });

  function parseConfigNumbers(env: Env) {
    const config = parseConfig(env);
    return {
      apiTimeoutMs: config.apiTimeoutMs,
      maxPages: config.maxPages,
      toolDeadlineMs: config.toolDeadlineMs,
      maxToolResultBytes: config.maxToolResultBytes,
      maxRequestBytes: config.maxRequestBytes,
      maxBulkItems: config.maxBulkItems,
    };
  }
});

describe('owner identity', () => {
  it('lowercases and trims OWNER_EMAIL', () => {
    expect(parseConfig(ownerEnv({ OWNER_EMAIL: '  Owner.Name@School.EDU \n' })).ownerEmail).toBe(
      'owner.name@school.edu',
    );
  });

  it.each([
    'owner@school.edu, attacker@evil.example',
    'owner@school.edu,attacker@evil.example',
    'owner @school.edu',
    'owner\t@school.edu',
    'öwner@school.edu',
    'owner@school.edu\u0000',
    'owner@sсhool.edu', // Cyrillic "с"
  ])('refuses the OWNER_EMAIL %j', (email) => {
    const config = parseConfig(ownerEnv({ OWNER_EMAIL: email }));
    expect(config.ownerEmail).toBeNull();
    const error = errorFor(config, 'owner_email_invalid');
    expect(error.blocks).toBe('request');
    expect(error.message).toBe(`OWNER_EMAIL must be ASCII with no whitespace or comma (length ${email.length})`);
    expect(codes(config)).not.toContain('owner_email_missing');
  });

  it('accepts a 64-hex OWNER_USER_ID_SHA256 and lowercases it', () => {
    const hash = 'AB'.repeat(32);
    const config = parseConfig(ownerEnv({ OWNER_USER_ID_SHA256: hash }));
    expect(config.ownerUserIdSha256).toBe(hash.toLowerCase());
    expect(config.errors).toEqual([]);
  });

  it('leaves OWNER_USER_ID_SHA256 null when unset or blank', () => {
    expect(parseConfig(ownerEnv()).ownerUserIdSha256).toBeNull();
    expect(parseConfig(ownerEnv({ OWNER_USER_ID_SHA256: '  ' })).ownerUserIdSha256).toBeNull();
    expect(parseConfig(ownerEnv({ OWNER_USER_ID_SHA256: '  ' })).errors).toEqual([]);
  });

  it.each(['abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'user-1234'])(
    'refuses the OWNER_USER_ID_SHA256 %j rather than dropping the check',
    (hash) => {
      const config = parseConfig(ownerEnv({ OWNER_USER_ID_SHA256: hash }));
      expect(config.ownerUserIdSha256).toBeNull();
      const error = errorFor(config, 'owner_user_id_sha256_invalid');
      expect(error.blocks).toBe('request');
      expect(error.message).not.toContain(hash);
    },
  );
});

describe('secrets', () => {
  it('returns the secrets and nothing else', () => {
    expect(parseSecrets(ownerEnv({ PSEUDONYM_SALT: SALT }))).toEqual({
      canvasToken: TOKEN,
      confirmationSecret: CONFIRMATION,
      pseudonymSalt: SALT,
    });
  });

  it('returns null for every secret that is unset, blank or not text', () => {
    const none = { canvasToken: null, confirmationSecret: null, pseudonymSalt: null };
    expect(parseSecrets({})).toEqual(none);
    expect(parseSecrets({ CANVAS_API_TOKEN: '', CONFIRMATION_SECRET: '   ', PSEUDONYM_SALT: '' })).toEqual(none);
    expect(parseSecrets({ CANVAS_API_TOKEN: 12345, CONFIRMATION_SECRET: {}, PSEUDONYM_SALT: true })).toEqual(none);
  });

  it('trims a secret pasted with a trailing line break', () => {
    expect(parseSecrets({ CANVAS_API_TOKEN: `${TOKEN}\n` }).canvasToken).toBe(TOKEN);
    expect(parseConfig(ownerEnv({ CANVAS_API_TOKEN: ` ${TOKEN}\r\n` })).errors).toEqual([]);
  });

  it('treats a short CONFIRMATION_SECRET as missing, with a warning that does not echo it', () => {
    const short = 'only-31-characters-long-abcdefg';
    expect(short).toHaveLength(31);
    const env = ownerEnv({ CONFIRMATION_SECRET: short });
    const config = parseConfig(env);
    expect(config.hasConfirmationSecret).toBe(false);
    expect(config.errors).toEqual([]);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('CONFIRMATION_SECRET must be at least 32 characters');
    expect(config.warnings[0]).toContain('(length 31)');
    expect(config.warnings[0]).not.toContain(short);
    expect(parseSecrets(env).confirmationSecret).toBeNull();
  });

  it('accepts a CONFIRMATION_SECRET of exactly 32 characters', () => {
    const env = ownerEnv({ CONFIRMATION_SECRET: 'x'.repeat(32) });
    expect(parseConfig(env).hasConfirmationSecret).toBe(true);
    expect(parseConfig(env).warnings).toEqual([]);
    expect(parseSecrets(env).confirmationSecret).toBe('x'.repeat(32));
  });

  it('runs without a CONFIRMATION_SECRET (guarded tools are simply not registered)', () => {
    const config = parseConfig(ownerEnv({ CONFIRMATION_SECRET: undefined }));
    expect(config.hasConfirmationSecret).toBe(false);
    expect(config.errors).toEqual([]);
    expect(config.warnings).toEqual([]);
  });

  it('refuses a token that could not be sent in a header, and does not release it', () => {
    for (const token of ['abc def', 'abc\ndef', 'tökén-with-non-ascii', 'abc\u0000def']) {
      const env = ownerEnv({ CANVAS_API_TOKEN: token });
      const config = parseConfig(env);
      expect(config.hasCanvasToken).toBe(false);
      const error = errorFor(config, 'canvas_token_invalid');
      expect(error.blocks).toBe('request');
      expect(error.message).not.toContain(token);
      expect(codes(config)).not.toContain('canvas_token_missing');
      expect(parseSecrets(env).canvasToken).toBeNull();
    }
  });

  it('agrees with parseConfig about which secrets are present', () => {
    const envs: Env[] = [
      {},
      ownerEnv(),
      ownerEnv({ CONFIRMATION_SECRET: 'short' }),
      ownerEnv({ CANVAS_API_TOKEN: 'bad token' }),
      ownerEnv({ PSEUDONYM_SALT: SALT, CANVAS_API_TOKEN: '' }),
    ];
    for (const env of envs) {
      const config = parseConfig(env);
      const secrets = parseSecrets(env);
      expect(config.hasCanvasToken).toBe(secrets.canvasToken !== null);
      expect(config.hasConfirmationSecret).toBe(secrets.confirmationSecret !== null);
      expect(config.hasPseudonymSalt).toBe(secrets.pseudonymSalt !== null);
    }
  });

  it('lists every secret-class value for redaction, including ones it rejects', () => {
    expect(secretValuesForRedaction(ownerEnv({ PSEUDONYM_SALT: SALT }))).toEqual([TOKEN, CONFIRMATION, SALT]);
    expect(secretValuesForRedaction(ownerEnv({ CONFIRMATION_SECRET: 'too-short-secret' }))).toEqual([
      TOKEN,
      'too-short-secret',
    ]);
    expect(secretValuesForRedaction(ownerEnv({ CANVAS_API_TOKEN: 'bad token value' }))).toContain('bad token value');
    expect(secretValuesForRedaction({ CANVAS_API_TOKEN: 'tiny', CONFIRMATION_SECRET: '' })).toEqual([]);
    expect(secretValuesForRedaction({})).toEqual([]);
  });

  it('never echoes a secret in any message, whatever is wrong with the configuration', () => {
    const envs: Env[] = [
      ownerEnv({ AUTH_MODE: 'per_user', PSEUDONYM_SALT: SALT }),
      ownerEnv({ DIAGNOSTICS_ENABLED: 'true', PSEUDONYM_SALT: SALT }),
      ownerEnv({ CONFIRMATION_SECRET: CONFIRMATION.slice(0, 20) }),
      ownerEnv({ CANVAS_API_TOKEN: `${TOKEN} ${TOKEN}` }),
      ownerEnv({ OWNER_EMAIL: `owner@school.edu, ${TOKEN}` }),
      ownerEnv({ OWNER_USER_ID_SHA256: TOKEN }),
      ownerEnv({ ALLOWED_WRITE_TOOLS: TOKEN }),
      ownerEnv({ STUDENT_WRITE_TOOLS: TOKEN, DISABLED_TOOLS: TOKEN, ACCESSIBILITY_CHECKERS: TOKEN }),
      ownerEnv({ AUTH_MODE: TOKEN, MCP_BACKEND: TOKEN, CANVAS_ROLE: TOKEN }),
      ownerEnv({ API_TIMEOUT: TOKEN, READ_FILE_MAX_SIZE_MB: TOKEN, MAX_CONCURRENT_REQUESTS: TOKEN }),
      ownerEnv({ LOG_LEVEL: TOKEN, TIMEZONE: TOKEN, MCP_PATH: TOKEN, COURSE_AGENT_POLICY_DEFAULT: TOKEN }),
      ownerEnv({ ENABLE_DATA_ANONYMIZATION: TOKEN, EXPORTS_ENABLED: TOKEN }),
    ];
    for (const env of envs) {
      const config = parseConfig(env);
      const text = allMessages(config);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(TOKEN);
      expect(text.toLowerCase()).not.toContain(TOKEN.toLowerCase());
      expect(text).not.toContain(CONFIRMATION.slice(0, 20));
      expect(text).not.toContain(SALT);
    }
  });
});

describe('fail-closed rules', () => {
  it('blocks invocation, not discovery, while owner mode is not fully configured', () => {
    const config = parseConfig({});
    expect(config.errors).toEqual([
      { code: 'canvas_url_missing', message: 'CANVAS_API_URL environment variable is required', blocks: 'invocation' },
      {
        code: 'canvas_token_missing',
        message: 'CANVAS_API_TOKEN environment variable is required',
        blocks: 'invocation',
      },
      { code: 'owner_email_missing', message: 'OWNER_EMAIL environment variable is required', blocks: 'invocation' },
    ]);
    expect(config).toMatchObject({ canvasApiUrl: null, hasCanvasToken: false, ownerEmail: null });
  });

  it.each([
    ['CANVAS_API_URL', 'canvas_url_missing'],
    ['CANVAS_API_TOKEN', 'canvas_token_missing'],
    ['OWNER_EMAIL', 'owner_email_missing'],
  ])('reports a missing %s on its own', (name, code) => {
    for (const blank of [undefined, '', '   ']) {
      const config = parseConfig(ownerEnv({ [name]: blank }));
      expect(codes(config)).toEqual([code]);
      expect(config.errors[0]?.blocks).toBe('invocation');
    }
  });

  it('does not accept OWNER_USER_ID_SHA256 in place of OWNER_EMAIL', () => {
    const config = parseConfig(ownerEnv({ OWNER_EMAIL: undefined, OWNER_USER_ID_SHA256: 'a'.repeat(64) }));
    expect(codes(config)).toEqual(['owner_email_missing']);
  });

  it('rejects the removed per_user mode without exposing configured credentials', () => {
    const config = parseConfig(ownerEnv({ AUTH_MODE: 'per_user' }));
    expect(config.authMode).toBe('owner');
    expect(codes(config)).toEqual(['auth_mode_invalid']);
    expect(config.errors[0]?.blocks).toBe('request');
    expect(allMessages(config)).not.toContain(TOKEN);
  });

  it('does not require a pseudonym salt for the single-owner deployment', () => {
    expect(parseConfig(ownerEnv({ PSEUDONYM_SALT: '' })).errors).toEqual([]);
  });

  it.each([
    ['AUTH_MODE', 'auth_mode_invalid', 'everyone', "AUTH_MODE must be owner or unset (got 'everyone')"],
    ['MCP_BACKEND', 'mcp_backend_invalid', 'fastmcp', "MCP_BACKEND should be one of sdk, native (got 'fastmcp')"],
    ['CANVAS_ROLE', 'canvas_role_invalid', 'admin', "CANVAS_ROLE should be one of student, educator, all (got 'admin')"],
  ])('refuses an unknown %s', (name, code, text, message) => {
    const config = parseConfig(ownerEnv({ [name]: text }));
    expect(config.errors).toEqual([{ code, message, blocks: 'request' }]);
  });

  it('falls back to the narrowest value while an unknown one is refused', () => {
    expect(parseConfig(ownerEnv({ CANVAS_ROLE: 'admin' })).role).toBe('student');
    expect(parseConfig(ownerEnv({ AUTH_MODE: 'everyone' })).authMode).toBe('owner');
    expect(parseConfig(ownerEnv({ MCP_BACKEND: 'fastmcp' })).mcpBackend).toBe('sdk');
  });

  it('accepts every valid mode value, case-insensitively', () => {
    expect(parseConfig(ownerEnv({ CANVAS_ROLE: 'Educator' })).role).toBe('educator');
    expect(parseConfig(ownerEnv({ CANVAS_ROLE: 'ALL' })).role).toBe('all');
    expect(parseConfig(ownerEnv({ CANVAS_ROLE: 'student' })).role).toBe('student');
    expect(parseConfig(ownerEnv({ MCP_BACKEND: 'native' })).mcpBackend).toBe('native');
    expect(parseConfig(ownerEnv({ MCP_BACKEND: 'SDK' })).mcpBackend).toBe('sdk');
    expect(parseConfig(ownerEnv({ AUTH_MODE: 'OWNER' })).errors).toEqual([]);
  });

  it('refuses an ALLOWED_WRITE_TOOLS value the policy rejects', () => {
    const cases: Array<[string, string]> = [
      ['send_convo', 'ALLOWED_WRITE_TOOLS names unknown tools: send_convo'],
      [
        'none,send_conversation',
        "ALLOWED_WRITE_TOOLS: 'none' cannot be combined with other entries (got: none, send_conversation)",
      ],
      [
        'list_courses',
        'ALLOWED_WRITE_TOOLS lists read-only tools, which are always available: list_courses. ' +
          'List only tools that change something.',
      ],
    ];
    for (const [raw, message] of cases) {
      const config = parseConfig(ownerEnv({ ALLOWED_WRITE_TOOLS: raw }));
      expect(config.errors).toEqual([{ code: 'allowed_write_tools_invalid', message, blocks: 'request' }]);
      expect(config.allowedWriteToolsRaw).toBe(raw);
    }
  });

  it('keeps a valid ALLOWED_WRITE_TOOLS value raw', () => {
    for (const raw of ['', '  ', 'none', 'all', 'send_conversation, update_page_settings']) {
      const config = parseConfig(ownerEnv({ ALLOWED_WRITE_TOOLS: raw }));
      expect(config.errors).toEqual([]);
      expect(config.allowedWriteToolsRaw).toBe(raw);
    }
  });

  it('refuses diagnostics on a deployment that holds a Canvas token or a confirmation secret', () => {
    const both = parseConfig(ownerEnv({ DIAGNOSTICS_ENABLED: 'true' }));
    expect(errorFor(both, 'diagnostics_with_credentials').blocks).toBe('request');

    const tokenOnly = parseConfig(ownerEnv({ DIAGNOSTICS_ENABLED: 'true', CONFIRMATION_SECRET: undefined }));
    expect(codes(tokenOnly)).toEqual(['diagnostics_with_credentials']);

    const secretOnly = parseConfig({ DIAGNOSTICS_ENABLED: 'TRUE', CONFIRMATION_SECRET: CONFIRMATION });
    expect(codes(secretOnly)).toContain('diagnostics_with_credentials');
  });

  it('counts a credential it rejects as still being held', () => {
    const shortSecret = parseConfig({ DIAGNOSTICS_ENABLED: 'true', CONFIRMATION_SECRET: 'short' });
    expect(shortSecret.hasConfirmationSecret).toBe(false);
    expect(codes(shortSecret)).toContain('diagnostics_with_credentials');

    const badToken = parseConfig({ DIAGNOSTICS_ENABLED: 'true', CANVAS_API_TOKEN: 'bad token' });
    expect(badToken.hasCanvasToken).toBe(false);
    expect(codes(badToken)).toContain('diagnostics_with_credentials');
  });

  it('allows diagnostics on a deployment with no credentials', () => {
    const config = parseConfig({ DIAGNOSTICS_ENABLED: 'true', OWNER_EMAIL: 'owner@school.edu' });
    expect(config.diagnosticsEnabled).toBe(true);
    expect(codes(config)).toEqual(['canvas_url_missing', 'canvas_token_missing']);
    expect(config.errors.every((error) => error.blocks === 'invocation')).toBe(true);
  });

  it('gives every error a code, a message and a block level', () => {
    const config = parseConfig({
      AUTH_MODE: 'nope',
      MCP_BACKEND: 'nope',
      CANVAS_ROLE: 'nope',
      CANVAS_API_URL: 'http://canvas.school.edu',
      CANVAS_API_TOKEN: 'bad token',
      OWNER_EMAIL: 'a, b',
      OWNER_USER_ID_SHA256: 'nope',
      ALLOWED_WRITE_TOOLS: 'nope',
      DIAGNOSTICS_ENABLED: 'true',
      TOOL_DEADLINE_MS: '400000',
      ENABLE_DATA_ANONYMIZATION: 'nope',
      LOG_REDACT_PII: 'nope',
    });
    expect(codes(config).sort()).toEqual(
      [
        'allowed_write_tools_invalid',
        'auth_mode_invalid',
        'canvas_role_invalid',
        'canvas_token_invalid',
        'canvas_url_invalid',
        'diagnostics_with_credentials',
        'enable_data_anonymization_invalid',
        'log_redact_pii_invalid',
        'mcp_backend_invalid',
        'owner_email_invalid',
        'owner_user_id_sha256_invalid',
        'runtime_bound_exceeded',
      ].sort(),
    );
    for (const error of config.errors) {
      expect(error.code).toMatch(/^[a-z0-9_]+$/);
      expect(error.message.length).toBeGreaterThan(10);
      expect(error.blocks).toBe('request');
    }
  });
});

describe('lists and enumerations', () => {
  it('parses STUDENT_WRITE_TOOLS as a comma- or space-separated ceiling', () => {
    expect(parseConfig(ownerEnv({ STUDENT_WRITE_TOOLS: '' })).studentWriteTools).toEqual([]);
    expect(parseConfig(ownerEnv({ STUDENT_WRITE_TOOLS: 'submit_assignment' })).studentWriteTools).toEqual([
      'submit_assignment',
    ]);
    expect(
      parseConfig(ownerEnv({ STUDENT_WRITE_TOOLS: 'submit_assignment, mark_module_item_done submit_assignment' }))
        .studentWriteTools,
    ).toEqual(['mark_module_item_done', 'submit_assignment']);
  });

  it('ignores unknown STUDENT_WRITE_TOOLS names, with a warning', () => {
    const config = parseConfig(ownerEnv({ STUDENT_WRITE_TOOLS: 'take_quiz_for_me, submit_assignment, send_conversation' }));
    expect(config.studentWriteTools).toEqual(['submit_assignment']);
    expect(config.warnings).toEqual([
      'STUDENT_WRITE_TOOLS names unknown tools; they will be ignored: send_conversation, take_quiz_for_me',
    ]);
    expect(config.errors).toEqual([]);
  });

  it('names an unknown list entry only when it is shaped like a name', () => {
    // Pieces of a secret pasted into a list-valued variable must not come back out through a warning.
    const config = parseConfig(
      ownerEnv({
        STUDENT_WRITE_TOOLS: 'submit_assignment 7~Ab1 k3y+/=',
        DISABLED_TOOLS: 'not_a_tool, sk-live.123',
        ACCESSIBILITY_CHECKERS: 'ufixit, a.b/c',
      }),
    );
    expect(config.warnings).toEqual([
      'STUDENT_WRITE_TOOLS names unknown tools; they will be ignored: <5 characters>, <6 characters>',
      'DISABLED_TOOLS names tools that are not in the tool table: not_a_tool, <11 characters>',
      'ACCESSIBILITY_CHECKERS names unknown checkers; they will be ignored (known: udoit, ufixit, none): <5 characters>',
    ]);
  });

  it('knows exactly the three student write tools', () => {
    expect([...STUDENT_WRITE_TOOL_NAMES].sort()).toEqual([
      'comment_on_my_submission',
      'mark_module_item_done',
      'submit_assignment',
    ]);
  });

  it.each(['none', '', '  ', 'NONE'])('reads ACCESSIBILITY_CHECKERS=%j as no checkers', (text) => {
    const config = parseConfig(ownerEnv({ ACCESSIBILITY_CHECKERS: text }));
    expect(config.accessibilityCheckers).toEqual([]);
    expect(config.warnings).toEqual([]);
  });

  it.each(['ufixit', 'UDOIT', ' udoit , ufixit '])('reads ACCESSIBILITY_CHECKERS=%j as ufixit', (text) => {
    expect(parseConfig(ownerEnv({ ACCESSIBILITY_CHECKERS: text })).accessibilityCheckers).toEqual(['ufixit']);
  });

  it('ignores an unknown accessibility checker, with a warning', () => {
    const config = parseConfig(ownerEnv({ ACCESSIBILITY_CHECKERS: 'ally, Zeta' }));
    expect(config.accessibilityCheckers).toEqual([]);
    expect(config.warnings).toEqual([
      'ACCESSIBILITY_CHECKERS names unknown checkers; they will be ignored (known: udoit, ufixit, none): ally, zeta',
    ]);
  });

  it('parses DISABLED_TOOLS, warning about names that are not tools', () => {
    const config = parseConfig(ownerEnv({ DISABLED_TOOLS: 'list_users, send_conversation list_users,not_a_tool' }));
    expect(config.disabledTools).toEqual(['list_users', 'not_a_tool', 'send_conversation']);
    expect(config.warnings).toEqual(['DISABLED_TOOLS names tools that are not in the tool table: not_a_tool']);
  });

  it('parses ALLOWED_HOSTS as lowercased host names', () => {
    expect(parseConfig(ownerEnv({ ALLOWED_HOSTS: 'My-Site.chatgpt.site, other.example ,my-site.chatgpt.site' })).allowedHosts).toEqual([
      'my-site.chatgpt.site',
      'other.example',
    ]);
  });

  it('fails closed on an unknown course policy posture', () => {
    const config = parseConfig(ownerEnv({ COURSE_AGENT_POLICY_DEFAULT: 'permit' }));
    expect(config.coursePolicy.defaultPosture).toBe('deny');
    expect(config.warnings).toEqual([
      "COURSE_AGENT_POLICY_DEFAULT should be one of allow, deny; defaulting to 'deny' (got 'permit')",
    ]);
    expect(parseConfig(ownerEnv({ COURSE_AGENT_POLICY_DEFAULT: ' Allow ' })).coursePolicy.defaultPosture).toBe('allow');
  });

  it('parses LOG_LEVEL case-insensitively', () => {
    expect(parseConfig(ownerEnv({ LOG_LEVEL: 'DEBUG' })).logLevel).toBe('debug');
    expect(parseConfig(ownerEnv({ LOG_LEVEL: 'WARNING' })).logLevel).toBe('warn');
    expect(parseConfig(ownerEnv({ LOG_LEVEL: 'error' })).logLevel).toBe('error');
    const bad = parseConfig(ownerEnv({ LOG_LEVEL: 'verbose' }));
    expect(bad.logLevel).toBe('info');
    expect(bad.warnings).toEqual([
      "LOG_LEVEL should be one of debug, info, warn, error; defaulting to 'info' (got 'verbose')",
    ]);
  });

  it('accepts a known time zone and falls back to UTC for an unknown one', () => {
    expect(parseConfig(ownerEnv({ TIMEZONE: 'America/Chicago' })).timezone).toBe('America/Chicago');
    const bad = parseConfig(ownerEnv({ TIMEZONE: 'Mars/Olympus' }));
    expect(bad.timezone).toBe('UTC');
    expect(bad.warnings).toEqual(["TIMEZONE is not a known time zone; defaulting to 'UTC' (got 'Mars/Olympus')"]);
  });

  it('reads the server name, institution and MCP path', () => {
    const config = parseConfig(
      ownerEnv({ MCP_SERVER_NAME: ' my-canvas ', INSTITUTION_NAME: ' Example University ', MCP_PATH: '/api/mcp/' }),
    );
    expect(config).toMatchObject({ serverName: 'my-canvas', institutionName: 'Example University', mcpPath: '/api/mcp' });
    expect(config.warnings).toEqual([]);
  });

  it.each(['mcp', '/mcp?x=1', '/mcp#frag', '/a b', '/a/../b', '//evil.example/mcp', 'https://evil.example/mcp'])(
    'falls back to /mcp for the invalid MCP_PATH %j',
    (path) => {
      const config = parseConfig(ownerEnv({ MCP_PATH: path }));
      expect(config.mcpPath).toBe('/mcp');
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('MCP_PATH must be an absolute path');
    },
  );
});
