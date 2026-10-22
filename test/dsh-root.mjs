/**
 * Locate the DSH install whose packages this suite should read.
 *
 * `DSH_ROOT` wins; otherwise the running interpreter's own `node_modules` is the
 * authoritative guess (a global install puts `@deepseek-ai/dsh` next to the
 * `node` binary that launches it). Shared by every suite that needs a real DSH
 * package, so the discovery rule lives in one place.
 *
 * @returns the absolute DSH package root.
 * @throws when no candidate looks like a DSH install.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveDshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const root of candidates) {
    if (existsSync(join(root, 'lib', 'bin.js'))) return root;
  }
  throw new Error(`could not locate the DSH install; tried:\n  ${candidates.join('\n  ')}`);
}

/**
 * Absolute path of one installed DSH package's entry file.
 * @param dshRoot - the DSH package root.
 * @param segments - path segments below `node_modules`.
 * @returns the absolute file path.
 */
export function dshPackageFile(dshRoot, ...segments) {
  return join(dshRoot, 'node_modules', ...segments);
}
