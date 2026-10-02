// Adapt a generated official Vinext starter; registration and secrets stay with Sites.
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { siteDirectory } from './site-directory.mjs';

const site = await siteDirectory();
const manifestPath = join(site, '.openai', 'hosting.json');
const entryPath = join(site, 'build', 'sites-worker.ts');
const packagePath = join(site, 'package.json');
const vitePath = join(site, 'vite.config.ts');
// Validate every input before modifying any file.
for (const path of [manifestPath, entryPath, packagePath, vitePath]) {
  if (!(await lstat(path)).isFile()) throw new Error('Expected regular official scaffold files, not symlinks.');
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  throw new Error('Invalid hosting manifest.');
}
if (manifest.static || (manifest.d1 != null && manifest.d1 !== 'DB') || (manifest.r2 != null && manifest.r2 !== 'FILES')) {
  throw new Error('Conflicting hosting bindings: this app expects DB and optional FILES on a Worker Site.');
}
if (manifest.capabilities !== undefined && (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((x) => typeof x !== 'string'))) {
  throw new Error('Invalid hosting capabilities.');
}
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const vite = await readFile(vitePath, 'utf8');
let entry = await readFile(entryPath, 'utf8');
if (!(pkg.dependencies?.vinext || pkg.devDependencies?.vinext) || !pkg.scripts?.build || !vite.includes('"./.openai/hosting.json"') || !vite.includes('binding: d1')) {
  throw new Error('Unrecognized official Vinext scaffold; no files changed.');
}
const fallback = '    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));';
const legacy = `    const path = new URL(request.url).pathname;
    const canvasRoute = path === "/mcp" || path.startsWith("/api/") || path === "/" ||
      path === "/healthz" || path === "/robots.txt" || path.startsWith("/files/");
    return runWithConnectorBinding(binding, () => canvasRoute
      ? app.fetch(request, env as unknown as Env, ctx)
      : handler.fetch(request, env, ctx));`;
const routing = `    // canvas-gpt-sites:begin
${legacy}
    // canvas-gpt-sites:end`;
const appImport = 'import { createApp } from "../src/app";';
const envImport = 'import type { Env } from "../src/types";';
const appDeclaration = 'const app = createApp();';
const count = (text, needle) => text.split(needle).length - 1;
const adapted = entry.includes('// canvas-gpt-sites:begin') || entry.includes(legacy);
if (adapted) {
  if (count(entry, legacy) !== 1 || count(entry, appImport) !== 1 || count(entry, envImport) !== 1 || count(entry, appDeclaration) !== 1 || entry.includes(fallback)) {
    throw new Error('Unrecognized existing Canvas routing; no files changed.');
  }
  if (entry.includes('// canvas-gpt-sites:begin') && (count(entry, routing) !== 1 || count(entry, '// canvas-gpt-sites:begin') !== 1 || count(entry, '// canvas-gpt-sites:end') !== 1)) {
    throw new Error('Modified Canvas routing markers; no files changed.');
  }
  if (!entry.includes(routing)) entry = entry.replace(legacy, routing);
} else {
  if (count(entry, fallback) !== 1 || count(entry, 'export default {') !== 1 || entry.includes('createApp') || !entry.includes('fetch(request: Request, env: Cloudflare.Env, ctx:')) {
    throw new Error('Unrecognized Site entry; no files changed.');
  }
  entry = entry.replace('export default {', `${appImport}\n${envImport}\n\n${appDeclaration}\n\nexport default {`).replace(fallback, routing);
}
manifest.d1 = 'DB';
manifest.r2 ??= null;
manifest.capabilities = [...new Set([...(manifest.capabilities ?? []), 'mcp'])];
await writeFile(entryPath, entry);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared Canvas routing and MCP bindings. Site identity and official build configuration preserved.');
