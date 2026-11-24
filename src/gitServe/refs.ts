/*
 * Ref lookup (GIT_SERVE_SPEC R-GS-3): a ref is a branch, a tag or a 40-hex
 * commit, looked up exactly. No revision expression is ever evaluated.
 *
 *  - A 40-hex value is a commit and nothing else: `cat-file -t` must say
 *    `commit`. It is never tried as a branch or tag name.
 *  - Any other value must pass `git check-ref-format --branch`, and the name git
 *    prints back must be the value itself. That refuses a leading dash, `..`,
 *    `~`, `^`, `:`, `@{`, a backslash and control characters, and it refuses the
 *    `@{-1}` shorthand, which `--branch` would otherwise expand.
 *  - The name is then looked up as exactly `refs/heads/<ref>` and exactly
 *    `refs/tags/<ref>`, with `show-ref --verify`; when both exist the name is
 *    `ambiguous` and does not resolve. `rev-parse refs/heads/<ref>`
 *    is not used for this step: it falls back through git's search list, so a
 *    branch literally named `refs/heads/x` would answer for `x`.
 *  - The object the ref names is peeled to a commit by its SHA. A tag that does
 *    not peel to a commit does not resolve.
 *
 * The only string from a request that reaches git here is the ref, as one
 * argument, in `check-ref-format --branch <ref>` (which takes exactly one
 * argument and reads no options after `--branch`) and after `--` in `show-ref`.
 */

import { COMMIT_SHA_RE, type RunGit } from './protocol.js';

export type RefKind = 'commit' | 'branch' | 'tag';

export type RefResolution =
  | { ok: true; refKind: RefKind; commitSha: string }
  /** `malformed`: not a ref this server looks up. `unknown`: well-formed, not there.
   *  `ambiguous`: both a branch and a tag of that name exist (R-GS-3). */
  | { ok: false; reason: 'malformed' | 'unknown' | 'ambiguous' };

/** Longer than any ref git will store in a file name; refused before git is asked. */
export const MAX_REF_LENGTH = 255;

const text = (b: Buffer): string => b.toString('utf8').trim();

/** True when `ref` is a branch name git accepts, spelled exactly as given. */
export const isBranchName = async (
  repoDir: string,
  ref: string,
  runGit: RunGit,
): Promise<boolean> => {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return false;
  // A NUL cannot be passed as an argument at all; refuse it before spawning.
  if (ref.includes('\0')) return false;
  const checked = await runGit(repoDir, ['check-ref-format', '--branch', ref]);
  return checked.code === 0 && text(checked.stdout) === ref;
};

/** Peels an object SHA to the commit it names, or null when it names none. */
export const peelToCommit = async (
  repoDir: string,
  sha: string,
  runGit: RunGit,
): Promise<string | null> => {
  const peeled = await runGit(repoDir, [
    'rev-parse',
    '--verify',
    '-q',
    '--end-of-options',
    `${sha}^{commit}`,
  ]);
  const commit = text(peeled.stdout);
  return peeled.code === 0 && COMMIT_SHA_RE.test(commit) ? commit : null;
};

/** The object SHA a fully-qualified ref names, looked up exactly, or null. */
const exactRef = async (
  repoDir: string,
  fullRef: string,
  runGit: RunGit,
): Promise<string | null> => {
  const shown = await runGit(repoDir, ['show-ref', '--verify', '--hash', '--', fullRef]);
  const sha = text(shown.stdout);
  return shown.code === 0 && COMMIT_SHA_RE.test(sha) ? sha : null;
};

export const resolveRef = async (
  repoDir: string,
  ref: unknown,
  runGit: RunGit,
): Promise<RefResolution> => {
  if (typeof ref !== 'string') return { ok: false, reason: 'malformed' };

  if (COMMIT_SHA_RE.test(ref)) {
    const type = await runGit(repoDir, ['cat-file', '-t', ref]);
    if (type.code === 0 && text(type.stdout) === 'commit') {
      return { ok: true, refKind: 'commit', commitSha: ref };
    }
    return { ok: false, reason: 'unknown' };
  }

  if (!(await isBranchName(repoDir, ref, runGit))) return { ok: false, reason: 'malformed' };

  // Both namespaces are looked up, never the first hit alone: a name that is a
  // branch AND a tag does not resolve (R-GS-3). A push can create a branch under
  // an existing tag's name, and preferring either would silently change the
  // commit a link opens. A tag that does not peel to a commit is not listed and
  // does not resolve, so it does not make a name ambiguous either.
  const found: Array<{ refKind: RefKind; commitSha: string }> = [];
  for (const [prefix, refKind] of [
    ['refs/heads/', 'branch'],
    ['refs/tags/', 'tag'],
  ] as const) {
    const sha = await exactRef(repoDir, prefix + ref, runGit);
    if (sha === null) continue;
    const commitSha = await peelToCommit(repoDir, sha, runGit);
    if (commitSha !== null) found.push({ refKind, commitSha });
  }
  if (found.length > 1) return { ok: false, reason: 'ambiguous' };
  if (found.length === 1) return { ok: true, ...found[0] };
  return { ok: false, reason: 'unknown' };
};
