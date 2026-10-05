// Specs for src/http/status-page.ts, driven through createApp().fetch so the routing and the owner check are the real ones.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { callerIdFor } from '../../src/auth/owner-secret-provider';
import { sha256Hex } from '../../src/core/hash';
import {
  PRIVATE_DEPLOYMENT_SENTENCE,
  ROBOTS_TXT,
  escapeHtml,
  matchStatusRoute,
  renderOwnerHtml,
  renderPublicHtml,
} from '../../src/http/status-page';
import type { StatusReport } from '../../src/http/status-page';
import type { Env } from '../../src/types';
import { SERVER_VERSION, UPSTREAM_VERSION } from '../../src/version';
import { createFakeCanvas, json } from '../helpers/fake-canvas';
import type { FakeCanvas } from '../helpers/fake-canvas';

const SITE = 'https://site.example';
const CANVAS = 'https://canvas.example.edu';
const TOKEN = `7~${'Kp5'.repeat(16)}`;
const CONFIRMATION_SECRET = 'status-page-confirmation-secret-0123456789';
const SALT = 'status-page-pseudonym-salt';
const OWNER_EMAIL = 'owner@example.edu';

const BASE_ENV: Env = {
  CANVAS_API_URL: CANVAS,
  CANVAS_API_TOKEN: TOKEN,
  OWNER_EMAIL,
  CONFIRMATION_SECRET,
  PSEUDONYM_SALT: SALT,
};

const OWNER_HEADERS = {
  'oai-authenticated-user-id': 'user-0f9a77',
  'oai-authenticated-user-email': OWNER_EMAIL,
};
const STRANGER_HEADERS = {
  'oai-authenticated-user-id': 'user-222',
  'oai-authenticated-user-email': 'visitor@example.org',
};

interface Harness {
  fake: FakeCanvas;
  logLines: string[];
  get(path: string, headers?: Record<string, string>, env?: Env): Promise<Response>;
  send(method: string, path: string, headers?: Record<string, string>, env?: Env): Promise<Response>;
}

function harness(): Harness {
  const fake = createFakeCanvas({ origin: CANVAS });
  const logLines: string[] = [];
  const app = createApp({ fetchImpl: fake.fetch, logSink: (line) => logLines.push(line) });
  const send = (method: string, path: string, headers: Record<string, string> = {}, env: Env = {}): Promise<Response> =>
    app.fetch(new Request(`${SITE}${path}`, { method, headers }), { ...BASE_ENV, ...env });
  return { fake, logLines, send, get: (path, headers, env) => send('GET', path, headers, env) };
}

