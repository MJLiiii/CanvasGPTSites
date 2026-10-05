import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createCredentialProvider } from '../../src/auth/credentials';
import { SubrequestMeter } from '../../src/canvas/budget';
import { parseConfig, parseSecrets, secretValuesForRedaction } from '../../src/env';
import { resolveToolPolicy } from '../../src/core/tool-policy';
import { inputSchemaFor } from '../../src/mcp/define-tool';
import { ALL_TOOLS } from '../../src/tools';
import type { Env, Identity, ToolResult } from '../../src/types';
import { createFakeCanvas, json } from '../helpers/fake-canvas';

const SITE = 'https://site.example';
const OWNER_EMAIL = 'owner@example.edu';
const OWNER: Identity = { key: `email:${OWNER_EMAIL}`, email: OWNER_EMAIL, userId: null, fullName: null, source: 'sites-gateway' };
const OWNER_HEADERS = { 'oai-authenticated-user-email': OWNER_EMAIL };

interface Connection { id: string; name: string; url: string; token: string }

function connections(count = 3): Connection[] {
  return Array.from({ length: count }, (_, i) => ({ id: `custom_${i}`, name: `My institution ${i}`,
    url: `https://learning-${i}.example.edu`, token: `fake-token-for-connection-${i}` }));
}

function environment(rows: unknown, overrides: Env = {}): Env {
  return { CANVAS_CONNECTIONS: JSON.stringify(rows), OWNER_EMAIL, ...overrides };
}

