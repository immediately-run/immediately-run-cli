/*
 * UI_RELEASES_SPEC §3.4 / §5 step 5a — bake the registry-hosted zips for a
 * release lock's pins.
 *
 * A release lock pins commits the app repos' own Pages will not keep: R3-624
 * publishes each push's `<sha>.zip` beside the branch zip, but a Pages deploy
 * REPLACES the whole site — only the branch zip and the current head's sha zip
 * are ever resident (ZIP_CACHE_AUTOMATION §5.3). The registry therefore hosts
 * the bytes it pins, content-addressed at `zips/<ns>/<repo>/<commit>.zip`.
 *
 * Immutability is by construction: an existing path is REUSED, never rebuilt —
 * a cache zip embeds `capturedAt`, so a rebuild would differ, and the path is
 * content-addressed (§3.4: different bytes at an existing path is impossible
 * unless the commit itself changed, which git forbids). Only absent pins are
 * built, and building means materializing the commit first: the cache-zip
 * engine archives HEAD (`cacheZip.ts`), so the pin is checked out into a temp
 * clone and the engine runs with HEAD === the pin and `ref: <commit>` — the
 * sidecar coordinate a §6.4 host matches (`ref === commit === pin`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCacheZip } from './cacheZip.js';
import type { ReleaseLockEntry } from '../release.js';

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Materialize `namespace/repository` at exactly `commit` into a temp clone
 * (blob-less + no-checkout, then a depth-1 fetch of the pin), returning the
 * path. The caller owns removing the directory. `remoteUrl` is injectable so
 * tests can bake against a local `file://` fixture instead of GitHub. */
export const materializeCommit = (
  namespace: string,
  repository: string,
  commit: string,
  remoteUrl?: string,
): string => {
  const url = remoteUrl ?? `https://github.com/${namespace}/${repository}.git`;
  const dest = mkdtempSync(join(tmpdir(), `ir-release-bake-${repository}-`));
  try {
    execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(dest, ['fetch', '--quiet', '--depth', '1', 'origin', commit]);
    git(dest, ['checkout', '--quiet', '--detach', commit]);
    return dest;
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pin-release: could not materialize ${namespace}/${repository}@${commit}: ${msg}`);
  }
};

/** The default branch of `namespace/repository`, from the remote's HEAD symref
 *  (a blob-less clone does not reliably carry origin/HEAD). `remoteUrl` is the
 *  test seam, same as `materializeCommit`. */
export const remoteDefaultBranch = (namespace: string, repository: string, remoteUrl?: string): string => {
  const url = remoteUrl ?? `https://github.com/${namespace}/${repository}.git`;
  try {
    const out = execFileSync('git', ['ls-remote', '--symref', url, 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = /^ref: refs\/heads\/(\S+)/m.exec(out);
    return m?.[1] ?? 'main';
  } catch {
    return 'main'; // unresolvable → the manifest's conventional default
  }
};

export interface BakeResult {
  /** `zips/<ns>/<repo>/<commit>.zip` under the registry dir. */
  path: string;
  /** true when an existing zip was reused (the common case — §3.4
   *  content-addressing makes a resident zip permanently valid). */
  reused: boolean;
}

export interface BakeOptions {
  /** Overrides `https://github.com/<ns>/<repo>.git` (tests bake against a
   *  local `file://` fixture). */
  remoteUrl?: string;
}

/** Ensure the registry zip for one lock entry exists, building it only when
 *  absent (see the module header for the immutability argument). */
export const ensureZip = async (dir: string, entry: ReleaseLockEntry, opts: BakeOptions = {}): Promise<BakeResult> => {
  const [, ns, repo] = /^github:(?:([^/]+))\/([^/@]+)$/.exec(entry.repo) ?? [];
  if (!ns || !repo) {
    throw new Error(`pin-release bake: unsupported repo id "${entry.repo}" (only github:owner/repo is bakeable)`);
  }
  const path = join(dir, 'zips', ns, repo, `${entry.commit}.zip`);
  if (existsSync(path)) return { path, reused: true };

  const checkout = materializeCommit(ns, repo, entry.commit, opts.remoteUrl);
  try {
    await buildCacheZip({
      repoPath: checkout,
      owner: ns,
      repository: repo,
      // The §6.4 sidecar coordinate: the mounter probes `<commit>.zip` and
      // matches `ref === commit === pin`.
      ref: entry.commit,
      defaultBranch: remoteDefaultBranch(ns, repo, opts.remoteUrl),
      out: path,
    });
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
  return { path, reused: false };
};

/** Deduplicated (namespace, repository, commit) set across a lock's entries —
 *  one-repo-many-bindings (UI_AS_APPS §4) must bake once, not per region. */
export const bakeSet = (locks: { apps: Record<string, ReleaseLockEntry> }[]): ReleaseLockEntry[] => {
  const seen = new Set<string>();
  const out: ReleaseLockEntry[] = [];
  for (const lock of locks) {
    for (const entry of Object.values(lock.apps)) {
      const key = `${entry.repo}#${entry.commit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
};
