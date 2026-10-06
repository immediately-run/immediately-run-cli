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
// The sidecar path literal lives once in @immediately-run/platform-constants
// (R3-104) — same import cacheZip/manifest use.
import { CONTRIBUTE_MANIFEST_PATH } from '@immediately-run/platform-constants';

const SIDECAR_PATH = CONTRIBUTE_MANIFEST_PATH;
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

/** Parse a bakeable lock-entry repo id (`github:<owner>/<repo>` — the flat
 *  first-party shape). One home for the shape; `pinRelease --check`'s zip loop
 *  routes through the same parser so its skip decision matches the bake's
 *  refusal exactly. Returns null for any other shape. */
export const parseBakeableRepoId = (repo: string): { namespace: string; repository: string } | null => {
  const m = /^github:(?:([^/]+))\/([^/@]+)$/.exec(repo);
  return m ? { namespace: m[1]!, repository: m[2]! } : null;
};

/** §3.4/§5-5a immutability guard: a RESIDENT zip is trusted only after
 *  validation — magic bytes always (no dependencies), and the sidecar's
 *  §6.4 coordinate (`ref === commitSha === pin`) whenever `unzip` is
 *  available (the runners always carry it; without it the magic check alone
 *  stands and the sidecar leg is warn-skipped). A zip that fails validation
 *  ABORTS naming the path: an externally corrupted, truncated, or mis-placed
 *  resident must never be silently reused (this tool's own writes land
 *  atomically via staging+rename below, so it never leaves a truncated file
 *  itself — the guard exists for everything else that can touch the tree). */
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
  /** Module CDN root for the lockset and bundled packages (tests point it at
   *  a dead port so the bake resolves from the checkout alone). */
  cdnRoot?: string;
}

/** Populate the checkout's `node_modules` the way `cache.yml` does before it
 *  runs `cache-zip`: the builder fills the CDN's gaps from the installed tree,
 *  and a registry zip must not be thinner than the app repo's own Pages zip.
 *  Conditional on a lockfile and non-fatal here — a failed install leaves the
 *  builder on the CDN, and `ensureZip` refuses the zip if that leaves it
 *  without its packages. `--ignore-scripts`: this populates a directory, it
 *  never runs a pinned repo's postinstall on the runner that pushes the
 *  registry. Returns whether an install ran and succeeded. */
export const installDependencies = (checkout: string): boolean => {
  if (!existsSync(join(checkout, 'package-lock.json'))) return false;
  try {
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: checkout,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch (err) {
    // execFileSync's message is only the command line; npm's reason is on stderr.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    // npm states the cause first and its usage text last, so the head is the useful part.
    const said = stderr.split('\n').filter((line) => line.replace(/^npm (error|ERR!)/, '').trim() !== '');
    const reason = said.length ? said.slice(0, 4).join(' | ') : err instanceof Error ? err.message : String(err);
    console.warn(`pin-release bake: npm ci failed in ${checkout} (${reason}); falling back to the package CDN`);
    return false;
  }
};

/** Ensure the registry zip for one lock entry exists, building it only when
 *  absent. A resident zip is VALIDATED then reused (never rebuilt — §3.4
 *  content-addressing); a new build lands ATOMICALLY (temp file + rename), so
 *  an interrupted bake can never leave a truncated zip at the final path.
 *  Because a resident zip is never rebuilt, a build whose packages could not be
 *  bundled is refused rather than landed: the path stays absent and the next
 *  run retries, where landing it would serve the thin zip for good. */
export const ensureZip = async (dir: string, entry: PinnedEntry, opts: BakeOptions = {}): Promise<BakeResult> => {
  const bakeable = parseBakeableRepoId(entry.repo);
  if (!bakeable) {
    throw new Error(`pin-release bake: unsupported repo id "${entry.repo}" (only github:owner/repo is bakeable)`);
  }
  const { namespace: ns, repository: repo } = bakeable;
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
    installDependencies(checkout);
    const built = await buildCacheZip({
      repoPath: checkout,
      owner: ns,
      repository: repo,
      // The §6.4 sidecar coordinate: the mounter probes `<commit>.zip` and
      // matches `ref === commit === pin`.
      ref: entry.commit,
      defaultBranch: remoteDefaultBranch(ns, repo, opts.remoteUrl),
      out: staging,
      // The same bundling as `cache.yml`'s `--bundle-packages`: without it a
      // cold boot on a pinned release fetches every dependency live.
      bundlePackages: true,
      cdnRoot: opts.cdnRoot,
    });
    if (built.declaredDependencyCount > 0 && built.bundledPackageCount === null) {
      const n = built.declaredDependencyCount;
      throw new Error(
        `pin-release bake: ${ns}/${repo}@${entry.commit} declares ${n} ${n === 1 ? 'dependency' : 'dependencies'} ` +
          `but none were bundled (lockset: ${built.locksetSummary}; bundled pkgs: ${built.bundledPackagesSummary}) — ` +
          'not landing a zip that would be reused without them; re-run the bake if that cause was transient',
      );
    }
    renameSync(staging, path);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(staging, { force: true }); // no-op after a successful rename
  }
  return { path, reused: false };
};

/** Deduplicated (namespace, repository, commit) set across a lock's entries —
 *  one-repo-many-bindings (UI_AS_APPS §4) must bake once, not per region. */
/** A lock entry with its commit — the only kind a zip is baked for (R3-658). */
export type PinnedEntry = ReleaseLockEntry & { commit: string };

export const bakeSet = (locks: { apps: Record<string, ReleaseLockEntry> }[]): PinnedEntry[] => {
  const seen = new Set<string>();
  const out: PinnedEntry[] = [];
  for (const lock of locks) {
    for (const entry of Object.values(lock.apps)) {
      // R3-658: an unpinned entry has no commit, so nothing to bake (§3.2).
      if (!entry.commit) continue;
      const key = `${entry.repo}#${entry.commit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry as PinnedEntry);
    }
  }
  return out;
};
