/*
 * The two constants every git-serve answer names (GIT_SERVE_SPEC R-GS-1).
 *
 * `server` is what tells a git-serve answer from a dev server's on the shared
 * `/meta` route; `protocol` is an integer the host must know before it reads
 * anything else. Bump the integer only for a change an older host would
 * misread; an added field is not one.
 */

export const GIT_SERVE_SERVER = 'git-serve';
export const GIT_SERVE_PROTOCOL = 1;

/** The default port. It differs from `dev`'s (7700) so both can run at once. */
export const DEFAULT_GIT_SERVE_PORT = 7701;

/** What a git call may add to its child: bytes for stdin, and environment
 *  variables set AFTER the inherited `GIT_*` ones were dropped. */
export interface RunGitOptions {
  input?: Buffer;
  env?: Readonly<Record<string, string>>;
}

/** Runs git against one repository: `git --git-dir <repoDir> <args…>`. */
export type RunGit = (
  repoDir: string,
  args: readonly string[],
  options?: RunGitOptions,
) => Promise<GitResult>;

export interface GitResult {
  /** The exit code; a spawn failure or a signal is reported as -1. */
  code: number;
  stdout: Buffer;
  stderr: string;
}

export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
