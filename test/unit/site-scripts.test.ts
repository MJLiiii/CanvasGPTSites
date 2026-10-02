// Exercise the public deployment helpers in isolated directories with fake Site identities.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const directories: string[] = [];
const entry = `import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const binding = ctx.props?.CONNECTORS;
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};
`;
const vite = 'import hostingConfig from "./.openai/hosting.json";\nconst config = { binding: d1 };\n';
function scaffold(manifest: Record<string, unknown> = { d1: null, r2: null }) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-site-script-'));
  directories.push(dir);
  mkdirSync(join(dir, '.openai'));
  mkdirSync(join(dir, 'build'));
  writeFileSync(join(dir, '.openai/hosting.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'build/sites-worker.ts'), entry);
  writeFileSync(join(dir, 'vite.config.ts'), vite);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { vinext: 'test-version' }, scripts: { build: 'official-build' } }));
  return dir;
}
const run = (script: string, dir: string, args = ['--site-dir', dir]) =>
  execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Site preparation', () => {
  it('accepts the official starter with Vinext as a development dependency', () => {
    const dir = scaffold();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {}, devDependencies: { vinext: 'test-version' }, scripts: { build: 'official-build' } }));
    run('prepare-site.mjs', dir);
    expect(JSON.parse(read(dir, '.openai/hosting.json')).capabilities).toEqual(['mcp']);
  });

  it('preserves Site identity, extra capabilities, and official config; repeats without changes', () => {
    const dir = scaffold({ project_id: 'appgprj_fake_owner', d1: null, r2: 'FILES', capabilities: ['other'] });
    const pkg = read(dir, 'package.json');
    run('prepare-site.mjs', dir);
    const manifest = JSON.parse(read(dir, '.openai/hosting.json'));
    expect(manifest).toEqual({ project_id: 'appgprj_fake_owner', d1: 'DB', r2: 'FILES', capabilities: ['other', 'mcp'] });
    const prepared = read(dir, 'build/sites-worker.ts');
    for (const path of ['/mcp', '/api/', '/', '/healthz', '/robots.txt', '/files/']) expect(prepared).toContain(`"${path}"`);
    expect(prepared).toContain('app.fetch(request, env as unknown as Env, ctx)');
    expect(prepared).toContain('handler.fetch(request, env, ctx)');
    run('prepare-site.mjs', dir);
    expect(read(dir, 'build/sites-worker.ts')).toBe(prepared);
    expect(read(dir, 'vite.config.ts')).toBe(vite);
    expect(read(dir, 'package.json')).toBe(pkg);
    expect(JSON.parse(read(dir, '.openai/hosting.json'))).toEqual(manifest);
  });

  it.each([{ d1: 'OTHER' }, { r2: 'OTHER' }, { static: { directory: 'dist' } }, { capabilities: 'mcp' }])('rejects conflicting manifests without partial edits: %j', (manifest) => {
    const dir = scaffold(manifest);
    const before = read(dir, '.openai/hosting.json');
    expect(() => run('prepare-site.mjs', dir)).toThrow();
    expect(read(dir, 'build/sites-worker.ts')).toBe(entry);
    expect(read(dir, '.openai/hosting.json')).toBe(before);
  });

  it('rejects an unfamiliar entry and a modified routing block before changing bindings', () => {
    const dir = scaffold();
    writeFileSync(join(dir, 'build/sites-worker.ts'), 'export default customHandler;');
    expect(() => run('prepare-site.mjs', dir)).toThrow();
    expect(JSON.parse(read(dir, '.openai/hosting.json')).d1).toBeNull();
    writeFileSync(join(dir, 'build/sites-worker.ts'), entry);
    run('prepare-site.mjs', dir);
    const altered = read(dir, 'build/sites-worker.ts').replace('"/mcp"', '"/wrong"');
    writeFileSync(join(dir, 'build/sites-worker.ts'), altered);
    expect(() => run('prepare-site.mjs', dir)).toThrow();
    expect(read(dir, 'build/sites-worker.ts')).toBe(altered);
  });

  it('refuses repository and handwritten directories and malformed CLI arguments', () => {
    expect(() => run('prepare-site.mjs', root)).toThrow();
    expect(() => run('sync-site-source.mjs', join(root, 'src'))).toThrow();
    expect(() => run('prepare-site.mjs', scaffold(), ['--unknown'])).toThrow();
  });
});

describe('Source synchronization', () => {
  it('requires registration before touching destination source', () => {
    const dir = scaffold();
    run('prepare-site.mjs', dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/keep.txt'), 'keep');
    expect(() => run('sync-site-source.mjs', dir)).toThrow();
    expect(read(dir, 'src/keep.txt')).toBe('keep');
  });

  it('copies authoritative source unchanged and preserves identity, official scripts and dependencies', () => {
    const dir = scaffold({ project_id: 'appgprj_fake_owner' });
    run('prepare-site.mjs', dir);
    const before = read(dir, '.openai/hosting.json');
    run('sync-site-source.mjs', dir);
    expect(read(dir, '.openai/hosting.json')).toBe(before);
    expect(read(dir, 'src/app.ts')).toBe(readFileSync(join(root, 'src/app.ts'), 'utf8'));
    const pkg = JSON.parse(read(dir, 'package.json'));
    expect(pkg.scripts.build).toBe('official-build');
    expect(pkg.dependencies.vinext).toBe('test-version');
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBeDefined();
    run('sync-site-source.mjs', dir);
    expect(read(dir, '.openai/hosting.json')).toBe(before);
  });
});