function harness(rows = connections(), backend = 'native', overrides: Env = {}, now?: () => number) {
  const logLines: string[] = [];
  const fakes = rows.map((row) => {
    const fake = createFakeCanvas({ origin: row.url });
    fake.route('get', '/api/v1/courses', () => json([{ id: 17, course_code: 'SAME_CODE', name: `Course at ${row.id}`,
      enrollments: [{ type: 'StudentEnrollment', computed_current_score: 81 }] }]));
    fake.route('get', '/api/v1/courses/17', () => json({ id: 17, course_code: 'SAME_CODE', name: `Course at ${row.id}`, syllabus_body: `Syllabus at ${row.id}` }));
    fake.route('get', '/api/v1/users/self/profile', () => json({ id: 5, name: `Own identity ${row.id}`, login_id: row.id }));
    fake.route('get', '/api/v1/users/self', () => json({ id: 5, name: 'Own identity', private_profile: 'NEVER_RETURN_PROFILE' }));
    fake.route('get', '/api/v1/users/self/todo', () => json([{ type: 'submitting', course_id: 17,
      assignment: { name: `TODO at ${row.id}`, due_at: new Date(Date.now() + 86_400_000).toISOString() } }]));
    fake.route('get', '/api/v1/planner/items', () => json([2, 1].map((days) => ({ course_id: 17, plannable_type: 'assignment',
      plannable: { title: `day ${days} at ${row.id}`, due_at: new Date(Date.now() + days * 86_400_000).toISOString() } }))));
    fake.route('get', '/api/v1/courses/17/assignments', () => json([{ id: 23, name: `Assignment at ${row.id}` }]));
    fake.route('get', '/api/v1/courses/17/assignments/23', () => json({ id: 23, name: `Assignment at ${row.id}`, description: `Description at ${row.id}` }));
    return fake;
  });
  const outbound: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const fake = fakes.find((candidate) => candidate.origin === new URL(url).origin);
    if (!fake) throw new Error('Unexpected origin in test');
    return fake.fetch(input, init);
  };
  const app = createApp({ fetchImpl: outbound, logSink: (line) => logLines.push(line), ...(now && { now }) });
  const env = environment(rows, { MCP_BACKEND: backend, ...overrides });
  const rpc = async (method: string, params?: unknown, owner = true, callEnv = env) => {
    const response = await app.fetch(new Request(`${SITE}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(owner ? OWNER_HEADERS : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), callEnv);
    return { response, body: await response.json() as { result: ToolResult; error?: { message: string } } };
  };
  const call = (name: string, args: Record<string, unknown> = {}, owner = true, callEnv = env) =>
    rpc('tools/call', { name, arguments: args }, owner, callEnv);
  const status = (path = '/api/status', method = 'GET', headers: Record<string, string> = OWNER_HEADERS) =>
    app.fetch(new Request(SITE + path, { method, headers }), env);
  return { app, env, fakes, logLines, rpc, call, status, calls: () => fakes.flatMap((fake) => fake.calls) };
}

describe('custom Canvas connection configuration', () => {
  it.each([1, 2, 7, 80])('accepts %i custom connections without a two-school limit', (count) => {
    const rows = connections(count);
    const config = parseConfig(environment(rows));
    expect(config.errors).toEqual([]);
    expect(config.canvasConnections.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(config.canvasConnections.every((row) => row.apiUrl?.endsWith('/api/v1'))).toBe(true);
    for (const row of rows) expect(JSON.stringify(config)).not.toContain(row.token);
    expect(parseSecrets(environment(rows)).canvasTokens).toEqual(Object.fromEntries(rows.map((row) => [row.id, row.token])));
  });

  it.each(['[', '', 'null', '{}', '[]', '[{"id":"duplicate"},{"id":"duplicate"}]', '[{"id":"../unsafe"}]'])('fails closed on structural configuration %s', (raw) => {
    const env = { CANVAS_CONNECTIONS: raw, OWNER_EMAIL };
    const config = parseConfig(env);
    expect(config.errors.some((issue) => issue.code === 'canvas_connections_invalid')).toBe(true);
    expect(config.canvasConnections).toEqual([]);
    expect(config.errors[0]!.message).not.toContain(raw.length > 3 ? raw : 'SyntaxError');
  });

  it('rejects duplicate IDs even when both entries are otherwise valid', () => {
    const rows = connections(2);
    rows[1]!.id = rows[0]!.id;
    expect(parseConfig(environment(rows)).errors[0]!.code).toBe('canvas_connections_invalid');
  });

  it('uses custom connections exclusively when old variables are also present', () => {
    const env = environment(connections(1), { CANVAS_API_URL: 'http://invalid', CANVAS_API_TOKEN: 'old\ninvalid' });
    const config = parseConfig(env);
    expect(config.errors).toEqual([]);
    expect(config.canvasConnections).toHaveLength(1);
    expect(config.canvasApiUrl).toBeNull();
    expect(parseSecrets(env).canvasToken).toBeNull();
    expect(secretValuesForRedaction(env)).toContain('old\ninvalid');
  });

  it('retains the legacy default connection and the original secret shape', () => {
    const env = { CANVAS_API_URL: 'https://old.example.edu', CANVAS_API_TOKEN: 'fake-legacy-token', OWNER_EMAIL };
    expect(parseConfig(env).canvasConnections[0]!.id).toBe('default');
    expect(parseConfig(env).connectionsConfigured).toBe(false);
    expect(parseSecrets(env)).toEqual({ canvasToken: 'fake-legacy-token', confirmationSecret: null, pseudonymSalt: null });
  });

  it('isolates invalid URLs, names and tokens instead of withholding healthy connections', async () => {
    const rows = connections(4);
    rows[1]!.url = 'http://plain.example.edu';
    rows[2]!.token = 'rejected fake token';
    rows[3]!.name = '';
    const env = environment(rows);
    const config = parseConfig(env);
    expect(config.errors).toEqual([]);
    expect(config.canvasConnections.map((row) => row.errors.length > 0)).toEqual([false, true, true, true]);
    const provider = createCredentialProvider(config, parseSecrets(env));
    expect((await provider.resolve(OWNER, rows[0]!.id)).ok).toBe(true);
    for (const row of rows.slice(1)) expect((await provider.resolve(OWNER, row.id)).ok).toBe(false);
    expect((await provider.resolve(OWNER)).ok).toBe(false);
    expect((await provider.resolve(OWNER, 'unknown')).ok).toBe(false);
    expect((await provider.resolve(null, rows[0]!.id)).ok).toBe(false);
  });

  it('redacts tokens pasted into display metadata and refuses tokens in URL or ID metadata', () => {
    const rows = connections(3);
    rows[0]!.name = rows[1]!.token;
    rows[2]!.url = `https://${rows[2]!.token}.example.edu`;
    const config = parseConfig(environment(rows));
    for (const row of rows) expect(JSON.stringify(config)).not.toContain(row.token);
    expect(config.canvasConnections[0]!.name).toBe('[REDACTED]');
    expect(config.canvasConnections[2]!.apiUrl).toBeNull();
    rows[0]!.id = rows[0]!.token;
    expect(parseConfig(environment(rows)).errors[0]!.code).toBe('canvas_connections_invalid');
  });

  it.each(['invalid-json-with-fake-secret', JSON.stringify(connections())])('refuses diagnostics with a configured connections secret', (raw) => {
    expect(parseConfig({ CANVAS_CONNECTIONS: raw, DIAGNOSTICS_ENABLED: 'true' }).errors.some((issue) => issue.code === 'diagnostics_with_credentials')).toBe(true);
  });

  it('recognizes the port-specific discovery tool in policy and disable settings', () => {
    expect(resolveToolPolicy('list_canvas_instances')).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    expect(parseConfig(environment(connections(), { DISABLED_TOOLS: 'list_canvas_instances' })).warnings).toEqual([]);
  });
});

