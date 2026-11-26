/*
 * The five read answers of git-serve (GIT_SERVE_SPEC §4, R-GS-1 to R-GS-7).
 *
 *   GET /meta                        → { server, protocol, instanceId, allowCommit, repos }
 *   GET /meta?repo=<r>               → { …, repo, defaultBranch, branches, tags }
 *   GET /meta?repo=<r>&ref=<ref>     → { …, repo, ref, refKind, commitSha, treeSha }
 *   GET /tree?repo=<r>&ref=<ref>     → { …, repo, ref, refKind, commitSha, treeSha, files }
 *   GET /blob?repo=<r>&sha=<blobSha> → raw bytes
 *
 * Pure over an injected `runGit`: this file decides what to answer and never
 * touches a socket. The request guards have already run when it is called.
 *
 * Every JSON answer, an error included, carries `server` and `protocol`
 * (R-GS-1). An error body also carries a one-word `reason`.
 *
 * Paths in `files` are git's own: relative to the tree's root, with no leading
 * slash, exactly as `POST /commit` names them (§8).
 */

import { parseLsTreeLong } from '../git.js';
import {
  COMMIT_SHA_RE,
  GIT_SERVE_PROTOCOL,
  GIT_SERVE_SERVER,
  type RunGit,
} from './protocol.js';
import { headBranchOf, peelToCommit, resolveRef, type RefKind } from './refs.js';
import { listRepos, resolveRepo } from './repoName.js';

export interface ReadContext {
  /** Absolute path of the root, with its own symlinks resolved. */
  root: string;
  instanceId: string;
  /** Reported by `/meta`. A hint for the host's UI; never a gate (R-GS-23). */
  allowCommit: boolean;
  runGit: RunGit;
}

export interface TreeFileEntry {
  path: string;
  mode: '100644' | '100755' | '120000';
  sha: string;
  size: number;
}

export type ReadAnswer =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  /** Stream `git cat-file blob <sha>` from `repoDir`. The type check has passed. */
  | { kind: 'blob'; repoDir: string; sha: string };

const FILE_MODES = new Set(['100644', '100755', '120000']);
const SUBMODULE_MODE = '160000';

const envelope = { server: GIT_SERVE_SERVER, protocol: GIT_SERVE_PROTOCOL };

const ok = (body: Record<string, unknown>): ReadAnswer => ({
  kind: 'json',
  status: 200,
  body: { ...envelope, ...body },
});

export const refusal = (status: number, reason: string): ReadAnswer => ({
  kind: 'json',
  status,
  body: { ...envelope, reason },
});

const text = (b: Buffer): string => b.toString('utf8').trim();

/** One value for a query parameter, `undefined` when absent, `null` when repeated. */
const single = (query: URLSearchParams, name: string): string | undefined | null => {
  const all = query.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0]! : null;
};

/** Refuses a query that carries a parameter this route does not read. A `token`
 *  parameter is such a parameter: the token rides in `Authorization` only. */
const onlyParams = (query: URLSearchParams, allowed: readonly string[]): boolean => {
  for (const key of query.keys()) if (!allowed.includes(key)) return false;
  return true;
};

/** `sha1`, another format name, or null when git could not say. */
export const objectFormat = async (repoDir: string, runGit: RunGit): Promise<string | null> => {
  const r = await runGit(repoDir, ['rev-parse', '--show-object-format']);
  return r.code === 0 ? text(r.stdout) : null;
};

const servableRepos = async (ctx: ReadContext): Promise<string[]> => {
  const names: string[] = [];
  for (const repo of listRepos(ctx.root)) {
    // A repository in another object format is left out of the list (§2).
    if ((await objectFormat(repo.dir, ctx.runGit)) === 'sha1') names.push(repo.name);
  }
  return names;
};

