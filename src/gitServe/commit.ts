/*
 * Write-back from the browser: `POST /commit` (GIT_SERVE_SPEC §8, R-GS-18 to
 * R-GS-22).
 *
 * One commit, on one branch, as a compare-and-swap. The browser sends file
 * contents; the server builds the tree, writes the commit and moves the branch
 * only if it still points where the browser said it did.
 *
 *   planCommit   pure. Checks the request against the parent commit's tree and
 *                returns what to write, or a named refusal.
 *   applyCommit  runs git: a private index, `update-index --index-info`,
 *                `write-tree`, `commit-tree`, and the swap with `update-ref`.
 *
 * What the request can never choose:
 *   - the ref namespace: only `refs/heads/<branch>` is writable (R-GS-19);
 *   - the parent: it is the tip the swap replaces, so every move is a
 *     fast-forward by construction;
 *   - file modes: a new file is 100644, a changed file keeps its mode (R-GS-21);
 *   - the author and committer: they are the server's (R-GS-22).
 *
 * Paths are validated by git itself (R-GS-20): the tree is built through the
 * index with `core.protectHFS` and `core.protectNTFS` forced on, which keeps
 * out `.git` in every case, trailing-space, short-name and zero-width form, and
 * every dot segment. `git mktree` is never used: it performs no such check.
 * git keeps such a path out by SKIPPING it, without failing, so `applyCommit`
 * reads the index back and refuses the request if any planned path is missing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseLsTreeLong } from '../git.js';
import { COMMIT_SHA_RE, type RunGit } from './protocol.js';
import { isBranchName } from './refs.js';

/** The request body limit. It equals the mediator's relay bound on purpose
 *  (site-main `devbridge/core.js`, `MAX_RELAY_BODY_BYTES`), so a request the
 *  mediator passes is never refused here for its size. */
export const MAX_COMMIT_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Bounds on one request's shape. Without them a small body could cost a great
 *  deal: every path is checked against each of its directory prefixes, and
 *  every change starts a git process. */
export const MAX_CHANGES = 2000;
export const MAX_PATH_BYTES = 4096;
export const MAX_PATH_SEGMENTS = 64;
export const CONNECTION_TRAILER = 'Git-Serve-Connection';

const ZERO_SHA = '0'.repeat(40);
const PROTECT = ['-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true'] as const;

export type CommitRefusal =
  | { status: 400; reason: string; path?: string }
  | { status: 409; reason: 'conflict'; currentSha: string | null }
  | { status: 500; reason: string };

export interface CommitRequest {
  repo: string;
  branch: string;
  /** The branch's tip, or null for a new branch. */
  expectedSha: string | null;
  /** The parent of a new branch. Absent when the branch exists. */
  baseSha?: string;
  message: string;
  changes: CommitChange[];
}

export type CommitChange =
  | { path: string; contentBase64: string }
  | { path: string; delete: true };

/** One entry of the parent commit's tree, as `ls-tree -r` lists it. */
export interface ParentEntry {
  mode: string;
  sha: string;
}
export type ParentTree = ReadonlyMap<string, ParentEntry>;

export interface CommitPlan {
  writes: Array<{ path: string; mode: '100644' | '100755'; content: Buffer }>;
  deletes: string[];
}

const TOP_FIELDS = new Set(['repo', 'branch', 'expectedSha', 'baseSha', 'message', 'changes']);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const bad = (reason: string, path?: string): { ok: false; refusal: CommitRefusal } => ({
  ok: false,
  refusal: path === undefined ? { status: 400, reason } : { status: 400, reason, path },
});

/**
 * Reads the JSON body into a typed request, refusing every shape §8 does not
 * define. An unknown field is refused rather than ignored: a client that sent
 * an `author` or a `mode` must not be left believing it was honored.
 */