describe('GET /: everyone but the owner', () => {
  it.each([
    ['no identity headers', {}],
    ['another signed-in user', STRANGER_HEADERS],
    ['the owner email in a duplicated header', { 'oai-authenticated-user-email': `${OWNER_EMAIL}, ${OWNER_EMAIL}` }],
    ['the owner headers plus the bypass token', { ...OWNER_HEADERS, 'oai-sites-authorization': 'bypass' }],
    ['the owner email with the wrong id', { ...OWNER_HEADERS, 'oai-authenticated-user-id': 'user-other' }],
  ])('shows one sentence and nothing else to %s', async (_label, headers) => {
    const response = await harness().get('/', headers, { OWNER_USER_ID_SHA256: sha256Hex('user-0f9a77') });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toBe(renderPublicHtml());
    expect(html).toContain(`<p>${PRIVATE_DEPLOYMENT_SENTENCE}</p>`);
    for (const detail of [SERVER_VERSION, UPSTREAM_VERSION, 'canvas.example.edu', OWNER_EMAIL, 'CANVAS_', 'OWNER_', '/mcp', 'student', 'sdk']) {
      expect(html).not.toContain(detail);
    }
  });

  it('shows the same sentence when the deployment is misconfigured', async () => {
    const response = await harness().get('/', STRANGER_HEADERS, { CANVAS_ROLE: 'admin', CANVAS_API_URL: 'http://plain.example.edu' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(renderPublicHtml());
  });

  it('shows the public view to everyone when no owner is configured', async () => {
    const response = await harness().get('/', OWNER_HEADERS, { OWNER_EMAIL: '' });
    expect(await response.text()).toBe(renderPublicHtml());
  });

  it('writes nothing about a stranger but a tag to the log', async () => {
    const h = harness();
    await h.get('/', STRANGER_HEADERS);
    expect(h.logLines.join('\n')).not.toContain('visitor@example.org');
    expect(h.logLines.join('\n')).not.toContain('user-222');
  });
});

describe('GET /: the owner', () => {
  it('shows the deployment facts', async () => {
    const response = await harness().get('/', OWNER_HEADERS, {
      CANVAS_ROLE: 'educator',
      MCP_BACKEND: 'native',
      INSTITUTION_NAME: 'Example University',
      ALLOWED_WRITE_TOOLS: 'send_conversation,create_page',
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const expected of [
      `<code>${SERVER_VERSION}</code>`,
      `<code>${UPSTREAM_VERSION}</code>`,
      '<code>owner</code>',
      '<code>educator</code>',
      '<code>/mcp</code>',
      `<code>${SITE}/mcp</code>`,
      '<code>native</code>',
      '<code>canvas.example.edu</code>',
      'Example University',
      '<code>create_page</code>, <code>send_conversation</code>',
      OWNER_EMAIL,
      'request_budget',
      'tool_deadline_ms',
      'max_tool_result_bytes',
      'D1 binding (DB)',
      'R2 binding (FILES)',
    ]) {
      expect(html).toContain(expected);
    }
  });

  it('shows which settings are present by name and yes/no only', async () => {
    const html = await (await harness().get('/', OWNER_HEADERS)).text();
    for (const name of ['CANVAS_API_URL', 'CANVAS_API_TOKEN', 'OWNER_EMAIL', 'CONFIRMATION_SECRET', 'PSEUDONYM_SALT']) {
      expect(html).toContain(`<tr><th>${name}</th><td><span class="ok">yes</span></td></tr>`);
    }
    expect(html).toContain('<tr><th>OWNER_USER_ID_SHA256</th><td><span class="muted">no (optional)</span></td></tr>');
  });

  it('marks a missing required setting', async () => {
    const html = await (await harness().get('/', OWNER_HEADERS, { CANVAS_API_TOKEN: '' })).text();
    expect(html).toContain('<tr><th>CANVAS_API_TOKEN</th><td><span class="bad">no (required)</span></td></tr>');
    expect(html).toContain('canvas_token_missing');
    expect(html).toContain('CANVAS_API_TOKEN environment variable is required');
  });

  it('shows configuration errors and warnings', async () => {
    const html = await (
      await harness().get('/', OWNER_HEADERS, { CANVAS_ROLE: 'admin', LOG_LEVEL: 'loud', ALLOWED_WRITE_TOOLS: 'no_such_tool' })
    ).text();
    expect(html).toContain('Configuration errors');
    expect(html).toContain('canvas_role_invalid');
    expect(html).toContain('allowed_write_tools_invalid');
    expect(html).toContain('(blocks request)');
    expect(html).toContain('Configuration warnings');
    expect(html).toContain('LOG_LEVEL');
    expect(html).toContain('invalid (see configuration errors)');
  });

  it('shows a read-only deployment as such', async () => {
    const html = await (await harness().get('/', OWNER_HEADERS)).text();
    expect(html).toContain('none (read-only)');
  });

  it('lists registered tools and the reason each other tool is not registered', async () => {
    const normal = await (await harness().get('/', OWNER_HEADERS)).text();
    expect(normal).toContain('Registered tools (12)');
    expect(normal).toContain('<code>list_courses</code>');
    expect(normal).toContain('<tr><th>hello</th><td>diagnostics tools need DIAGNOSTICS_ENABLED</td></tr>');

    const diagnostics = await (
      await harness().get('/', OWNER_HEADERS, { DIAGNOSTICS_ENABLED: 'true', CANVAS_API_TOKEN: '', CONFIRMATION_SECRET: '' })
    ).text();
    expect(diagnostics).toContain('Registered tools (2)');
    expect(diagnostics).toContain('<code>hello</code>');
    expect(diagnostics).toContain('<code>sites_diagnostics</code>');
  });

  it('reports binding presence', async () => {
    const h = harness();
    const without = await (await h.get('/', OWNER_HEADERS)).text();
    expect(without).toContain('<tr><th>D1 binding (DB)</th><td><span class="muted">no</span></td></tr>');
    const withDb = await (await h.get('/', OWNER_HEADERS, { DB: {} as D1Database })).text();
    expect(withDb).toContain('<tr><th>D1 binding (DB)</th><td><span class="ok">yes</span></td></tr>');
    expect(withDb).toContain('<tr><th>R2 binding (FILES)</th><td><span class="muted">no</span></td></tr>');
  });

  it('accepts the owner on the email alone when the id header is absent', async () => {
    const html = await (
      await harness().get('/', { 'oai-authenticated-user-email': OWNER_EMAIL }, { OWNER_USER_ID_SHA256: sha256Hex('user-0f9a77') })
    ).text();
    expect(html).toContain('Deployment');
  });

  it('never renders a secret or anything derived from one', async () => {
    for (const env of [{}, { CANVAS_ROLE: 'admin' }, { CANVAS_API_URL: `https://${TOKEN}@canvas.example.edu` }, { TIMEZONE: SALT }]) {
      for (const path of ['/', '/api/status']) {
        const body = await (await harness().get(path, OWNER_HEADERS, env)).text();
        for (const secret of [TOKEN, CONFIRMATION_SECRET, SALT, encodeURIComponent(TOKEN), callerIdFor(TOKEN), sha256Hex(TOKEN)]) {
          expect(body).not.toContain(secret);
        }
      }
    }
  });

  it('never shows the owner id hash, a request header or a stack trace', async () => {
    const hash = sha256Hex('user-0f9a77');
    const html = await (
      await harness().get('/', { ...OWNER_HEADERS, 'x-probe': 'header-value-123' }, { OWNER_USER_ID_SHA256: hash })
    ).text();
    expect(html).not.toContain(hash);
    expect(html).not.toContain('header-value-123');
    expect(html).not.toContain('user-0f9a77');
    expect(html).not.toMatch(/\bat \S+ \(/);
  });
});

describe('status HTML', () => {
  const EXPECTED_HEADERS: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };

  it.each([
    ['the owner', OWNER_HEADERS],
    ['a stranger', STRANGER_HEADERS],
  ])('carries the security headers for %s', async (_label, headers) => {
    const response = await harness().get('/', headers);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('contains no script, no event handler, no external resource', async () => {
    for (const headers of [OWNER_HEADERS, STRANGER_HEADERS]) {
      const html = await (await harness().get('/', headers, { DIAGNOSTICS_ENABLED: 'true', CANVAS_API_TOKEN: '', CONFIRMATION_SECRET: '' })).text();
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/javascript:/i);
      const icon = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
      expect(html).toContain(icon);
      const withoutIcon = html.replace(icon, '');
      expect(withoutIcon).not.toMatch(/<(img|link|iframe|object|embed)\b/i);
      expect(withoutIcon).not.toMatch(/(src|href)\s*=/i);
    }
  });

  it('escapes every configured value it interpolates', async () => {
    const hostile = '<script>alert("x")</script>&\'';
    const html = await (
      await harness().get('/', OWNER_HEADERS, { INSTITUTION_NAME: hostile, MCP_SERVER_NAME: '<img src=x onerror=alert(1)>' })
    ).text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt; status</title>');
  });

  it('escapes warnings, which echo configured values', async () => {
    const html = await (await harness().get('/', OWNER_HEADERS, { LOG_LEVEL: '<b>loud</b>' })).text();
    expect(html).not.toContain('<b>loud</b>');
    expect(html).toContain('&lt;b&gt;loud&lt;/b&gt;');
  });

  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(42)).toBe('42');
  });

  it('escapes every field of a report, wherever it is rendered', () => {
    const x = '<x>"&\'';
    const report: StatusReport = {
      server: { version: x, upstream_version: x, name: x, institution: x },
      auth_mode: x,
      role: x,
      mcp: { path: x, endpoint: x, backend: x },
      signed_in_as: x,
      settings: [{ name: x, required: true, present: false }],
      canvas_host: x,
      canvas_connections: [{ id: x, name: x, host: x, token_present: false, available: false, errors: [x] }],
      tools: { count: 1, registered: [{ name: x, module: x, effect: x }], not_registered: [{ name: x, reason: x }] },
      write_allowlist: { state: 'tools', tools: [x] },
      student_write_tools: [x],
      disabled_tools: [x],
      config_errors: [{ code: x, blocks: x, message: x }],
      config_warnings: [x],
      bindings: { d1: true, r2: false },
      switches: { [x]: x },
      limits: { [x]: 1 },
    };
    const html = renderOwnerHtml(report);
    expect(html).not.toContain('<x>');
    expect(html.split('&lt;x&gt;&quot;&amp;&#39;').length - 1).toBeGreaterThanOrEqual(20);
  });
});

describe('GET /api/status', () => {
  it('gives the owner the same data as JSON', async () => {
    const response = await harness().get('/api/status', OWNER_HEADERS, { DB: {} as D1Database });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await response.json()) as { private: boolean; status: StatusReport };
    expect(body.private).toBe(false);
    expect(body.status.server).toEqual({ version: SERVER_VERSION, upstream_version: UPSTREAM_VERSION, name: 'canvas-api', institution: '' });
    expect(body.status.auth_mode).toBe('owner');
    expect(body.status.role).toBe('student');
    expect(body.status.mcp).toEqual({ path: '/mcp', endpoint: `${SITE}/mcp`, backend: 'sdk' });
    expect(body.status.canvas_host).toBe('canvas.example.edu');
    expect(body.status.signed_in_as).toBe(OWNER_EMAIL);
    expect(body.status.settings).toEqual([
      { name: 'CANVAS_API_URL', required: true, present: true },
      { name: 'CANVAS_API_TOKEN', required: true, present: true },
      { name: 'OWNER_EMAIL', required: true, present: true },
      { name: 'OWNER_USER_ID_SHA256', required: false, present: false },
      { name: 'CONFIRMATION_SECRET', required: false, present: true },
      { name: 'PSEUDONYM_SALT', required: false, present: true },
    ]);
    expect(body.status.write_allowlist).toEqual({ state: 'read_only', tools: [] });
    expect(body.status.bindings).toEqual({ d1: true, r2: false });
    expect(body.status.config_errors).toEqual([]);
    expect(body.status.limits).toMatchObject({ request_budget: 40, max_pages: 10, tool_deadline_ms: 25000, max_request_bytes: 1048576 });
    expect(body.status.tools.count).toBe(12);
    expect(body.status.tools.not_registered.map((tool) => tool.name)).toEqual(['hello', 'sites_diagnostics']);
  });

  it('gives everyone else the sentence only', async () => {
    for (const headers of [{}, STRANGER_HEADERS]) {
      const response = await harness().get('/api/status', headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ private: true, message: PRIVATE_DEPLOYMENT_SENTENCE });
    }
  });
});

