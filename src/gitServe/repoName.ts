/*
 * A repository is a name, never a path (GIT_SERVE_SPEC R-GS-6).
 *
 * A request names a repository by a string that matches `[A-Za-z0-9_-]+`. The
 * server joins it to the root as `<root>/<name>.git`, one level, and then checks
 * what is actually on disk: the entry must be a real directory (not a symlink),
 * it must still sit directly under the root once symlinks in the root itself are
 * resolved, and it must hold its own objects. A repository that borrows objects
 * through `objects/info/alternates` is refused, because its object store reaches
 * a directory the root does not contain.
 *
 * Every refusal after the name check is the same answer as a name that does not
 * exist, so a caller cannot tell a symlinked repository from a missing one.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const REPO_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const REPO_DIR_SUFFIX = '.git';

export const isRepoName = (name: unknown): name is string =>
  typeof name === 'string' && name.length > 0 && name.length <= 255 && REPO_NAME_RE.test(name);

export type RepoResolution =
  | { ok: true; name: string; dir: string }
  /** `malformed`: the name is not a repository name. `unknown`: nothing servable is there. */
  | { ok: false; reason: 'malformed' | 'unknown' };

/**
 * Resolves a repository name under `root` (an absolute path whose own symlinks
 * are already resolved). Reads the disk on every call: a repository created or
 * removed while the server runs is seen at the next request.
 */
export const resolveRepo = (root: string, name: unknown): RepoResolution => {
  if (!isRepoName(name)) return { ok: false, reason: 'malformed' };
  const dir = join(root, name + REPO_DIR_SUFFIX);
  try {
    // lstat, not stat: a symlink is refused, whatever it points at.
    if (!lstatSync(dir).isDirectory()) return { ok: false, reason: 'unknown' };
    // The entry must still be a direct child of the root after resolution. With
    // the name rule and the lstat above this cannot fail today; it stays as the
    // direct statement of "never leaves <root>", in case either of them changes.
    if (dirname(realpathSync(dir)) !== root) return { ok: false, reason: 'unknown' };
    // A bare repository has HEAD and objects/ at its top level.
    if (!lstatSync(join(dir, 'HEAD')).isFile()) return { ok: false, reason: 'unknown' };
    if (!lstatSync(join(dir, 'objects')).isDirectory()) return { ok: false, reason: 'unknown' };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  if (existsSync(join(dir, 'objects', 'info', 'alternates'))) {
    return { ok: false, reason: 'unknown' };
  }
  return { ok: true, name, dir };
};

/** The servable repositories directly under `root`, sorted by name. */
export const listRepos = (root: string): Array<{ name: string; dir: string }> => {
  const out: Array<{ name: string; dir: string }> = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(REPO_DIR_SUFFIX)) continue;
    const resolved = resolveRepo(root, entry.slice(0, -REPO_DIR_SUFFIX.length));
    if (resolved.ok) out.push({ name: resolved.name, dir: resolved.dir });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};