describe.each(['native', 'sdk'])('multi-connection MCP (%s)', (backend) => {
  it('advertises school selection consistently and discovers connections without Canvas calls', async () => {
    const h = harness(connections(), backend);
    const listed = await h.rpc('tools/list');
    const tools = (listed.body.result as ToolResult & { tools: Array<{ name: string; inputSchema: Record<string, unknown>; description: string }> }).tools;
    for (const def of ALL_TOOLS.filter((tool) => !tool.gate?.diagnostics)) {
      const advertised = tools.find((tool) => tool.name === def.name)!;
      expect(advertised.inputSchema).toEqual(inputSchemaFor(def));
      if (def.canvasScope !== 'none') expect(advertised.description).toContain('canvas_instance');
    }
    const discovery = await h.call('list_canvas_instances');
    expect(discovery.body.result.structuredContent).toEqual({ connections: connections().map((row) => ({ id: row.id, name: row.name, available: true })) });
    expect(h.calls()).toHaveLength(0);
  });

  it.each(['list_courses', 'get_my_enrollments', 'get_my_course_grades', 'get_my_todo_items', 'get_my_upcoming_assignments', 'get_my_profile'])('aggregates %s across all custom connections', async (tool) => {
    const rows = connections();
    const h = harness(rows, backend);
    const { body } = await h.call(tool);
    expect(body.result.isError).toBe(false);
    const text = body.result.content[0]!.text;
    let last = -1;
    for (const row of rows) {
      const position = text.indexOf(`Canvas: ${row.name} (${row.id})`);
      expect(position).toBeGreaterThan(last);
      last = position;
      const sent = h.calls().filter((call) => new URL(call.url).origin === row.url);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((call) => call.headers.authorization === `Bearer ${row.token}`)).toBe(true);
      expect(JSON.stringify(body)).not.toContain(row.token);
      if (tool === 'get_my_upcoming_assignments') expect(text.indexOf(`day 1 at ${row.id}`)).toBeLessThan(text.indexOf(`day 2 at ${row.id}`));
    }
  });

  it('only queries the selected connection, with duplicate course IDs and codes isolated', async () => {
    const rows = connections();
    const h = harness(rows, backend);
    for (const identifier of [17, 'SAME_CODE']) {
      for (const row of rows) {
        const { body } = await h.call('get_course_details', { canvas_instance: row.id, course_identifier: identifier });
        expect(body.result.isError).toBe(false);
        expect(body.result.content[0]!.text).toContain(`Course at ${row.id}`);
        for (const other of rows.filter((candidate) => candidate.id !== row.id)) expect(body.result.content[0]!.text).not.toContain(`Course at ${other.id}`);
      }
    }
    h.fakes.forEach((fake) => { fake.calls.length = 0; });
    await h.call('list_courses', { canvas_instance: rows[1]!.id });
    expect(h.fakes[0]!.calls).toHaveLength(0);
    expect(h.fakes[1]!.calls).toHaveLength(1);
    expect(h.fakes[2]!.calls).toHaveLength(0);
  });

  it.each([
    ['get_course_details', { course_identifier: 17 }],
    ['list_assignments', { course_identifier: 17 }],
    ['get_assignment_details', { course_identifier: 17, assignment_id: 23 }],
    ['get_my_submission', { course_identifier: 17, assignment_id: 23 }],
    ['list_courses', { canvas_instance: 'unknown' }],
  ])('refuses ambiguous or unknown routing for %s before Canvas fetch', async (tool, args) => {
    const h = harness(connections(), backend);
    const { body } = await h.call(tool as string, args as Record<string, unknown>);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('canvas_instance');
    expect(h.calls()).toHaveLength(0);
  });

  it('automatically selects a sole custom connection', async () => {
    const h = harness(connections(1), backend);
    const { body } = await h.call('get_course_details', { course_identifier: 17 });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]!.text).toContain('Course at custom_0');
    expect(h.calls()).toHaveLength(1);
  });

  it('preserves healthy results and explicitly marks a failed connection', async () => {
    const h = harness(connections(), backend);
    h.fakes[1]!.route('get', '/api/v1/courses', () => json({ error: 'Expired' }, { status: 401 }));
    const { body } = await h.call('list_courses');
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]!.text).toContain('Incomplete connections: custom_1');
    expect(body.result.content[0]!.text).toContain('Course at custom_0');
    expect(body.result.content[0]!.text).toContain('Course at custom_2');
  });

  it('returns an error when every connection fails', async () => {
    const h = harness(connections(), backend);
    h.fakes.forEach((fake) => fake.route('get', '/api/v1/courses', () => json({ error: 'Expired' }, { status: 401 })));
    const { body } = await h.call('list_courses');
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('All Canvas connections failed');
  });

  it('never releases credentials to unauthorized callers, including metadata discovery', async () => {
    const h = harness(connections(), backend);
    for (const tool of ['list_courses', 'list_canvas_instances']) expect((await h.call(tool, {}, false)).response.status).toBe(403);
    expect(h.calls()).toHaveLength(0);
  });
});

