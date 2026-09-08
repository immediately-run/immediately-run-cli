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
import { ownPackageDir, platformProvidedNames, resolvePlatformProvided } from '../platformProvided.js';
import {
  buildLocalPackage,
  mergeResolved,
  encodeLocalPackage,
  resolveFromInstalledTree,
  resolvePackageDir,
} from '../localPackageSource.js';
import { scanCjsModule } from '../vendor/cjsScan/scan.js';
import { transformFile } from '@immediately-run/transpiler';
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
 * The platform-injected dependencies, resolved from THIS package's own tree.
 *
 * Narrow on purpose, and at depth 0 only: just the names the augmented map ADDED that the
 * app's manifest never mentioned, so an app's own `react` can never be answered by ours, and
 * a platform package's own dependencies never enter an app's lockset from here.
 * `check-platform-provided` keeps the set we carry in step with the set the transpiler
 * injects. See `src/platformProvided.ts` for why this must not be a directory walk.
 */
const platformProvided = (rootDeps: DepMap, augmented: DepMap): ResolvedDependency[] =>
  resolvePlatformProvided(platformProvidedNames(rootDeps, augmented), augmented);

/**
 * The lockset, with any package the dependency CDN cannot resolve FILLED IN from the
 * runner's own installed tree (R3-567).
 *
 * WHY GAP-FILLING RATHER THAN LOCAL-FIRST. The first cut preferred the installed tree
 * wholesale and always lost, for a reason worth recording: `computeInputDepMap` includes
 * the AUGMENTED build dependencies the sandbox runtime needs (`react-refresh`, `core-js`,
 * `react-error-boundary`) and which npm never installs, so the local tree can never be
 * complete. But
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
  // The app's tree cannot hold what the app never declared, so the platform-injected names
  // are resolved from OUR tree — narrowly, by name, never as a general second root. See
  // `src/platformProvided.ts`; this is what makes exit criterion 1 reachable at all.
  const platform = platformProvided(deps, dependencies);
  // STRICT PRECEDENCE, not concatenation: CDN, then the app's tree, then ours. Found on the
  // live acceptance — `react-error-boundary` is injected by the platform AND hoisted into
  // landing-page's tree, so a plain union emitted it twice, at two different versions
  // (6.1.3 and 6.1.5), and `assertDependenciesResolved` was happy with both. The runtime
  // takes one of them; nothing says which. A name is resolved once, by the nearest source.
  const resolved = mergeResolved(fromCdn, local, platform);
  const filled = resolved.slice(fromCdn.length);

  try {
    // The SAME completeness guard the runtime applies. A gap neither source could fill
    // must fail here rather than bake a hole into the zip: the runtime would skip the
    // package and its first import resolves `undefined`.
    assertDependenciesResolved(dependencies, resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `cdnError` belongs in the DURABLE record, not only on the console. Without it, an
    // HTTP 500 on every request reads in the manifest as "may not exist on the CDN's npm
    // mirror yet — try a lower version range in package.json", which advises lowering a
    // range on a pinned `core-js@3.22.7` and sends the next reader after the wrong thing.
    // The CDN's OWN failure leads when there is one: the completeness guard's message
    // ends in "try a lower version range in package.json", which is advice for mirror lag
    // and actively misleading when every request 500'd — it sends the next reader to lower
    // a range on a pinned core-js.
    const full = cdnError ? `the package CDN failed: ${cdnError} (so nothing could be resolved from it; ${message})` : message;
    console.warn(`Warning: lockset omitted (${full})`);
    return { summary: `omitted (${full})` };
  }

  // NAME THE THIRD SOURCE. "from node_modules" was reported for packages that came from
  // THIS CLI's tree, including on a repo with no node_modules at all — an artifact that
  // cannot say where its content came from is how a silent regression to the CDN, or away
  // from it, would go unnoticed. The three sources are distinguished everywhere they are
  // counted.
  // By the RECORD, not by the name. `react-error-boundary` is platform-injected AND hoisted
  // into landing-page's tree, so a name-membership test labelled the app's own 6.1.3 as
  // "platform-provided by this CLI" — the same mislabel one level down, and exactly what
  // this reporting exists to prevent. `mergeResolved` keeps the winning record's identity,
  // so identity is what answers "which source won".
  const platformRecords = new Set<ResolvedDependency>(platform);
  const fromLocal = filled.filter((r) => !platformRecords.has(r));
  const fromPlatform = filled.filter((r) => platformRecords.has(r));
  const contributions: [number, string, string][] = [
    [fromCdn.length, 'CDN', 'from the CDN'],
    [fromLocal.length, 'node_modules', 'from node_modules'],
    [fromPlatform.length, 'platform-provided by this CLI', 'platform-provided by this CLI'],
  ];
  const used = contributions.filter(([n]) => n > 0);
  // One source names itself; several are counted. `(CDN)` stays exactly as it read before
  // this change, so a repo with no installed tree produces the same line it always did.
  const source =
    used.length === 1 ? used[0][1] : used.map(([n, , label]) => `${n} ${label}`).join(', ');
  if (filled.length) {
    if (fromLocal.length) {
      console.log(`  · lockset gaps filled from node_modules: ${fromLocal.map((r) => `${r.n}@${r.v}`).join(', ')}`);
    }
    if (fromPlatform.length) {
      console.log(`  · platform-provided by this CLI: ${fromPlatform.map((r) => `${r.n}@${r.v}`).join(', ')}`);
    }
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
  platformNames: ReadonlySet<string> = new Set(),
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
  const platformBuilt = new Set<string>();
  const needCdn: typeof lockset.resolved = [];
  const localRefusals: string[] = [];
  for (const entry of lockset.resolved) {
    const { n: name, v: version } = entry;
    // Same two roots as the lockset, and in the same order: the app's tree answers for
    // what the app declared, ours only for what the platform injected. A package resolved
    // from one and versioned from the other would be a silent substitution, so the root
    // that supplies the directory is the root the version is read from.
    // CANDIDATES, not a single choice. The app's tree is asked first, ours only for a
    // platform-injected name — but a directory that holds the WRONG version must not end the
    // search, or a stale same-name copy in the app's tree shadows the platform copy and the
    // package falls to the CDN. That is not a per-package cost: the CDN fetch is
    // all-or-nothing, so ONE shadowed package omits EVERY bundled package. Reproduced with
    // an undeclared `react-error-boundary@5.0.0` in the app tree, which turned a working
    // `4 packages, 974.5 KB` into `bundled pkgs: omitted (fetch failed)`.
    const candidates = [resolvePackageDir(name, repo, repo)];
    if (platformNames.has(name)) candidates.push(ownPackageDir(name));

    const versionAt = (d: string | null): string | null => {
      try {
        return d ? ((JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version as string) ?? null) : null;
      } catch {
        return null;
      }
    };
    // Only a directory holding the EXACT version the lockset resolved. A different version
    // on disk is a different package, and shipping it under this key would be a silent
    // substitution — the worst failure this whole feature could have.
    const dir = candidates.find((d) => d !== null && versionAt(d) === version) ?? null;
    const repoDir = dir === candidates[0] ? dir : null;
    if (dir) {
      try {
        if (!repoDir) platformBuilt.add(name);
        localBuilt.push({
          key: encodePackageKey(name, version),
          name,
          version,
          bytes: encodeLocalPackage(await buildLocalPackage(dir, scanCjsModule, transformFile)),
        });
        continue;
      } catch (err) {
        // A package that cannot be built LOCALLY falls back to the CDN whole — never
        // half-built. `buildLocalPackage` throws rather than shipping a hole, and the
        // refusal is surfaced: a silent fallback here is how a package would quietly go on
        // depending on the CDN forever.
        localRefusals.push(`${name}@${version}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    needCdn.push(entry);
  }

  try {
    const fetched = needCdn.length ? await fetchBundledPackages(needCdn, opts.cdnRoot) : [];
    const packages = [...localBuilt, ...fetched];
    const bytes = packages.reduce((sum, p) => sum + p.bytes.byteLength, 0);
    if (localRefusals.length) {
      console.warn(`  · ${localRefusals.length} package(s) fell back to the CDN: ${localRefusals.slice(0, 3).join('; ')}`);
    }
    const built = localBuilt.filter((p) => !platformBuilt.has(p.name)).length;
    const plat = localBuilt.length - built;
    const source =
      [
        fetched.length ? `${fetched.length} from the CDN` : '',
        built ? `${built} from node_modules` : '',
        plat ? `${plat} platform-provided by this CLI` : '',
      ]
        .filter(Boolean)
        .join(', ') || 'nothing';
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
  const platformNames = new Set(
    lockset ? platformProvidedNames(headDependencies(repo).deps, lockset.dependencies) : [],
  );
  const { packages, summary: bundledPackagesSummary } = await resolveBundledPackages(opts, lockset, repo, platformNames);

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
