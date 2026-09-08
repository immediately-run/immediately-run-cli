/*
 * `immediately.run cache-zip` — build a cached repository ZIP (with a contribute
 * manifest sidecar) from a local git checkout, mirroring what the immediately.run
 * client would otherwise fetch from the GitHub API.
 *
 * The ZIP contains the tracked files at HEAD (via `git archive`, so its contents
 * match the git tree exactly) plus a manifest sidecar at
 * `.immediately.run/contribute-manifest.json`. The client reads that sidecar so
 * contributions work offline without a lazy REST fetch.
 *
 * Designed to run both locally (git inference) and in CI (explicit flags from
 * the GitHub Actions `github` context).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ARTIFACTS_DIR,
  MDX_METADATA_SIDECAR_PATH,
  PACKAGES_DIR,
} from '@immediately-run/platform-constants';
import { rootRuntimeDependencies, type RootPackageShape } from '@immediately-run/transpiler';

import {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_SIDECAR_ENTRY,
  type RepoManifest,
} from '../manifest.js';
import {
  DEFAULT_CDN_ROOT,
  fetchBundledPackages,
  LOCKSET_CDN_VERSION,
  encodePackageKey,
  computeInputDepMap,
  assertDependenciesResolved,
  fetchDepTree,
  type ResolvedDependency,
  bundledPackageFilename,
  type DepMap,
  type BundledPackage,
} from '../lockset.js';
import {
  buildLocalPackage,
  encodeLocalPackage,
  resolveFromInstalledTree,
  resolvePackageDir,
} from '../localPackageSource.js';
import { scanCjsRequires } from '../scanCjsRequires.js';
import {
  emitArtifacts,
  emitMdxMetadata,
  type ArtifactEmission,
  type MdxMetadataEmission,
} from '../artifacts.js';
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

export const CACHE_ZIP_USAGE = `Usage: immediately.run cache-zip [repo-path] [options]

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
  --no-mdx-metadata         Skip emitting the MDX frontmatter sidecar
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
  // Frontmatter content-collection sidecar (MDX_CONTENT_COLLECTIONS_SPEC §1.3, a
  // third independently-failing step). On by default; opt out with --no-mdx-metadata.
  // Only emitted when at least one tracked `.mdx` has non-empty frontmatter; the
  // runtime falls back to the live scan when it is absent.
  mdxMetadata?: boolean;
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
  // Human-readable MDX-metadata outcome: "<n> entries", "no MDX frontmatter", or
  // "omitted (--no-mdx-metadata)".
  mdxMetadataSummary: string;
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
  // R3-289: the lockset echo must be the SAME input DepMap the runtime computes
  // — including the root package's non-optional `peerDependencies` (the root of
  // a run has no consumer, so a peer is a runtime need there). The merge is the
  // transpiler's shared `rootRuntimeDependencies`, the single source, so the
  // runtime's echo-match against this lockset holds.
  const deps = rootRuntimeDependencies(parsed as RootPackageShape);
  if (Object.keys(deps).length === 0) {
    return { deps: {}, registryResolved, reason: 'package.json has no dependencies' };
  }
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== 'string') {
      return { deps: {}, registryResolved, reason: `dependency ${name} has a non-string version` };
    }
  }
  return { deps, registryResolved };
};

/**
 * The lockset, with any package the dependency CDN cannot resolve FILLED IN from the
 * runner's own installed tree (R3-567).
 *
 * WHY GAP-FILLING RATHER THAN LOCAL-FIRST. The first cut preferred the installed tree
 * wholesale and always lost, for a reason worth recording: `computeInputDepMap` includes
 * the AUGMENTED build dependencies the sandbox runtime needs (`react-refresh`, `core-js`,
 * `scheduler`) and which npm never installs, so the local tree can never be complete. But
 * the two sources fail in exactly opposite places — the CDN drops a version its npm mirror
 * has not ingested (always a FRESH publish), and the local tree lacks only the augmented
 * build deps (always STABLE, always resolvable). Taking the union covers both.
 *
 * That is also precisely the outage this exists for: `omnibox@0.3.0` was dropped by the
 * CDN one hour after publish, and was sitting in `node_modules` the whole time.
 *
 * The CDN being unreachable ENTIRELY is not a failure either — the local tree stands alone
 * and the completeness guard decides whether what it produced is usable.
 */
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
  const dependencies = computeInputDepMap(deps, registryResolved);

  let fromCdn: ResolvedDependency[] = [];
  let cdnError = '';
  try {
    fromCdn = await fetchDepTree(dependencies, opts.cdnRoot);
  } catch (err) {
    cdnError = err instanceof Error ? err.message : String(err);
  }

  const local = resolveFromInstalledTree(repo, dependencies);
  const have = new Set(fromCdn.map((r) => r.n));
  const filled = local.filter((r) => !have.has(r.n));
  const resolved = [...fromCdn, ...filled];

  try {
    // The SAME completeness guard the runtime applies. A gap neither source could fill
    // must fail here rather than bake a hole into the zip: the runtime would skip the
    // package and its first import resolves `undefined`.
    assertDependenciesResolved(dependencies, resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: lockset omitted (${message}${cdnError ? `; CDN: ${cdnError}` : ''})`);
    return { summary: `omitted (${message})` };
  }

  const source = filled.length === 0 ? 'CDN' : fromCdn.length === 0 ? 'node_modules' : `CDN + ${filled.length} from node_modules`;
  if (filled.length) {
    console.log(`  · lockset gaps filled from node_modules: ${filled.map((r) => `${r.n}@${r.v}`).join(', ')}`);
  }
  return {
    lockset: { cdnVersion: LOCKSET_CDN_VERSION, dependencies, resolved },
    summary: `${resolved.length} packages (${source})`,
  };
};

// Fetch the resolved dependency CONTENT for bundling (R3-49a). Opt-in, and gated on
// a lockset (the resolved list is the input). All-or-nothing + non-fatal: any failure
// omits the whole section and the runtime falls back to live `/package/` fetches.
const resolveBundledPackages = async (
  opts: CacheZipOptions,
  lockset: RepoManifest['lockset'] | undefined,
  repo: string,
): Promise<{ packages?: BundledPackage[]; summary: string }> => {
  if (!opts.bundlePackages) {
    return { summary: 'omitted (not requested)' };
  }
  if (!lockset) {
    return { summary: 'omitted (no lockset)' };
  }

  // R3-567: PER PACKAGE, local when the tree has it, CDN otherwise — the same
  // gap-filling as the lockset and for the same reason. All-or-nothing per source would
  // always lose to the augmented build deps npm never installs.
  const localBuilt: BundledPackage[] = [];
  const needCdn: typeof lockset.resolved = [];
  for (const entry of lockset.resolved) {
    const { n: name, v: version } = entry;
    const dir = resolvePackageDir(name, repo);
    let installedVersion: string | null = null;
    try {
      installedVersion = dir ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null) : null;
    } catch {
      installedVersion = null;
    }
    // Only when the tree holds the EXACT version the lockset resolved. A different
    // version on disk is a different package, and shipping it under this key would be a
    // silent substitution — the worst failure this whole feature could have.
    if (dir && installedVersion === version) {
      try {
        localBuilt.push({
          key: encodePackageKey(name, version),
          name,
          version,
          bytes: encodeLocalPackage(buildLocalPackage(dir, scanCjsRequires)),
        });
        continue;
      } catch {
        /* fall through to the CDN for this one */
      }
    }
    needCdn.push(entry);
  }

  try {
    const fetched = needCdn.length ? await fetchBundledPackages(needCdn, opts.cdnRoot) : [];
    const packages = [...localBuilt, ...fetched];
    const bytes = packages.reduce((sum, p) => sum + p.bytes.byteLength, 0);
    const source =
      needCdn.length === 0
        ? 'all from node_modules'
        : localBuilt.length === 0
          ? 'all from the CDN'
          : `${localBuilt.length} from node_modules, ${fetched.length} from the CDN`;
    return { packages, summary: `${packages.length} packages, ${formatBytes(bytes)} (${source})` };
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
  const { packages, summary: bundledPackagesSummary } = await resolveBundledPackages(opts, lockset, repo);

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
  //    .immediately.run/ sidecar (+ artifacts/packages) is appended onto THIS base below.
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

  // 2b) Frontmatter content-collection sidecar (MDX_CONTENT_COLLECTIONS_SPEC §1.3) —
  //     on by default, opt out with --no-mdx-metadata. Independently failing: a bad
  //     frontmatter file is omitted-with-warning inside emitMdxMetadata, and the
  //     runtime falls back to the live MDX scan when the sidecar is absent.
  let mdxMetadataSummary = 'omitted (--no-mdx-metadata)';
  let mdxEmission: MdxMetadataEmission | undefined;
  if (opts.mdxMetadata !== false) {
    mdxEmission = emitMdxMetadata(repo, entries);
    const skip = mdxEmission.skipped.length ? ` (${mdxEmission.skipped.length} skipped)` : '';
    mdxMetadataSummary = mdxEmission.count
      ? `${mdxEmission.count} entries${skip}`
      : `no MDX frontmatter${skip}`;
  }

  // 3) Append the sidecar (+ artifacts) under .immediately.run/ in one zip call, with
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
      stage(`${ARTIFACTS_DIR}/index.json`, JSON.stringify(emission.index, null, 2));
      for (const [out, content] of emission.files) {
        stage(`${ARTIFACTS_DIR}/${out}`, content);
      }
    }
    // The frontmatter sidecar — only when it carries at least one entry (a repo with
    // no MDX frontmatter ships no sidecar; the runtime live-scans, finding nothing).
    if (mdxEmission && mdxEmission.count > 0) {
      stage(MDX_METADATA_SIDECAR_PATH, JSON.stringify(mdxEmission.sidecar, null, 2));
    }
    // Bundled dependency content (R3-49a) — verbatim `/package/` msgpack bytes plus an
    // index keyed by the CDN key (so the consume side can match a `fetchModule` hit)
    // and the in-zip path. Under the .immediately.run/ allowlist (extra-entry rule + diff
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
      stage(`${PACKAGES_DIR}/index.json`, JSON.stringify(index, null, 2));
      for (const p of packages) {
        stage(`${PACKAGES_DIR}/${bundledPackageFilename(p.name, p.version)}.msgpack`, p.bytes);
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
    mdxMetadataSummary,
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
    mdxMetadata: args.flags['no-mdx-metadata'] ? false : undefined,
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
  console.log(`  mdx-metadata:  ${result.mdxMetadataSummary}`);
  console.log(`  lockset:       ${result.locksetSummary}`);
  console.log(`  bundled pkgs:  ${result.bundledPackagesSummary}`);
  return 0;
};