describe('cross-connection isolation and shared limits', () => {
  it('refreshes the connection list from env when connections are added or removed', async () => {
    const rows = connections();
    const h = harness(rows);
    const first = await h.call('list_courses', {}, true, environment(rows.slice(0, 1), { MCP_BACKEND: 'native' }));
    expect(first.body.result.content[0]!.text).not.toContain(rows[1]!.name);
    const all = await h.call('list_courses');
    expect(all.body.result.content[0]!.text).toContain(rows[2]!.name);
    const removed = await h.call('list_courses', { canvas_instance: rows[0]!.id }, true, environment(rows.slice(1), { MCP_BACKEND: 'native' }));
    expect(removed.body.result.isError).toBe(true);
  });

  it('keeps per-connection tier limits and never multiplies the total budget', async () => {
    const h = harness(connections(3), 'native', { CANVAS_REQUEST_BUDGET: 10 });
    h.fakes.forEach((fake, i) => fake.paginate('/api/v1/courses', Array.from({ length: 10 }, (_, n) => ({ id: n, name: `course ${i}-${n}` })), 1));
    const { body } = await h.call('list_courses');
    expect(h.fakes.map((fake) => fake.calls.length)).toEqual([6, 4, 0]);
    expect(body.result.content[0]!.text).toContain('Incomplete connections: custom_0, custom_1, custom_2');
    expect(body.result.content[0]!.text).toContain('request budget exhausted');
    expect(body.result.content[0]!.text).toContain('Results truncated');
    expect(h.logLines.some((line) => line.includes('"subrequests":10'))).toBe(true);
  });

  it('lists connections skipped when the shared deadline expires', async () => {
    let clock = 100;
    const h = harness(connections(), 'native', { TOOL_DEADLINE_MS: 10 }, () => clock);
    h.fakes[0]!.route('get', '/api/v1/users/self/profile', () => { clock = 111; return json({ id: 5, name: 'Owner' }); });
    const { body } = await h.call('get_my_profile');
    expect(h.calls()).toHaveLength(1);
    expect(body.result.content[0]!.text).toContain('Incomplete connections: custom_1, custom_2');
    expect(body.result.content[0]!.text).toContain('tool deadline reached');
  });

  it('skips invalid connection credentials and redacts sibling and rejected tokens from output and logs', async () => {
    const rows = connections();
    rows[1]!.token = 'rejected fake token';
    const h = harness(rows);
    h.fakes[0]!.route('get', '/api/v1/users/self/profile', () => json({ id: 5, name: `${rows[1]!.token} ${rows[2]!.token}` }));
    const { body } = await h.call('get_my_profile');
    const status = await (await h.status()).text();
    for (const row of rows) expect(JSON.stringify(body) + status + h.logLines.join('\n')).not.toContain(row.token);
    expect(h.fakes[1]!.calls).toHaveLength(0);
    expect(body.result.content[0]!.text).toContain('Incomplete connections: custom_1');
    expect(body.result.content[0]!.text).toContain('[REDACTED]');
  });

  it('bounds aggregate output and closes Canvas content fences after truncation', async () => {
    const h = harness(connections(), 'native', { MAX_TOOL_RESULT_BYTES: 800 });
    h.fakes.forEach((fake) => fake.route('get', '/api/v1/users/self/todo', () => json([{ assignment: { name: 'Untrusted title\n'.repeat(200) } }])));
    const { body } = await h.call('get_my_todo_items');
    const text = body.result.content[0]!.text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(800);
    expect(text).toMatch(/truncated|too large|exceeds/i);
    expect((text.match(/<<<UNTRUSTED CANVAS CONTENT/g) ?? []).length)
      .toBe((text.match(/<<<UNTRUSTED CANVAS CONTENT[\s\S]*?>>>/g) ?? []).length);
  });

  it('child meters charge the parent and release only their own reservations', () => {
    const parent = new SubrequestMeter(5);
    const first = new SubrequestMeter(3, parent);
    const second = new SubrequestMeter(4, parent);
    expect(first.reserve(2)).toBe(true);
    expect(second.take('canvas', 3)).toBe(true);
    expect(second.take('canvas')).toBe(false);
    expect(first.takeReserved('d1')).toBe(true);
    first.release();
    expect(parent.reserved).toBe(0);
    expect(second.take('canvas')).toBe(true);
    expect(parent.used).toBe(5);
    expect(parent.counts).toEqual({ canvas: 4, d1: 1, r2: 0 });
  });

  it('a child read-back cannot consume a sibling reservation', () => {
    const parent = new SubrequestMeter(5);
    const first = new SubrequestMeter(5, parent);
    const second = new SubrequestMeter(5, parent);
    expect(first.reserve(2)).toBe(true);
    expect(second.reserve(1)).toBe(true);
    expect(first.takeReserved('canvas', 3)).toBe(true);
    expect(parent.reserved).toBe(1);
    expect(parent.remaining).toBe(1);
    expect(first.take('canvas')).toBe(true);
    expect(first.take('canvas')).toBe(false);
    expect(second.takeReserved('d1')).toBe(true);
    expect(parent.used).toBe(5);
  });
});

