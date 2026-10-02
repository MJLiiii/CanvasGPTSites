import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function siteDirectory(args = process.argv.slice(2)) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--site-dir' || !args[1])) {
    throw new Error('Usage: node scripts/<prepare-site|sync-site-source>.mjs [--site-dir <directory>]');
  }
  const site = await realpath(resolve(process.cwd(), args[1] ?? resolve(root, 'site')));
  const sourceRoot = await realpath(root);
  const inside = relative(site, sourceRoot);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('The Site directory must not contain the source repository.');
  }
  const first = relative(sourceRoot, site).split(sep)[0];
  if (['src', 'test', 'docs', 'scripts', 'build', 'entry', 'node_modules', '.git', '.upstream'].includes(first)) {
    throw new Error('The Site directory must be separate from handwritten source and repository metadata.');
  }
  return site;
}