describe('POST /api/status/check', () => {
  const SAME_ORIGIN = { ...OWNER_HEADERS, origin: SITE };

  it('calls GET /users/self once with the token and reports ok', async () => {
    const h = harness();
    h.fake.route('GET', '/api/v1/users/self', () => json({ id: 42, name: 'Olive Owner', login_id: 'olive' }));
    const response = await h.send('POST', '/api/status/check', SAME_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true, status: 200 });
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]?.method).toBe('GET');
    expect(h.fake.calls[0]?.url).toBe(`${CANVAS}/api/v1/users/self`);
    expect(h.fake.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.fake.calls[0]?.redirect).toBe('manual');
  });

  it('returns nothing of the profile', async () => {
    const h = harness();
    h.fake.route('GET', '/api/v1/users/self', () => json({ id: 42, name: 'Olive Owner', login_id: 'olive', primary_email: 'olive@example.edu' }));
    const text = await (await h.send('POST', '/api/status/check', SAME_ORIGIN)).text();
    expect(text).toBe('{"ok":true,"status":200}');
  });

  it.each([401, 403, 404, 500])('reports the HTTP status %i and nothing else when Canvas refuses', async (status) => {
    const h = harness();
    h.fake.route('GET', '/api/v1/users/self', () => json({ errors: [{ message: `denied for token ${TOKEN}` }] }, { status }));
    const response = await h.send('POST', '/api/status/check', SAME_ORIGIN);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, status });
    expect(text).not.toContain(TOKEN);
    expect(h.logLines.join('\n')).not.toContain(TOKEN);
  });

  it('reports a null status when Canvas cannot be reached', async () => {
    const h = harness();
    h.fake.route('GET', '/api/v1/users/self', () => {
      throw new TypeError('network down');
    });
    const response = await h.send('POST', '/api/status/check', SAME_ORIGIN);
    expect(await response.json()).toEqual({ ok: false, status: null });
  });

  it.each([
    ['no Origin header', OWNER_HEADERS],
    ['another origin', { ...OWNER_HEADERS, origin: 'https://evil.example' }],
    ['the same host over http', { ...OWNER_HEADERS, origin: 'http://site.example' }],
    ['a null origin', { ...OWNER_HEADERS, origin: 'null' }],
    ['a look-alike origin', { ...OWNER_HEADERS, origin: 'https://site.example.evil.example' }],
  ])('refuses the owner with %s and does not call Canvas', async (_label, headers) => {
    const h = harness();
    const response = await h.send('POST', '/api/status/check', headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'Forbidden' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it.each([
    ['no identity', { origin: SITE }],
    ['a stranger', { ...STRANGER_HEADERS, origin: SITE }],
    ['the owner headers with the bypass token', { ...SAME_ORIGIN, 'oai-sites-authorization': 'bypass' }],
    ['a comma-joined owner email', { 'oai-authenticated-user-email': `x@evil.example, ${OWNER_EMAIL}`, origin: SITE }],
  ])('refuses %s with 403 and does not call Canvas', async (_label, headers) => {
    const h = harness();
    const response = await h.send('POST', '/api/status/check', headers);
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(h.fake.calls).toHaveLength(0);
    const security = h.logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.level === 'security');
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({ event: 'status_check_denied' });
    expect(h.logLines.join('\n')).not.toContain('visitor@example.org');
  });

  it('does not call Canvas on a misconfigured deployment', async () => {
    const h = harness();
    const response = await h.send('POST', '/api/status/check', SAME_ORIGIN, { CANVAS_API_TOKEN: '' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, status: null, reason: 'not_configured' });
    expect(h.fake.calls).toHaveLength(0);
  });

  it('accepts the Site origin named by the Host header when the URL names an internal host', async () => {
    const fake = createFakeCanvas({ origin: CANVAS });
    fake.route('GET', '/api/v1/users/self', () => json({ id: 1 }));
    const app = createApp({ fetchImpl: fake.fetch, logSink: () => undefined });
    const request = new Request('https://internal.invalid/api/status/check', {
      method: 'POST',
      headers: { ...OWNER_HEADERS, host: 'site.example', origin: SITE },
    });
    expect((await app.fetch(request, BASE_ENV)).status).toBe(200);
  });

  it('answers GET with 405', async () => {
    const response = await harness().get('/api/status/check', SAME_ORIGIN);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('other status routes', () => {
  it('answers GET /healthz with ok, whatever the configuration', async () => {
    for (const env of [{}, { CANVAS_ROLE: 'admin' }, { CANVAS_API_TOKEN: '', OWNER_EMAIL: '' }]) {
      const response = await harness().get('/healthz', {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await response.text()).toBe('ok');
    }
  });

  it('answers GET /robots.txt with a disallow-all', async () => {
    const response = await harness().get('/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(ROBOTS_TXT).toBe('User-agent: *\nDisallow: /\n');
  });

  it('answers HEAD like GET, without a body', async () => {
    const response = await harness().send('HEAD', '/', OWNER_HEADERS);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(await response.text()).toBe('');
  });

  it.each(['/', '/api/status', '/healthz', '/robots.txt'])('answers POST %s with 405', async (path) => {
    const response = await harness().send('POST', path, OWNER_HEADERS);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  });

  it('knows exactly five routes and none of the reserved gateway paths', () => {
    expect(['/', '/api/status', '/api/status/check', '/healthz', '/robots.txt'].map(matchStatusRoute)).toEqual([
      'page',
      'json',
      'check',
      'health',
      'robots',
    ]);
    for (const path of ['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback', '/settings', '/api', '/toString', '/constructor', '']) {
      expect(matchStatusRoute(path)).toBeNull();
    }
  });

  it('refuses a status route on a host outside ALLOWED_HOSTS', async () => {
    const h = harness();
    const response = await h.get('/', OWNER_HEADERS, { ALLOWED_HOSTS: 'other.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    const allowed = await h.get('/', OWNER_HEADERS, { ALLOWED_HOSTS: 'site.example' });
    expect(allowed.status).toBe(200);
  });
});