/** Resolves the `repo` parameter to a servable SHA-1 repository, or the refusal. */
const openRepo = async (
  ctx: ReadContext,
  repo: string | null | undefined,
): Promise<{ ok: true; name: string; dir: string } | { ok: false; answer: ReadAnswer }> => {
  const resolved = resolveRepo(ctx.root, repo);
  if (!resolved.ok) {
    return {
      ok: false,
      answer:
        resolved.reason === 'malformed' ? refusal(400, 'malformed') : refusal(404, 'not-found'),
    };
  }
  const format = await objectFormat(resolved.dir, ctx.runGit);
  if (format === null) return { ok: false, answer: refusal(500, 'git-failed') };
  if (format !== 'sha1') {
    return { ok: false, answer: refusal(400, 'unsupported-object-format') };
  }
  return { ok: true, name: resolved.name, dir: resolved.dir };
};

const repoMeta = async (ctx: ReadContext, name: string, dir: string): Promise<ReadAnswer> => {
  // A detached HEAD has no default branch; the host then needs a ref in the URL.
  const defaultBranch = await headBranchOf(dir, ctx.runGit);

  const listed = await ctx.runGit(dir, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
    'refs/heads',
    'refs/tags',
  ]);
  if (listed.code !== 0) return refusal(500, 'git-failed');

  const branches: Array<{ name: string; sha: string }> = [];
  const tags: Array<{ name: string; sha: string }> = [];
  for (const line of listed.stdout.toString('utf8').split('\n')) {
    if (line === '') continue;
    const [refname, sha, type, peeledSha, peeledType] = line.split('\0');
    if (refname === undefined || sha === undefined) continue;
    if (refname.startsWith('refs/heads/')) {
      if (type === 'commit') branches.push({ name: refname.slice('refs/heads/'.length), sha });
      continue;
    }
    if (!refname.startsWith('refs/tags/')) continue;
    // `sha` for a tag is the commit it peels to; a tag that peels to no commit
    // is not listed (R-GS-3).
    let commit: string | null = null;
    if (type === 'commit') commit = sha;
    else if (type === 'tag' && peeledType === 'commit' && peeledSha) commit = peeledSha;
    else if (type === 'tag') commit = await peelToCommit(dir, sha, ctx.runGit);
    if (commit !== null) tags.push({ name: refname.slice('refs/tags/'.length), sha: commit });
  }
  return ok({ repo: name, defaultBranch, branches, tags });
};

/** The commit and its tree, from ONE resolution of the ref (R-GS-2). Everything
 *  after `resolveRef` names the commit by its SHA, never by the ref again. */
const resolveCommit = async (
  ctx: ReadContext,
  dir: string,
  ref: string | null | undefined,
): Promise<
  | { ok: true; refKind: RefKind; commitSha: string; treeSha: string }
  | { ok: false; answer: ReadAnswer }
> => {
  if (typeof ref !== 'string') return { ok: false, answer: refusal(400, 'malformed') };
  const resolved = await resolveRef(dir, ref, ctx.runGit);
  if (!resolved.ok) {
    return {
      ok: false,
      answer:
        resolved.reason === 'unknown'
          ? refusal(404, 'not-found')
          : refusal(400, resolved.reason), // 'malformed' or 'ambiguous' (R-GS-3)
    };
  }
  const tree = await ctx.runGit(dir, [
    'rev-parse',
    '--verify',
    '-q',
    '--end-of-options',
    `${resolved.commitSha}^{tree}`,
  ]);
  const treeSha = text(tree.stdout);
  if (tree.code !== 0 || !COMMIT_SHA_RE.test(treeSha)) {
    return { ok: false, answer: refusal(500, 'git-failed') };
  }
  return { ok: true, refKind: resolved.refKind, commitSha: resolved.commitSha, treeSha };
};

/** True when a tree path has a segment no checkout could hold: an empty one,
 *  `.`, `..`, or `.git` in any case. git never writes such a tree, but
 *  `git mktree` does, and the host would mount the path as a file name. */
const isUnsafeTreePath = (path: string): boolean =>
  path
    .split('/')
    .some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git');

