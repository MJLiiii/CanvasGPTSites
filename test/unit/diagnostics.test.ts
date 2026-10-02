import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/hash';
import { createLogger } from '../../src/core/logging';
import { TOOL_EFFECTS } from '../../src/core/tool-policy';
import { parseConfig } from '../../src/env';
import { runTool } from '../../src/mcp/dispatch';
import type { DispatchDeps } from '../../src/mcp/dispatch';
import { DIAGNOSTIC_PROBES, HELLO_TEXT, PROBE_LIMITS, hello, sitesDiagnostics } from '../../src/tools/diagnostics';
import { ALL_TOOLS } from '../../src/tools/index';
import type { CredentialProvider, DiagnosticsAccess, Identity, ToolDef, ToolResult } from '../../src/types';
import { SERVER_VERSION, UPSTREAM_VERSION, USER_AGENT } from '../../src/version';

const RAW_USER_ID = 'user-0f9a77';
const RAW_EMAIL = 'owner@example.edu';
const RAW_AUTHORIZATION = 'Bearer aaa.bbb.ccc';

const OWNER: Identity = {
  key: `id:${RAW_USER_ID}`,
  userId: RAW_USER_ID,
  email: RAW_EMAIL,
  fullName: 'Olive Owner',
  source: 'sites-gateway',
};

function summary(name: string, value: string): { name: string; length: number; sha256_8: string } {
  return { name, length: value.length, sha256_8: sha256Hex(value).slice(0, 8) };
}

interface FakeAccess extends DiagnosticsAccess {
  fetchCounts: number[];
  d1Counts: number[];
}

function fakeAccess(headers: Array<{ name: string; length: number; sha256_8: string }>): FakeAccess {
  const access: FakeAccess = {
    fetchCounts: [],
    d1Counts: [],
    headerSummary: () => headers,
    authorizationShape: () => ({ present: true, scheme: 'Bearer', segments: 3, jwtIss: 'https://auth.example', jwtAud: 'site' }),
    bindingNames: () => ['DB', 'DIAGNOSTICS_ENABLED'],
    ctxPropKeys: () => ['mcp_connection'],
    probeFetch: async (count) => {
      access.fetchCounts.push(count);
      return { attempted: count, succeeded: count - 1, firstError: 'Too many subrequests' };
    },
    probeD1: async (count) => {
      access.d1Counts.push(count);
      return { attempted: count, succeeded: count };
    },
  };
  return access;
}

const GATEWAY_HEADERS = [
  summary('Content-Type', 'application/json'),
  summary('authorization', RAW_AUTHORIZATION),
  summary('mcp-protocol-version', '2025-06-18'),
  summary('oai-authenticated-user-id', RAW_USER_ID),
  summary('oai-authenticated-user-email', RAW_EMAIL),
];

const noCredentials: CredentialProvider = {
  mode: 'owner',
  authorize: () => {
    throw new Error('a diagnostics tool must not ask for authorization');
  },
  resolve: async () => {
    throw new Error('a diagnostics tool must not ask for a credential');
  },
};

function deps(options: { access?: DiagnosticsAccess; identity?: Identity | null; env?: Record<string, string> } = {}): DispatchDeps {
  return {
    config: parseConfig({ DIAGNOSTICS_ENABLED: 'true', ...options.env }),
    identity: options.identity === undefined ? OWNER : options.identity,
    credentials: noCredentials,
    createClient: () => {
      throw new Error('a diagnostics tool must not get a Canvas client');
    },
    log: createLogger({ level: 'error', redactPii: true, sink: () => undefined }),
    requestId: 'req-diag',
    pseudonymSalt: null,
    secretsToRedact: [],
    registeredTools: [],
    ...(options.access !== undefined && { diagnostics: options.access }),
  };
}

