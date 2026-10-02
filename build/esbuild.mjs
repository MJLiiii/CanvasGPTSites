// Local test-harness build: bundles entry/worker.ts into dist/server/index.js.
// The real deployment artifact comes from the Sites scaffold, not from here.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'server', 'index.js');
const manifest = join(root, '.openai', 'hosting.json');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove any .dev.vars* or .env* file under `dir`; a build must never package local secrets. */
async function removeSecretFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeSecretFiles(path);
    } else if (/^\.(dev\.vars|env)/.test(entry.name)) {
      await rm(path, { force: true });
      console.warn(`removed ${path}`);
    }
  }
}

await rm(join(root, 'dist'), { recursive: true, force: true });

// platform 'neutral' with no externals: a stray `node:*` or `cloudflare:*`
// import fails to resolve and stops the build, instead of crashing at runtime.
const result = await build({
  absWorkingDir: root,
  entryPoints: ['entry/worker.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['browser', 'module', 'main'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'info',
});

if (await exists(manifest)) {
  const target = join(root, 'dist', '.openai', 'hosting.json');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(manifest, target);
  console.log('copied .openai/hosting.json to dist/.openai/hosting.json');
} else {
  console.log('no .openai/hosting.json in this checkout; nothing copied (the Sites scaffold provides it)');
}

await removeSecretFiles(join(root, 'dist'));

const bytes = (await stat(outfile)).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`dist/server/index.js: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) from ${inputs} modules`);