export const parseCommitRequest = (
  body: unknown,
): { ok: true; request: CommitRequest } | { ok: false; refusal: CommitRefusal } => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('malformed');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!TOP_FIELDS.has(key)) return bad('unknown-field');
  if (typeof b.repo !== 'string' || typeof b.branch !== 'string') return bad('malformed');
  if (b.expectedSha !== null && !(typeof b.expectedSha === 'string' && COMMIT_SHA_RE.test(b.expectedSha))) {
    return bad('malformed');
  }
  if (b.baseSha !== undefined && !(typeof b.baseSha === 'string' && COMMIT_SHA_RE.test(b.baseSha))) {
    return bad('malformed');
  }
  // An existing branch names its tip and no base; a new branch names its base.
  if (b.expectedSha !== null && b.baseSha !== undefined) return bad('base-with-expected');
  if (b.expectedSha === null && b.baseSha === undefined) return bad('no-base');
  if (typeof b.message !== 'string' || b.message.trim() === '') return bad('message');
  if (Buffer.byteLength(b.message, 'utf8') > MAX_MESSAGE_BYTES) return bad('message');
  if (b.message.includes('\0')) return bad('message');
  // The connection trailer is the server's statement about who committed.
  if (new RegExp(`^${CONNECTION_TRAILER}\\s*:`, 'im').test(b.message)) return bad('message');
  if (!Array.isArray(b.changes) || b.changes.length === 0) return bad('no-changes');
  if (b.changes.length > MAX_CHANGES) return bad('too-many-changes');

  const changes: CommitChange[] = [];
  for (const raw of b.changes) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('malformed');
    const c = raw as Record<string, unknown>;
    if (typeof c.path !== 'string') return bad('malformed');
    // Refused here, before any per-path work, and without echoing a huge path.
    if (Buffer.byteLength(c.path, 'utf8') > MAX_PATH_BYTES || c.path.split('/').length > MAX_PATH_SEGMENTS) {
      return bad('path-too-long');
    }
    const keys = Object.keys(c).sort().join(',');
    if (keys === 'delete,path' && c.delete === true) {
      changes.push({ path: c.path, delete: true });
    } else if (keys === 'contentBase64,path' && typeof c.contentBase64 === 'string') {
      if (!BASE64_RE.test(c.contentBase64)) return bad('malformed', c.path);
      changes.push({ path: c.path, contentBase64: c.contentBase64 });
    } else {
      // A `mode`, an `author`, a delete with content, `delete: false`, …
      return bad('unknown-field', c.path);
    }
  }
  const request: CommitRequest = {
    repo: b.repo,
    branch: b.branch,
    expectedSha: b.expectedSha as string | null,
    message: b.message,
    changes,
    ...(b.baseSha !== undefined ? { baseSha: b.baseSha as string } : {}),
  };
  return { ok: true, request };
};

/** Code points HFS+ ignores in a file name (git's own list, utf8.c). */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * True when a path component is `.gitmodules` under any spelling a
 * case-insensitive, HFS+ or NTFS checkout would resolve to that file: another
 * case, ignorable code points, trailing dots and spaces, an alternate data
 * stream suffix, or the 8.3 short names. git's own path check refuses these
 * spellings only for symlinks, so `core.protectHFS`/`protectNTFS` do not cover
 * a regular file.
 */
export const isGitmodulesName = (component: string): boolean => {
  let name = component.replace(HFS_IGNORABLE, '').toLowerCase();
  const stream = name.indexOf(':');
  if (stream !== -1) name = name.slice(0, stream);
  name = name.replace(/[. ]+$/, '');
  return name === '.gitmodules' || /^gitmod~[1-4]$/.test(name) || /^gi7eba~?/.test(name) || /^gi7eb~/.test(name);
};

