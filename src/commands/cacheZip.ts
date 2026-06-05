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
import { DEFAULT_CDN_ROOT, fetchLockset, type DepMap } from '../lockset.js';
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
  --no-lockset              Skip embedding the resolved-dependency lockset
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
  // Lockset embedding (PRETRANSPILED_ARTIFACTS_SPEC §7 step 2). On by default;
  // any failure to produce one is non-fatal — the zip ships without it and the
  // runtime resolves dependencies live, exactly as before.
  lockset?: boolean;
  cdnRoot?: string;
}

export interface CacheZipResult {
  outputPath: string;
  owner: string;
  repository: string;
  ref: string;
  refKind: RepoManifest['refKind'];
  commitSha: string;
  entryCount: number;
  // Human-readable lockset outcome for the summary line: "<n> packages" or
  // "omitted (<reason>)".
  locksetSummary: string;
}

// Dependencies as committed at HEAD — the lockset must correspond to the tree
// the zip carries (git archive HEAD), not the working directory.
const headDependencies = (repo: string): { deps: DepMap; reason?: string } => {
  let raw: string;
  try {
    raw = git(repo, ['show', 'HEAD:package.json']);
  } catch {
    return { deps: {}, reason: 'no package.json at HEAD' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { deps: {}, reason: 'package.json at HEAD is not valid JSON' };
  }
  const deps = (parsed as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    return { deps: {}, reason: 'package.json has no dependencies' };
  }
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== 'string') {
      return { deps: {}, reason: `dependency ${name} has a non-string version` };
    }
  }
  return { deps: deps as DepMap };
};

const resolveLockset = async (
  repo: string,
  opts: CacheZipOptions,
): Promise<{ lockset?: RepoManifest['lockset']; summary: string }> => {
  if (opts.lockset === false) {
    return { summary: 'omitted (--no-lockset)' };
  }
  const { deps, reason } = headDependencies(repo);
  if (reason) {
    return { summary: `omitted (${reason})` };
  }
  try {
    const lockset = await fetchLockset(deps, opts.cdnRoot);
    return { lockset, summary: `${lockset.resolved.length} packages` };
  } catch (err) {
    // Never fail the zip build over the lockset (spec §7): warn and omit.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: lockset omitted (${message})`);
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

  // 1) git archive: a ZIP whose contents are exactly the tracked tree at HEAD.
  rmSync(outputPath, { force: true });
  execFileSync('git', ['-C', repo, 'archive', '--format=zip', '-o', outputPath, 'HEAD']);

  // 2) Append the manifest sidecar at .tinkerable/contribute-manifest.json.
  const staging = mkdtempSync(join(tmpdir(), 'cache-zip-'));
  try {
    const sidecarPath = join(staging, MANIFEST_SIDECAR_ENTRY);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, JSON.stringify(manifest, null, 2));
    execFileSync('zip', ['-q', '-X', outputPath, MANIFEST_SIDECAR_ENTRY], { cwd: staging });
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
    locksetSummary,
  };
};

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
    lockset: args.flags['no-lockset'] ? false : undefined,
    cdnRoot: flagValue(args.flags, 'cdn-root'),
  });
  console.log(`Wrote ${result.outputPath}`);
  console.log(`  owner/repo:    ${result.owner}/${result.repository}`);
  console.log(`  ref:           ${result.ref} (${result.refKind})`);
  console.log(`  commit:        ${result.commitSha}`);
  console.log(`  tracked files: ${result.entryCount}`);
  console.log(`  lockset:       ${result.locksetSummary}`);
  return 0;
};