async function probe(args: Record<string, unknown>, given: DispatchDeps): Promise<ToolResult> {
  return runTool(sitesDiagnostics as ToolDef, args, given);
}

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBe(false);
  return result.structuredContent as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('version', () => {
  it('pins the server and upstream versions', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
    expect(UPSTREAM_VERSION).toBe('1.13.0');
    expect(USER_AGENT).toContain('0.1.0');
    expect(USER_AGENT).toContain('1.13.0');
    // Sent as a header value: visible ASCII only.
    expect(USER_AGENT).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('ALL_TOOLS', () => {
  it('holds exactly the two gated spike tools, in order', () => {
    expect(ALL_TOOLS.filter((def) => def.gate?.diagnostics).map((def) => def.name)).toEqual(['hello', 'sites_diagnostics']);
  });

  it.each(ALL_TOOLS.filter((def) => def.gate?.diagnostics).map((def) => [def.name, def] as const))('%s is a gated, read-only, closed-world tool', (_name, def) => {
    expect(def.gate).toEqual({ diagnostics: true });
    expect(def.effect).toBe('read');
    expect(def.role).toBe('shared');
    expect(def.fencing).toBe('safe');
    expect(def.rawAccess).toBeUndefined();
    expect(def.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // Outside the upstream table on purpose: only the diagnostics gate can register them.
    expect(Object.hasOwn(TOOL_EFFECTS, def.name)).toBe(false);
  });

  it('advertises the probe list', () => {
    expect([...DIAGNOSTIC_PROBES]).toEqual(['headers', 'runtime', 'subrequests', 'd1', 'cpu', 'wall', 'size']);
    expect(sitesDiagnostics.params.probe.values).toEqual(DIAGNOSTIC_PROBES);
  });
});

describe('hello', () => {
  it('returns a fixed greeting with the server and upstream versions', async () => {
    const result = await runTool(hello as ToolDef, {}, deps({ identity: null }));
    expect(result).toEqual({ content: [{ type: 'text', text: HELLO_TEXT }], isError: false });
    expect(HELLO_TEXT).toContain(SERVER_VERSION);
    expect(HELLO_TEXT).toContain(UPSTREAM_VERSION);
  });

  it('rejects arguments it does not take', async () => {
    const result = await runTool(hello as ToolDef, { name: 'x' }, deps());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('{"error": "Unknown parameter \'name\'"}');
  });
});

describe('sites_diagnostics', () => {
  it('rejects an unknown probe with the list of allowed values', async () => {
    const result = await probe({ probe: 'secrets' }, deps({ access: fakeAccess([]) }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("is not one of the allowed values: 'headers', 'runtime'");
  });

  it('reports an error when the app layer supplied no diagnostics access', async () => {
    for (const name of ['headers', 'runtime', 'subrequests', 'd1']) {
      const result = await probe({ probe: name }, deps());
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe('Error: diagnostics access is not available on this request.');
    }
  });

  describe('headers probe', () => {
    it('reports names, lengths and short hashes, never values', async () => {
      const result = await probe({ probe: 'headers' }, deps({ access: fakeAccess(GATEWAY_HEADERS) }));
      const out = structured(result);
      expect(out.headers).toEqual(GATEWAY_HEADERS.map((entry) => ({ ...entry, name: entry.name.toLowerCase() })));
      expect(out.authorization).toEqual({
        present: true,
        scheme: 'Bearer',
        segments: 3,
        jwtIss: 'https://auth.example',
        jwtAud: 'site',
      });
      const text = result.content[0]?.text ?? '';
      for (const raw of [RAW_USER_ID, RAW_EMAIL, RAW_AUTHORIZATION, 'aaa.bbb.ccc', 'Olive']) {
        expect(text).not.toContain(raw);
      }
    });

    it('says which gateway identity headers are present', async () => {
      const out = structured(await probe({ probe: 'headers' }, deps({ access: fakeAccess(GATEWAY_HEADERS) })));
      expect(out.identity_headers).toEqual({
        'oai-authenticated-user-id': { present: true },
        'oai-authenticated-user-email': { present: true },
        'oai-authenticated-user-full-name': { present: false },
      });
      expect(out.identity_resolved).toBe(true);
    });

    it('returns the full SHA-256 of the gateway user id for OWNER_USER_ID_SHA256', async () => {
      const out = structured(await probe({ probe: 'headers' }, deps({ access: fakeAccess(GATEWAY_HEADERS) })));
      expect(out.user_id_sha256).toBe(sha256Hex(RAW_USER_ID));
      expect(String(out.user_id_sha256)).toMatch(/^[0-9a-f]{64}$/);
      // The value is accepted by the configuration it is meant for.
      expect(parseConfig({ OWNER_USER_ID_SHA256: String(out.user_id_sha256) }).ownerUserIdSha256).toBe(out.user_id_sha256);
    });

    it('reports no user id hash when no identity was resolved', async () => {
      const out = structured(await probe({ probe: 'headers' }, deps({ access: fakeAccess([]), identity: null })));
      expect(out.user_id_sha256).toBeNull();
      expect(out.identity_resolved).toBe(false);
      expect(out.identity_headers).toEqual({
        'oai-authenticated-user-id': { present: false },
        'oai-authenticated-user-email': { present: false },
        'oai-authenticated-user-full-name': { present: false },
      });
    });

    it('recognises a public protocol version from its short hash', async () => {
      const known = structured(await probe({ probe: 'headers' }, deps({ access: fakeAccess(GATEWAY_HEADERS) })));
      expect(known.mcp_protocol_version).toBe('2025-06-18');
      const odd = structured(
        await probe({ probe: 'headers' }, deps({ access: fakeAccess([summary('mcp-protocol-version', '1999-01-01')]) })),
      );
      expect(odd.mcp_protocol_version).toBe('unrecognized');
      const none = structured(await probe({ probe: 'headers' }, deps({ access: fakeAccess([]) })));
      expect(none.mcp_protocol_version).toBeNull();
    });
  });

  describe('runtime probe', () => {
    it('reports binding names, ctx.props keys, the protocol era and platform features', async () => {
      const given = { ...deps({ access: fakeAccess([]), env: { TIMEZONE: 'America/Chicago' } }), protocolEra: 'legacy' as const };
      const out = structured(await probe({ probe: 'runtime' }, given));
      expect(out.bindings).toEqual(['DB', 'DIAGNOSTICS_ENABLED']);
      expect(out.ctx_props).toEqual(['mcp_connection']);
      expect(out.protocol_era).toBe('legacy');
      expect(out.server_version).toBe(SERVER_VERSION);
      expect(out.upstream_version).toBe(UPSTREAM_VERSION);
      expect(out.intl).toEqual({
        available: true,
        named_time_zones: true,
        configured_time_zone: 'America/Chicago',
        configured_time_zone_valid: true,
      });
      expect(out.web_crypto).toEqual({ subtle: true, random_uuid: true });
      expect(typeof (out.date as { now_ms: unknown }).now_ms).toBe('number');
    });

    it('says the era is unknown when the backend did not pass it', async () => {
      const out = structured(await probe({ probe: 'runtime' }, deps({ access: fakeAccess([]) })));
      expect(out.protocol_era).toBe('unknown');
    });
  });

  describe('subrequests and d1 probes', () => {
    it.each([
      [undefined, 10],
      [1, 1],
      [0, 1],
      [-5, 1],
      [120, 120],
      [150, 150],
      [151, 150],
      [100000, 150],
      ['42', 42],
    ])('subrequests n=%s probes %i fetches', async (n, expected) => {
      const access = fakeAccess([]);
      const out = structured(await probe(n === undefined ? { probe: 'subrequests' } : { probe: 'subrequests', n }, deps({ access })));
      expect(access.fetchCounts).toEqual([expected]);
      expect(out).toEqual({
        probe: 'subrequests',
        requested: expected,
        attempted: expected,
        succeeded: expected - 1,
        firstError: 'Too many subrequests',
      });
    });

    it.each([
      [undefined, 5],
      [0, 1],
      [60, 60],
      [61, 60],
      [5000, 60],
    ])('d1 n=%s probes %i calls', async (n, expected) => {
      const access = fakeAccess([]);
      const out = structured(await probe(n === undefined ? { probe: 'd1' } : { probe: 'd1', n }, deps({ access })));
      expect(access.d1Counts).toEqual([expected]);
      expect(access.fetchCounts).toEqual([]);
      expect(out).toEqual({ probe: 'd1', requested: expected, attempted: expected, succeeded: expected });
    });

    it('has the documented upper bounds', () => {
      expect(PROBE_LIMITS).toEqual({ subrequests: 150, d1: 60, cpuMs: 20_000, wallMs: 150_000, sizeBytes: 2_000_000 });
    });
  });

  describe('cpu probe', () => {
    it('spins for about n ms and reports the elapsed time', async () => {
      const out = structured(await probe({ probe: 'cpu', n: 15 }, deps()));
      expect(out.probe).toBe('cpu');
      expect(out.requested_ms).toBe(15);
      expect(out.elapsed_ms as number).toBeGreaterThanOrEqual(15);
      expect(out.chunks as number).toBeGreaterThan(0);
      expect(out.stopped_by).toBe('clock');
    });

    it('does nothing for a negative n', async () => {
      const out = structured(await probe({ probe: 'cpu', n: -100 }, deps()));
      expect(out.requested_ms).toBe(0);
      expect(out.chunks).toBe(0);
    });

    it('ends by its work limit when the clock never advances', async () => {
      // Workers freeze Date.now() while code runs; a loop that only watched the clock would never end.
      const frozen = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const out = structured(await probe({ probe: 'cpu', n: 2 }, deps()));
      frozen.mockRestore();
      expect(out.requested_ms).toBe(2);
      expect(out.elapsed_ms).toBe(0);
      expect(out.stopped_by).toBe('work_limit');
      expect(out.clock_advanced_while_spinning).toBe(false);
      expect(out.chunks as number).toBeGreaterThan(0);
    });
  });

  describe('wall probe', () => {
    it('waits n ms and reports the elapsed time', async () => {
      const out = structured(await probe({ probe: 'wall', n: 20 }, deps()));
      expect(out.requested_ms).toBe(20);
      expect(out.elapsed_ms as number).toBeGreaterThanOrEqual(15);
    });

    it('clamps the wait to 150000 ms', async () => {
      vi.useFakeTimers();
      const pending = probe({ probe: 'wall', n: 10_000_000 }, deps());
      await vi.advanceTimersByTimeAsync(149_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const out = structured(await pending);
      expect(out.requested_ms).toBe(150_000);
      expect(out.elapsed_ms).toBe(150_000);
    });
  });

  describe('size probe', () => {
    const bytes = (text: string): number => new TextEncoder().encode(text).length;

    it.each([1, 5, 30, 250, 1000, 199_999])('returns exactly %i bytes of filler text', async (n) => {
      const result = await probe({ probe: 'size', n }, deps());
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toBeUndefined();
      expect(bytes(result.content[0]?.text ?? '')).toBe(n);
    });

    it('defaults to 1000 bytes', async () => {
      const result = await probe({ probe: 'size' }, deps());
      expect(bytes(result.content[0]?.text ?? '')).toBe(1000);
      expect(result.content[0]?.text.startsWith('size probe: 1000 bytes\n')).toBe(true);
    });

    it('clamps n to 2,000,000 bytes', async () => {
      const result = await probe({ probe: 'size', n: 50_000_000 }, deps({ env: { MAX_TOOL_RESULT_BYTES: '3000000' } }));
      expect(bytes(result.content[0]?.text ?? '')).toBe(2_000_000);
    });

    it('is cut by the server when it exceeds MAX_TOOL_RESULT_BYTES, with the notice', async () => {
      const result = await probe({ probe: 'size', n: 500_000 }, deps());
      const text = result.content[0]?.text ?? '';
      expect(bytes(text)).toBeLessThanOrEqual(200_000);
      expect(text).toContain('Output truncated: the full result is 500000 bytes and the limit is 200000 bytes');
    });
  });
});