/** Every proper directory prefix of a path: `a/b/c` → `a`, `a/b`. */
const prefixes = (path: string): string[] => {
  const parts = path.split('/');
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/**
 * The checks made before git (R-GS-20), against the parent commit's tree.
 * Each refusal is a 400 with a `reason` and the `path`.
 *
 * Every rule reads the PARENT tree only. A request cannot, for example, delete
 * a file and add a directory under its name in one commit; that takes two.
 */
export const planCommit = (
  request: CommitRequest,
  parentTree: ParentTree,
): { ok: true; plan: CommitPlan } | { ok: false; refusal: CommitRefusal } => {
  // The directories of the parent tree: every prefix of every entry.
  const parentDirs = new Set<string>();
  for (const path of parentTree.keys()) for (const dir of prefixes(path)) parentDirs.add(dir);

  const seen = new Set<string>();
  const plan: CommitPlan = { writes: [], deletes: [] };
  for (const change of request.changes) {
    const path = change.path;
    // Shapes that cannot be a tree path at all. git would refuse most of them;
    // a NUL or a newline could not even be handed to it as one record.
    if (path === '' || path.startsWith('/') || path.endsWith('/') || /[\0\n\r]/.test(path)) {
      return bad('path-malformed', path);
    }
    if (path.includes('\\')) return bad('path-backslash', path);
    if (seen.has(path)) return bad('path-duplicate', path);
    seen.add(path);
    // `.gitmodules` decides where a submodule is fetched from. Refused under
    // every spelling, at any depth.
    if (path.split('/').some(isGitmodulesName)) return bad('gitmodules', path);
    // At or under a symlink or a submodule of the parent tree.
    for (const at of [...prefixes(path), path]) {
      const mode = parentTree.get(at)?.mode;
      if (mode === '120000') return bad('under-symlink', path);
      if (mode === '160000') return bad('under-submodule', path);
    }
    const existing = parentTree.get(path);
    if ('delete' in change) {
      if (existing === undefined) return bad('delete-absent', path);
      plan.deletes.push(path);
      continue;
    }
    // A file where the parent has a directory, and the reverse.
    if (parentDirs.has(path)) return bad('file-over-directory', path);
    if (prefixes(path).some((dir) => parentTree.has(dir))) return bad('directory-over-file', path);
    // The mode is never the request's: a new file is 100644, a changed file
    // keeps the parent's 100644 or 100755.
    const mode = existing?.mode === '100755' ? '100755' : '100644';
    plan.writes.push({ path, mode, content: Buffer.from(change.contentBase64, 'base64') });
  }
  // The same check between the request's own paths: `a` and `a/b` together.
  for (const path of seen) {
    if (prefixes(path).some((dir) => seen.has(dir))) return bad('file-over-directory', path);
  }
  return { ok: true, plan };
};

export interface CommitIdentity {
  name: string;
  email: string;
}

/** `Name <email>` → its parts, or null. */
export const parseAuthor = (value: string): CommitIdentity | null => {
  const m = /^\s*([^<>\n]+?)\s*<([^<>\s]+)>\s*$/.exec(value);
  return m ? { name: m[1]!, email: m[2]! } : null;
};

/** One line of a trailer block as git reads it: `Token: value`, or the folded
 *  continuation of the line above. */
const TRAILER_LINE_RE = /^(?:[A-Za-z0-9-]+[ \t]*:|[ \t]+\S)/;

/**
 * The message with the connection trailer added.
 *
 * git reads trailers from the LAST paragraph only. When the message already
 * ends in a trailer block (`Signed-off-by:`, `Co-authored-by:`), the line joins
 * that block; a paragraph of its own would leave the user's lines as body text.
 * The first paragraph is the subject and never a trailer block, whatever it
 * looks like.
 */
export const withConnectionTrailer = (message: string, connectionId: string): string => {
  const body = message.trimEnd();
  const paragraphs = body.split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1]!.split('\n');
  const endsInTrailers =
    paragraphs.length > 1 && !/^[ \t]/.test(last[0]!) && last.every((line) => TRAILER_LINE_RE.test(line));
  return `${body}${endsInTrailers ? '\n' : '\n\n'}${CONNECTION_TRAILER}: ${connectionId}\n`;
};

export interface ApplyContext {
  runGit: RunGit;
  identity: CommitIdentity;
  /** The connection that makes the commit; `loopback` for the session credential. */
  connectionId: string;
}

const text = (b: Buffer): string => b.toString('utf8').trim();