/** Every blob entry of the commit's tree, or null when the listing is not whole
 *  (R-GS-4: the tree is complete or the request fails). A tree with an unsafe
 *  path is not listed at all: leaving the entry out would show a tree that is
 *  not the commit's. */
const listTree = async (
  ctx: ReadContext,
  dir: string,
  commitSha: string,
): Promise<TreeFileEntry[] | null> => {
  const listed = await ctx.runGit(dir, [
    'ls-tree',
    '-r',
    '-z',
    '--long',
    '--end-of-options',
    commitSha,
  ]);
  if (listed.code !== 0) return null;
  let output: string;
  try {
    // A path that is not UTF-8 cannot be carried in JSON without changing it.
    output = new TextDecoder('utf-8', { fatal: true }).decode(listed.stdout);
  } catch {
    return null;
  }
  const files: TreeFileEntry[] = [];
  let entries;
  try {
    entries = parseLsTreeLong(output);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (isUnsafeTreePath(entry.path)) return null;
    if (entry.mode === SUBMODULE_MODE) continue; // left out (R-GS-4)
    if (entry.type !== 'blob' || !FILE_MODES.has(entry.mode) || entry.size === undefined) {
      return null;
    }
    files.push({
      path: entry.path,
      mode: entry.mode as TreeFileEntry['mode'],
      sha: entry.sha,
      size: entry.size,
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

export const answerRead = async (
  pathname: string,
  query: URLSearchParams,
  ctx: ReadContext,
): Promise<ReadAnswer> => {
  const repo = single(query, 'repo');
  const ref = single(query, 'ref');
  const sha = single(query, 'sha');

  if (pathname === '/meta') {
    if (!onlyParams(query, ['repo', 'ref'])) return refusal(400, 'malformed');
    if (repo === undefined) {
      if (ref !== undefined) return refusal(400, 'malformed');
      return ok({
        instanceId: ctx.instanceId,
        allowCommit: ctx.allowCommit,
        repos: await servableRepos(ctx),
      });
    }
    const opened = await openRepo(ctx, repo);
    if (!opened.ok) return opened.answer;
    if (ref === undefined) return repoMeta(ctx, opened.name, opened.dir);
    const commit = await resolveCommit(ctx, opened.dir, ref);
    if (!commit.ok) return commit.answer;
    return ok({
      repo: opened.name,
      ref,
      refKind: commit.refKind,
      commitSha: commit.commitSha,
      treeSha: commit.treeSha,
    });
  }

  if (pathname === '/tree') {
    if (!onlyParams(query, ['repo', 'ref'])) return refusal(400, 'malformed');
    const opened = await openRepo(ctx, repo);
    if (!opened.ok) return opened.answer;
    const commit = await resolveCommit(ctx, opened.dir, ref);
    if (!commit.ok) return commit.answer;
    const files = await listTree(ctx, opened.dir, commit.commitSha);
    if (files === null) return refusal(500, 'tree-incomplete');
    return ok({
      repo: opened.name,
      ref,
      refKind: commit.refKind,
      commitSha: commit.commitSha,
      treeSha: commit.treeSha,
      files,
    });
  }

  if (pathname === '/blob') {
    if (!onlyParams(query, ['repo', 'sha'])) return refusal(400, 'malformed');
    // The object format is not asked here: in a repository of another format no
    // 40-hex name is an object, so the type check below already answers 404.
    const resolved = resolveRepo(ctx.root, repo);
    if (!resolved.ok) {
      return resolved.reason === 'malformed' ? refusal(400, 'malformed') : refusal(404, 'not-found');
    }
    if (typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha)) return refusal(400, 'malformed');
    // One 404 for a commit, a tree, a tag and a SHA that names nothing (R-GS-5).
    const type = await ctx.runGit(resolved.dir, ['cat-file', '-t', sha]);
    if (type.code !== 0 || text(type.stdout) !== 'blob') return refusal(404, 'not-found');
    return { kind: 'blob', repoDir: resolved.dir, sha };
  }

  return refusal(404, 'not-found');
};
