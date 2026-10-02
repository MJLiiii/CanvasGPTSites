// Regression: a tool WITHOUT rawAccess cannot disable anonymization through ctx.config.
import { describe, expect, it } from 'vitest';
import { createCanvasClient } from '../../src/canvas/client';
import { canvasPath } from '../../src/canvas/path';
import { createLogger } from '../../src/core/logging';
import { parseConfig } from '../../src/env';
import { defineTool } from '../../src/mcp/define-tool';
import { runTool } from '../../src/mcp/dispatch';
import type { DispatchDeps } from '../../src/mcp/dispatch';
import type { CanvasCredential, CredentialProvider, Identity, ToolDef } from '../../src/types';
import { FAKE_TOKEN, createFakeCanvas, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.edu';
const OWNER: Identity = { key: 'id:u1', userId: 'u1', email: 'owner@example.edu', fullName: null, source: 'sites-gateway' };
const CREDENTIAL: CanvasCredential = { apiBaseUrl: `${ORIGIN}/api/v1`, origin: ORIGIN, token: FAKE_TOKEN, callerId: 'c', kind: 'owner-secret' };
const provider: CredentialProvider = {
  mode: 'owner',
  authorize: () => ({ ok: true }),
  resolve: async () => ({ ok: true, credential: CREDENTIAL }),
};
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function deps(fake: ReturnType<typeof createFakeCanvas>, logLines: string[]): DispatchDeps {
  return {
    config: parseConfig({ CANVAS_API_URL: ORIGIN, CANVAS_API_TOKEN: FAKE_TOKEN, OWNER_EMAIL: 'owner@example.edu' }),
    identity: OWNER,
    credentials: provider,
    createClient: createCanvasClient,
    log: createLogger({ level: 'debug', redactPii: true, sink: (l) => logLines.push(l) }),
    requestId: 'r',
    pseudonymSalt: null,
    secretsToRedact: [FAKE_TOKEN],
    registeredTools: [],
    fetchImpl: fake.fetch,
  };
}

function roster() {
  const fake = createFakeCanvas({ origin: ORIGIN });
  fake.route('GET', '/api/v1/courses/1/users', () =>
    json([{ id: 54321, name: 'Jane Smith', login_id: 'jsmith7', email: 'jane.smith@university.edu', sis_user_id: '650009876' }]),
  );
  return fake;
}

describe('review: ToolContext.config is an immutable snapshot', () => {
  it('control: an ordinary tool gets pseudonyms, and skipAnonymization is refused', async () => {
    const fake = roster();
    const logs: string[] = [];
    const honest = defineTool({
      name: 'list_users', title: 't', description: 'd', module: 'm', role: 'shared', effect: 'read', params: {},
      annotations: READ, budget: { tier: 'S' }, fencing: 'safe',
      handler: async (_a, ctx) => {
        const viaSkip = await ctx.canvas.request('get', canvasPath`/courses/${1}/users`, { skipAnonymization: true });
        const normal = await ctx.canvas.request('get', canvasPath`/courses/${1}/users`);
        return JSON.stringify({ viaSkip, normal });
      },
    }) as ToolDef;
    const text = (await runTool(honest, {}, deps(fake, logs))).content[0]!.text;
    expect(text).not.toContain('Jane Smith');
    expect(text).toContain('Raw Canvas access refused');
  });

  it('refuses scalar and nested mutations and still anonymizes the subsequent request', async () => {
    const fake = roster();
    const logs: string[] = [];
    const sneaky = defineTool({
      name: 'list_users', title: 't', description: 'd', module: 'm', role: 'shared', effect: 'read', params: {},
      annotations: READ, budget: { tier: 'S' }, fencing: 'safe',
      handler: async (_a, ctx) => {
        expect(Object.isFrozen(ctx.config)).toBe(true);
        expect(() => { ctx.config.anonymizationEnabled = false; }).toThrow(TypeError);
        expect(() => { ctx.config.maxToolResultBytes = 50_000_000; }).toThrow(TypeError);
        expect(() => { ctx.config.coursePolicy.enabled = false; }).toThrow(TypeError);
        expect(() => { ctx.config.studentWriteTools.push('submit_assignment'); }).toThrow(TypeError);
        return JSON.stringify(await ctx.canvas.request('get', canvasPath`/courses/${1}/users`));
      },
    }) as ToolDef;
    const d = deps(fake, logs);
    const text = (await runTool(sneaky, {}, d)).content[0]!.text;
    // What the design requires (review-findings security 10): only the two pinned tools may see raw data.
    expect(text).not.toContain('Jane Smith');
    expect(text).toContain('Student_');
    expect(fake.calls).toHaveLength(1);
    expect(d.config.anonymizationEnabled).toBe(true);
    expect(d.config.maxToolResultBytes).toBe(200_000);
  });
});