/** The tip of `refs/heads/<branch>`, looked up exactly, or null. */
const branchTip = async (repoDir: string, branch: string, runGit: RunGit): Promise<string | null> => {
  const shown = await runGit(repoDir, ['show-ref', '--verify', '--hash', '--', `refs/heads/${branch}`]);
  const sha = text(shown.stdout);
  return shown.code === 0 && COMMIT_SHA_RE.test(sha) ? sha : null;
};

const isCommit = async (repoDir: string, sha: string, runGit: RunGit): Promise<boolean> => {
  const type = await runGit(repoDir, ['cat-file', '-t', sha]);
  return type.code === 0 && text(type.stdout) === 'commit';
};

/**
 * Validates and applies one commit request against one repository.
 * On any refusal nothing reachable was written: objects created before a
 * failed swap are unreachable and left for git to prune (R-GS-18).
 */
export const applyCommit = async (
  repoDir: string,
  request: CommitRequest,
  ctx: ApplyContext,
): Promise<
  { ok: true; commitSha: string; treeSha: string } | { ok: false; refusal: CommitRefusal }
> => {
  const { runGit } = ctx;
  // Only refs/heads/ is writable, and only under a name git accepts as a branch.
  if (!(await isBranchName(repoDir, request.branch, runGit))) return bad('branch');
  // A branch that is a symbolic ref would carry the write to whatever it names
  // (a tag, for one). It is refused, and the swap below never dereferences.
  const symbolic = await runGit(repoDir, ['symbolic-ref', '-q', `refs/heads/${request.branch}`]);
  if (symbolic.code === 0) return bad('branch');

  // The parent is the tip the swap will replace. This read is a courtesy that
  // answers the common conflict early; the swap below is the authority.
  const tip = await branchTip(repoDir, request.branch, runGit);
  if (request.expectedSha !== tip) {
    return { ok: false, refusal: { status: 409, reason: 'conflict', currentSha: tip } };
  }
  // A new branch under an existing tag's name would make the name mean two
  // things, and every read of it would then be refused as ambiguous
  // (`resolveRef`). The name is refused as any other unusable branch name is.
  if (request.expectedSha === null) {
    const tag = await runGit(repoDir, ['show-ref', '--verify', '-q', '--', `refs/tags/${request.branch}`]);
    if (tag.code === 0) return bad('branch');
  }
  const parent = request.expectedSha ?? request.baseSha!;
  if (!(await isCommit(repoDir, parent, runGit))) return bad('unknown-base');

  const listed = await runGit(repoDir, ['ls-tree', '-r', '-z', '--long', '--end-of-options', parent]);
  if (listed.code !== 0) return { ok: false, refusal: { status: 500, reason: 'git-failed' } };
  const parentTree = new Map<string, ParentEntry>();
  for (const entry of parseLsTreeLong(listed.stdout.toString('utf8'))) {
    parentTree.set(entry.path, { mode: entry.mode, sha: entry.sha });
  }
  const planned = planCommit(request, parentTree);
  if (!planned.ok) return planned;
  const { plan } = planned;

  // A private index in a fresh directory outside the repository, removed in
  // `finally`. The repository's own index (a bare one has none) is never touched.
  const scratch = mkdtempSync(join(tmpdir(), 'git-serve-commit-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const failed = (): { ok: false; refusal: CommitRefusal } => ({
      ok: false,
      refusal: { status: 500, reason: 'git-failed' },
    });
    const read = await runGit(repoDir, [...PROTECT, 'read-tree', '--end-of-options', parent], { env });
    if (read.code !== 0) return failed();

    // NUL-terminated index records: `<mode> <sha>\t<path>\0`. Mode 0 removes.
    const records: Buffer[] = [];
    for (const write of plan.writes) {
      const hashed = await runGit(
        repoDir,
        [...PROTECT, 'hash-object', '-w', '--no-filters', '--stdin'],
        { input: write.content },
      );
      const sha = text(hashed.stdout);
      if (hashed.code !== 0 || !COMMIT_SHA_RE.test(sha)) return failed();
      records.push(Buffer.from(`${write.mode} ${sha}\t${write.path}\0`, 'utf8'));
    }
    for (const path of plan.deletes) {
      records.push(Buffer.from(`0 ${ZERO_SHA}\t${path}\0`, 'utf8'));
    }
    // git checks every added path here (verify_path), with HFS and NTFS
    // protection on. `--add` admits new paths; without `--replace` a
    // file/directory conflict the plan missed is an error, not an overwrite.
    const indexed = await runGit(
      repoDir,
      [...PROTECT, 'update-index', '-z', '--add', '--index-info'],
      { env, input: Buffer.concat(records) },
    );
    if (indexed.code !== 0) {
      const named = /Invalid path '(.*)'/.exec(indexed.stderr)?.[1];
      return bad('path-refused', named);
    }
    // `--index-info` does not FAIL on a path git refuses: it prints "Ignoring
    // path" and exits 0, leaving the path out. So the index is read back, and
    // the request is refused unless every write is in it exactly as planned and
    // every delete is gone. This is what turns git's check into this route's.
    const staged = await runGit(repoDir, [...PROTECT, 'ls-files', '--stage', '-z'], { env });
    if (staged.code !== 0) return failed();
    const inIndex = new Map<string, string>();
    for (const record of staged.stdout.toString('utf8').split('\0')) {
      const m = /^(\d+) ([0-9a-f]{40}) \d\t(.*)$/s.exec(record);
      if (m) inIndex.set(m[3]!, `${m[1]} ${m[2]}`);
    }
    for (const [i, write] of plan.writes.entries()) {
      const planned = records[i]!.toString('utf8').split('\t')[0]!;
      if (inIndex.get(write.path) !== planned) return bad('path-refused', write.path);
    }
    for (const path of plan.deletes) {
      if (inIndex.has(path)) return bad('path-refused', path);
    }
    const wrote = await runGit(repoDir, [...PROTECT, 'write-tree'], { env });
    const treeSha = text(wrote.stdout);
    if (wrote.code !== 0 || !COMMIT_SHA_RE.test(treeSha)) return failed();
    // A request whose every change equals what the parent already holds would
    // land as an empty commit; it is refused instead.
    const parentTreeSha = await runGit(repoDir, ['rev-parse', '--verify', '-q', '--end-of-options', `${parent}^{tree}`]);
    if (parentTreeSha.code !== 0) return failed();
    if (text(parentTreeSha.stdout) === treeSha) return bad('no-change');

    // Authorship is the server's; the connection is recorded as a trailer.
    const message = withConnectionTrailer(request.message, ctx.connectionId);
    const committed = await runGit(
      repoDir,
      ['commit-tree', treeSha, '-p', parent, '-F', '-'],
      {
        input: Buffer.from(message, 'utf8'),
        env: {
          GIT_AUTHOR_NAME: ctx.identity.name,
          GIT_AUTHOR_EMAIL: ctx.identity.email,
          GIT_COMMITTER_NAME: ctx.identity.name,
          GIT_COMMITTER_EMAIL: ctx.identity.email,
        },
      },
    );
    const commitSha = text(committed.stdout);
    if (committed.code !== 0 || !COMMIT_SHA_RE.test(commitSha)) return failed();

    // The swap. `<old>` is the expected tip, or the all-zero id for a branch
    // that must not exist yet. If the ref is in any other state git refuses,
    // and the commit just written stays unreachable.
    const swapped = await runGit(repoDir, [
      'update-ref',
      '--no-deref',
      `refs/heads/${request.branch}`,
      commitSha,
      request.expectedSha ?? ZERO_SHA,
    ]);
    if (swapped.code !== 0) {
      // A conflict only if the branch is somewhere else than the request said.
      // Otherwise the ref could not be written for another reason, and telling
      // the browser "conflict" would have it refresh and retry forever.
      const currentSha = await branchTip(repoDir, request.branch, runGit);
      if (currentSha !== request.expectedSha) {
        return { ok: false, refusal: { status: 409, reason: 'conflict', currentSha } };
      }
      // A new branch whose name collides with an existing one (`main/x` beside
      // `main`) can never be created; anything else (a held lock) may pass.
      return request.expectedSha === null ? bad('branch') : failed();
    }
    return { ok: true, commitSha, treeSha };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
