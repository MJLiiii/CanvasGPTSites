// The repository's src/ is authoritative. Copy it unchanged into the Sites checkout.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, siteDirectory } from './site-directory.mjs';

const site = await siteDirectory();
const manifestPath = join(site, '.openai', 'hosting.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (typeof manifest.project_id !== 'string' || !manifest.project_id.trim()) throw new Error('Register the Site before syncing its source.');
if (manifest.d1 !== 'DB' || !manifest.capabilities?.includes('mcp')) throw new Error('Run prepare-site.mjs before syncing.');
const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sitePackagePath = join(site, 'package.json');
const sitePackage = JSON.parse(await readFile(sitePackagePath, 'utf8'));
if (!sitePackage.dependencies || typeof sitePackage.dependencies !== 'object' || Array.isArray(sitePackage.dependencies)) {
  throw new Error('Expected an official Site package with runtime dependencies.');
}
const changed = Object.entries(sourcePackage.dependencies).some(([name, version]) => sitePackage.dependencies[name] !== version);
Object.assign(sitePackage.dependencies, sourcePackage.dependencies);
await rm(join(site, 'src'), { recursive: true, force: true });
await cp(join(root, 'src'), join(site, 'src'), { recursive: true });
await mkdir(join(site, 'drizzle'), { recursive: true });
await writeFile(sitePackagePath, JSON.stringify(sitePackage, null, 2) + '\n');
console.log('Copied src/ unchanged and merged its runtime dependencies into the Site.');
if (changed) console.log('Dependencies changed: run npm install --package-lock-only --ignore-scripts in the Site, then its official dependency installer.');
