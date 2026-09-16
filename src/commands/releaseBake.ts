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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCacheZip } from './cacheZip.js';
import type { ReleaseLockEntry } from '../release.js';
import type { RepoManifest } from '../manifest.js';

const SIDECAR_PATH = '.immediately.run/contribute-manifest.json';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" — a local-file-header zip

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
 *  (a blob-less clone does not reliably carry origin/HEAD). Falls back to the
 *  conventional `main` only when the remote genuinely advertises no HEAD
 *  symref; a FAILED ls-remote warns (the clone+fetch against the same URL
 *  succeeded moments earlier, so this is rare) and still falls back — the
 *  field is provenance, never a mount coordinate. */
export const remoteDefaultBranch = (namespace: string, repository: string, remoteUrl?: string): string => {
  const url = remoteUrl ?? `https://github.com/${namespace}/${repository}.git`;
  try {
    const out = execFileSync('git', ['ls-remote', '--symref', url, 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = /^ref: refs\/heads\/(\S+)/m.exec(out);
    if (m) return m[1]!;
    console.warn(`pin-release bake: no HEAD symref advertised by ${url}; assuming main`);
    return 'main';
  } catch (err) {
    console.warn(
      `pin-release bake: ls-remote failed for ${url} (${err instanceof Error ? err.message : String(err)}); assuming main`,
    );
    return 'main';
  }
};

export interface BakeResult {
  /** `zips/<ns>/<repo>/<commit>.zip` under the registry dir. */
  path: string;
  /** true when an existing zip was reused (the common case — §3.4
   *  content-addressing makes a VALID resident zip permanently reusable). */
  reused: boolean;
}

/** §3.4/§5-5a immutability guard: a RESIDENT zip is trusted only after
 *  validation — magic bytes always (no dependencies), and the sidecar's
 *  §6.4 coordinate (`ref === commitSha === pin`) whenever `unzip` is
 *  available (the runners always carry it; without it the magic check alone
 *  stands and the sidecar leg is warn-skipped). A zip that fails validation
 *  ABORTS naming the path: the bake writes non-atomically inside
 *  `buildCacheZip`, so an interrupted earlier bake can leave a truncated file
 *  at a content-addressed path — exactly the bytes that must never be
 *  silently reused (the R3-637 review's blocking finding). */
export const validateResidentZip = (path: string, entry: ReleaseLockEntry): void => {
  let head: Buffer;
  try {
    head = readFileSync(path).subarray(0, 4);
  } catch (err) {
    throw new Error(`pin-release bake: cannot read resident zip ${path} (${String(err)}) — aborting`);
  }
  if (!head.equals(ZIP_MAGIC)) {
    throw new Error(`pin-release bake: resident zip ${path} fails the zip magic check — aborting (re-bake it)`);
  }
  const unzip = spawnSync('unzip', ['-p', path, SIDECAR_PATH], { encoding: 'utf8' });
  if (unzip.error !== undefined) {
    console.warn(`pin-release bake: unzip unavailable — sidecar validation of ${path} skipped (magic check only)`);
    return;
  }
  if (unzip.status !== 0) {
    throw new Error(`pin-release bake: resident zip ${path} carries no readable sidecar — aborting (re-bake it)`);
  }
  let manifest: RepoManifest;
  try {
    manifest = JSON.parse(unzip.stdout) as RepoManifest;
  } catch {
    throw new Error(`pin-release bake: resident zip ${path} has an unparseable sidecar — aborting (re-bake it)`);
  }
  if (manifest.ref !== entry.commit || manifest.commitSha !== entry.commit) {
    throw new Error(
      `pin-release bake: resident zip ${path} sidecar does not name the pin ${entry.commit} ` +
        `(ref=${String(manifest.ref)} commitSha=${String(manifest.commitSha)}) — aborting`,
    );
  }
};

export interface BakeOptions {
  /** Overrides `https://github.com/<ns>/<repo>.git` (tests bake against a
   *  local `file://` fixture). */
  remoteUrl?: string;
}

/** Ensure the registry zip for one lock entry exists, building it only when
 *  absent. A resident zip is VALIDATED then reused (never rebuilt — §3.4
 *  content-addressing); a new build lands ATOMICALLY (temp file + rename), so
 *  an interrupted bake can never leave a truncated zip at the final path. */
export const ensureZip = async (dir: string, entry: ReleaseLockEntry, opts: BakeOptions = {}): Promise<BakeResult> => {
  const [, ns, repo] = /^github:(?:([^/]+))\/([^/@]+)$/.exec(entry.repo) ?? [];
  if (!ns || !repo) {
    throw new Error(`pin-release bake: unsupported repo id "${entry.repo}" (only github:owner/repo is bakeable)`);
  }
  const path = join(dir, 'zips', ns, repo, `${entry.commit}.zip`);
  if (existsSync(path)) {
    validateResidentZip(path, entry);
    return { path, reused: true };
  }

  const checkout = materializeCommit(ns, repo, entry.commit, opts.remoteUrl);
  // Atomic landing: build beside the final path, rename into place — a
  // content-addressed path must only ever hold a complete zip.
  const staging = `${path}.baking-${process.pid}-${Date.now().toString(36)}`;
  try {
    await buildCacheZip({
      repoPath: checkout,
      owner: ns,
      repository: repo,
      // The §6.4 sidecar coordinate: the mounter probes `<commit>.zip` and
      // matches `ref === commit === pin`.
      ref: entry.commit,
      defaultBranch: remoteDefaultBranch(ns, repo, opts.remoteUrl),
      out: staging,
    });
    renameSync(staging, path);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(staging, { force: true }); // no-op after a successful rename
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
