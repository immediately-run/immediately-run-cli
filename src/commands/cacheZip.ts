/*
 * `immediately-run cache-zip` — build a cached repository ZIP (with a contribute
 * manifest sidecar) from a local git checkout, mirroring what the immediately.run
 * client would otherwise fetch from the GitHub API.
 *
 * The ZIP contains the tracked files at HEAD (via `git archive`, so its contents
 * match the git tree exactly) plus a manifest sidecar at
 * `.tinkerable/contribute-manifest.json`. The client reads that sidecar so
 * contributions work offline without a lazy REST fetch.
 *
 * Designed to run both locally (git inference) and in CI (explicit flags from
 * the GitHub Actions `github` context).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SIDECAR_ENTRY,
  type RepoManifest,
} from '../manifest.js';
import {
  DEFAULT_CDN_ROOT,
  fetchLockset,
  fetchBundledPackages,
  bundledPackageFilename,
  type DepMap,
  type BundledPackage,
} from '../lockset.js';
import { emitArtifacts, type ArtifactEmission } from '../artifacts.js';
import {
  COMMIT_HASH_RE,
  currentBranch,
  defaultBranchOf,
  git,
  headCommitSha,
  headTreeSha,
  isGitRepo,
  parseOwnerRepo,
  treeEntries,
} from '../git.js';
import { flagValue, type ParsedArgs } from '../args.js';

export const CACHE_ZIP_USAGE = `Usage: immediately-run cache-zip [repo-path] [options]

Build a cached repository zip with a contribute-manifest sidecar from a local
git checkout. Defaults derive everything from the repo's git metadata; pass the
flags below to override (e.g. in CI where the checkout is shallow).

Arguments:
  repo-path                 Path to the local git checkout (default: cwd)

Options:
  --owner <name>            Repository owner / namespace
  --repo <name>             Repository name
  --ref <name>              Ref to cache (default: current branch); also the
                            default output filename
  --default-branch <name>   Repository default branch
  --out <path>              Output zip path
                            (default: <repo>/public/cached_repositories/<owner>/<repo>/<ref>.zip)
  --no-artifacts            Skip emitting pre-transpiled artifacts (source-only zip)
  --no-lockset              Skip embedding the resolved-dependency lockset
  --bundle-packages         Bundle resolved dependency CONTENT into the zip
                            (R3-49a; opt-in, requires the lockset)
  --cdn-root <url>          Module CDN root for lockset resolution
                            (default: ${DEFAULT_CDN_ROOT})
  -h, --help                Show this help`;

export interface CacheZipOptions {
  repoPath: string;
  owner?: string;
  repository?: string;
  ref?: string;
  defaultBranch?: string;
  out?: string;
  // Pre-transpiled artifact emission (PRETRANSPILED_ARTIFACTS_SPEC §7 step 1). On
  // by default; per-file transform failures are non-fatal (omit + warn), and the
  // runtime falls back to live transpile for anything absent.
  artifacts?: boolean;
  // Lockset embedding (PRETRANSPILED_ARTIFACTS_SPEC §7 step 2). On by default;
  // any failure to produce one is non-fatal — the zip ships without it and the
  // runtime resolves dependencies live, exactly as before.
  lockset?: boolean;
  cdnRoot?: string;
  // Bundle the resolved dependency CONTENT into the zip (R3-49a, the boot lever:
  // `loadNodeModules` is ~99% of cold boot). OPT-IN (--bundle-packages) and
  // requires the lockset: a default-on bundle could bloat the zip past the host
  // size cap, and the content is inert until the sandbox consume-side + ZenFS
  // batch hydration (R3-49b) read it. See plans/dependency-loading-optimization.md.
  bundlePackages?: boolean;
}

export interface CacheZipResult {
  outputPath: string;
  owner: string;
  repository: string;
  ref: string;
  refKind: RepoManifest['refKind'];
  commitSha: string;
  entryCount: number;
  // Human-readable artifact outcome for the summary line: "<n> files (<k> skipped),
  // <bytes>" or "omitted (--no-artifacts)".
  artifactsSummary: string;
  // Human-readable lockset outcome for the summary line: "<n> packages" or
  // "omitted (<reason>)".
  locksetSummary: string;
  // Human-readable bundled-package outcome: "<n> packages, <bytes>", "omitted
  // (not requested)", or "omitted (<reason>)".
  bundledPackagesSummary: string;
}

// Modules the app resolves from a self-hosted/registry source at its pinned
// version (package.json `immediately.run`.`resolveFromRegistry`). They are
// excluded from the CDN `/dep_tree/` lockset resolution — see
// `computeInputDepMap` — so the lockset survives npm→CDN replication lag for
// them (notably a freshly published `@immediately-run/sdk`).
const headRegistryResolved = (parsed: unknown): string[] => {
  const cfg = (parsed as Record<string, unknown> | null)?.['immediately.run'];
  const list = (cfg as { resolveFromRegistry?: unknown } | undefined)?.resolveFromRegistry;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : [];
};

// Dependencies as committed at HEAD — the lockset must correspond to the tree
// the zip carries (git archive HEAD), not the working directory.
const headDependencies = (
  repo: string,
): { deps: DepMap; registryResolved: string[]; reason?: string } => {
  let raw: string;
  try {
    raw = git(repo, ['show', 'HEAD:package.json']);
  } catch {
    return { deps: {}, registryResolved: [], reason: 'no package.json at HEAD' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { deps: {}, registryResolved: [], reason: 'package.json at HEAD is not valid JSON' };
  }
  const registryResolved = headRegistryResolved(parsed);
  const deps = (parsed as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    return { deps: {}, registryResolved, reason: 'package.json has no dependencies' };
  }
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== 'string') {
      return { deps: {}, registryResolved, reason: `dependency ${name} has a non-string version` };
    }
  }
  return { deps: deps as DepMap, registryResolved };
};

const resolveLockset = async (
  repo: string,
  opts: CacheZipOptions,
): Promise<{ lockset?: RepoManifest['lockset']; summary: string }> => {
  if (opts.lockset === false) {
    return { summary: 'omitted (--no-lockset)' };
  }
  const { deps, registryResolved, reason } = headDependencies(repo);
  if (reason) {
    return { summary: `omitted (${reason})` };
  }
  try {
    const lockset = await fetchLockset(deps, opts.cdnRoot, registryResolved);
    return { lockset, summary: `${lockset.resolved.length} packages` };
  } catch (err) {
    // Never fail the zip build over the lockset (spec §7): warn and omit.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: lockset omitted (${message})`);
    return { summary: `omitted (${message})` };
  }
};

// Fetch the resolved dependency CONTENT for bundling (R3-49a). Opt-in, and gated on
// a lockset (the resolved list is the input). All-or-nothing + non-fatal: any failure
// omits the whole section and the runtime falls back to live `/package/` fetches.
const resolveBundledPackages = async (
  opts: CacheZipOptions,
  lockset: RepoManifest['lockset'] | undefined,
): Promise<{ packages?: BundledPackage[]; summary: string }> => {
  if (!opts.bundlePackages) {
    return { summary: 'omitted (not requested)' };
  }
  if (!lockset) {
    return { summary: 'omitted (no lockset)' };
  }
  try {
    const packages = await fetchBundledPackages(lockset.resolved, opts.cdnRoot);
    const bytes = packages.reduce((sum, p) => sum + p.bytes.byteLength, 0);
    return { packages, summary: `${packages.length} packages, ${formatBytes(bytes)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: bundled packages omitted (${message})`);
    return { summary: `omitted (${message})` };
  }
};

export const buildCacheZip = async (opts: CacheZipOptions): Promise<CacheZipResult> => {
  const repo = resolve(opts.repoPath);
  if (!isGitRepo(repo)) {
    throw new Error(`${repo} is not a git repository (no .git directory)`);
  }

  // Owner / repository: explicit flags win, else parse the origin remote URL.
  let owner = opts.owner;
  let repository = opts.repository;
  if (!owner || !repository) {
    const remoteUrl = git(repo, ['remote', 'get-url', 'origin']);
    const parsed = parseOwnerRepo(remoteUrl);
    if (!parsed) {
      throw new Error(
        `Could not parse owner/repo from origin remote (${remoteUrl}); pass --owner and --repo.`,
      );
    }
    owner = owner ?? parsed.owner;
    repository = repository ?? parsed.repository;
  }

  const ref = opts.ref || currentBranch(repo);
  if (ref === 'HEAD') {
    throw new Error('HEAD is detached; pass --ref explicitly.');
  }

  const commitSha = headCommitSha(repo);
  const treeSha = headTreeSha(repo);
  const defaultBranch = opts.defaultBranch || defaultBranchOf(repo, ref);
  const entries = treeEntries(repo);
  const { lockset, summary: locksetSummary } = await resolveLockset(repo, opts);
  const { packages, summary: bundledPackagesSummary } = await resolveBundledPackages(opts, lockset);

  const manifest: RepoManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: 'zip-sidecar',
    capturedAt: Date.now(),
    provider: 'github',
    namespace: owner,
    repository,
    ref,
    refKind: COMMIT_HASH_RE.test(ref) ? 'commit' : 'branch',
    commitSha,
    treeSha,
    defaultBranch,
    truncated: false,
    entries,
    ...(lockset ? { lockset } : {}),
  };

  const outputPath = opts.out
    ? resolve(opts.out)
    : resolve(repo, 'public', 'cached_repositories', owner, repository, `${ref}.zip`);
  mkdirSync(dirname(outputPath), { recursive: true });

  // 1) git archive: a ZIP whose contents are exactly the tracked tree at HEAD. The
  //    .tinkerable/ sidecar (+ artifacts/packages) is appended onto THIS base below.
  //    Without it the zip carries only the sidecar and every tracked blob fails the
  //    host's verifyZipBlobs (REPO_LIFECYCLE_SPEC §3.4) → the zip is rejected and the
  //    runtime falls back to the REST loader. (This step was dropped in the G2-3
  //    artifacts refactor — `git log -S "git archive" cacheZip.ts` → e7c9c21 — and is
  //    restored here; covered by the regression test below.)
  rmSync(outputPath, { force: true });
  execFileSync('git', ['-C', repo, 'archive', '--format=zip', '-o', outputPath, 'HEAD']);

  // 2) Pre-transpiled artifacts (PRETRANSPILED_ARTIFACTS_SPEC §7 step 1) — on by
  //    default, opt out with --no-artifacts. Per-file failures are already
  //    omitted-with-warning inside emitArtifacts; the whole step never fails the
  //    build (the runtime falls back to live transpile for anything absent).
  let artifactsSummary = 'omitted (--no-artifacts)';
  let emission: ArtifactEmission | undefined;
  if (opts.artifacts !== false) {
    emission = await emitArtifacts(repo, entries);
    const skip = emission.skipped.length ? ` (${emission.skipped.length} skipped)` : '';
    artifactsSummary = `${emission.transpiledCount} files${skip}, ${formatBytes(
      emission.sourceBytes,
    )} → ${formatBytes(emission.artifactBytes)}`;
  }

  // 3) Append the sidecar (+ artifacts) under .tinkerable/ in one zip call, with
  //    paths passed sorted so the appended set is reproducible run-to-run.
  const staging = mkdtempSync(join(tmpdir(), 'cache-zip-'));
  try {
    const stagedPaths: string[] = [];
    const stage = (relPath: string, content: string | Uint8Array) => {
      const full = join(staging, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      stagedPaths.push(relPath);
    };
    stage(MANIFEST_SIDECAR_ENTRY, JSON.stringify(manifest, null, 2));
    if (emission) {
      stage('.tinkerable/artifacts/index.json', JSON.stringify(emission.index, null, 2));
      for (const [out, content] of emission.files) {
        stage(`.tinkerable/artifacts/${out}`, content);
      }
    }
    // Bundled dependency content (R3-49a) — verbatim `/package/` msgpack bytes plus an
    // index keyed by the CDN key (so the consume side can match a `fetchModule` hit)
    // and the in-zip path. Under the .tinkerable/ allowlist (extra-entry rule + diff
    // exclusion already cover it).
    if (packages && packages.length) {
      const index = {
        cdnVersion: lockset!.cdnVersion,
        packages: packages.map((p) => ({
          n: p.name,
          v: p.version,
          key: p.key,
          path: `${bundledPackageFilename(p.name, p.version)}.msgpack`,
        })),
      };
      stage('.tinkerable/packages/index.json', JSON.stringify(index, null, 2));
      for (const p of packages) {
        stage(`.tinkerable/packages/${bundledPackageFilename(p.name, p.version)}.msgpack`, p.bytes);
      }
    }
    stagedPaths.sort();
    execFileSync('zip', ['-q', '-X', outputPath, ...stagedPaths], { cwd: staging });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    outputPath,
    owner,
    repository,
    ref,
    refKind: manifest.refKind,
    commitSha,
    entryCount: entries.length,
    artifactsSummary,
    locksetSummary,
    bundledPackagesSummary,
  };
};

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

export const runCacheZip = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(CACHE_ZIP_USAGE);
    return 0;
  }
  const result = await buildCacheZip({
    repoPath: args.positionals[0] ?? process.cwd(),
    owner: flagValue(args.flags, 'owner'),
    repository: flagValue(args.flags, 'repo'),
    ref: flagValue(args.flags, 'ref'),
    defaultBranch: flagValue(args.flags, 'default-branch'),
    out: flagValue(args.flags, 'out'),
    artifacts: args.flags['no-artifacts'] ? false : undefined,
    lockset: args.flags['no-lockset'] ? false : undefined,
    bundlePackages: args.flags['bundle-packages'] ? true : undefined,
    cdnRoot: flagValue(args.flags, 'cdn-root'),
  });
  console.log(`Wrote ${result.outputPath}`);
  console.log(`  owner/repo:    ${result.owner}/${result.repository}`);
  console.log(`  ref:           ${result.ref} (${result.refKind})`);
  console.log(`  commit:        ${result.commitSha}`);
  console.log(`  tracked files: ${result.entryCount}`);
  console.log(`  artifacts:     ${result.artifactsSummary}`);
  console.log(`  lockset:       ${result.locksetSummary}`);
  console.log(`  bundled pkgs:  ${result.bundledPackagesSummary}`);
  return 0;
};