describe('multi-connection owner status checks', () => {
  it('shows custom metadata and escaped names without secrets', async () => {
    const rows = connections();
    rows[0]!.name = '<script>custom</script>';
    const h = harness(rows);
    const status = await (await h.status()).json() as { status: { canvas_connections: Array<{ id: string; name: string; host: string }> } };
    expect(status.status.canvas_connections.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(status.status.canvas_connections[0]!.host).toBe('learning-0.example.edu');
    const html = await (await h.status('/')).text();
    expect(html).toContain('&lt;script&gt;custom&lt;/script&gt;');
    expect(html).not.toContain(rows[0]!.name);
    for (const row of rows) expect(JSON.stringify(status) + html).not.toContain(row.token);
    expect(h.calls()).toHaveLength(0);
  });

  it('checks every connection with its own token and returns no profile fields', async () => {
    const rows = connections();
    const h = harness(rows);
    h.fakes[1]!.route('get', '/api/v1/users/self', () => json({ error: 'expired' }, { status: 401 }));
    const checked = await (await h.status('/api/status/check', 'POST', { ...OWNER_HEADERS, origin: SITE })).json();
    expect(checked).toEqual({ ok: false, connections: rows.map((row, i) => ({ id: row.id, name: row.name, ok: i !== 1, status: i === 1 ? 401 : 200 })) });
    rows.forEach((row, i) => expect(h.fakes[i]!.calls[0]!.headers.authorization).toBe(`Bearer ${row.token}`));
    expect(JSON.stringify(checked)).not.toContain('NEVER_RETURN_PROFILE');
  });

  it('checks only the requested connection and rejects unknown IDs without a fetch', async () => {
    const h = harness();
    const headers = { ...OWNER_HEADERS, origin: SITE };
    const response = await h.status('/api/status/check?canvas_instance=custom_2', 'POST', headers);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
    expect(h.fakes.map((fake) => fake.calls.length)).toEqual([0, 0, 1]);
    await h.status('/api/status/check?canvas_instance=unknown', 'POST', headers);
    expect(h.calls()).toHaveLength(1);
  });

  it('enforces owner identity and same-origin POST before checking any connection', async () => {
    const h = harness();
    expect((await h.status('/api/status/check', 'POST')).status).toBe(403);
    expect((await h.status('/api/status/check', 'POST', { origin: SITE })).status).toBe(403);
    expect((await h.status('/api/status/check', 'POST', { ...OWNER_HEADERS, origin: 'https://evil.example' })).status).toBe(403);
    expect(h.calls()).toHaveLength(0);
  });

  it('bounds all-connection checks and lists skipped connections', async () => {
    const h = harness(connections(8), 'native', { CANVAS_REQUEST_BUDGET: 5 });
    const checked = await (await h.status('/api/status/check', 'POST', { ...OWNER_HEADERS, origin: SITE })).json() as { ok: boolean; connections: Array<{ id: string; reason?: string }> };
    expect(h.calls()).toHaveLength(5);
    expect(checked.ok).toBe(false);
    expect(checked.connections.slice(5).map((row) => row.reason)).toEqual(['budget_or_deadline', 'budget_or_deadline', 'budget_or_deadline']);
  });
});
