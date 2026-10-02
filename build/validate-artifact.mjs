// Checks the build output before anything is packaged: the entry exists and loads under plain Node,
// and nothing under dist/ is a local secrets file or contains something shaped like a Canvas token.
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The official Sites wrapper may import Workers-only modules. Its runtime is
// checked through the local Worker preview; this mode still scans every byte.
const scanOnly = process.argv.includes('--scan-only');
const dist = join(root, 'dist');
const entry = join(dist, 'server', 'index.js');

// Canvas access tokens look like "<digits>~<40 or more alphanumerics>". The digit run has no upper
// bound: a prefix longer than expected must not let a token through.
const CANVAS_TOKEN_PATTERN = /\d+~[A-Za-z0-9]{40,}/;
const SECRET_FILE_NAME = /^\.(dev\.vars|env)/;

const problems = [];

async function walk(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

let entryExists = false;
try {
  entryExists = (await stat(entry)).isFile();
} catch {
  entryExists = false;
}

if (!entryExists) {
  problems.push('dist/server/index.js does not exist; run the build first');
} else {
  for (const file of await walk(dist)) {
    const name = relative(root, file);
    if (SECRET_FILE_NAME.test(file.split(/[\\/]/).pop() ?? '')) {
      problems.push(`${name}: a local secrets file must never be packaged`);
      continue;
    }
    // latin1 maps every byte to one character, so binary files can be scanned too.
    if (CANVAS_TOKEN_PATTERN.test(await readFile(file, 'latin1'))) {
      problems.push(`${name}: contains text shaped like a Canvas API token`);
    }
  }

  if (!scanOnly) try {
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.default?.fetch !== 'function') {
      problems.push('dist/server/index.js: the default export has no fetch function');
    } else {
      // No bindings and no secrets: the health route must still answer.
      const response = await module.default.fetch(new Request('https://artifact.invalid/healthz'), { LOG_LEVEL: 'error' }, {});
      const text = await response.text();
      if (response.status !== 200 || text !== 'ok') {
        problems.push(`dist/server/index.js: GET /healthz answered ${response.status} instead of 200 "ok"`);
      }
    }
  } catch (error) {
    problems.push(`dist/server/index.js: cannot be imported under Node (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`artifact check failed: ${problem}`);
  }
  process.exit(1);
}

const size = (await stat(entry)).size;
console.log(`artifact ok: dist/server/index.js (${size} bytes)${scanOnly ? ' (security scan only)' : ' imports under Node and exports default.fetch'}; no secrets files or token-shaped text in dist/`);
