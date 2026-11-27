/*
 * The one place git-serve starts a git process (GIT_SERVE_SPEC §10.3, "Option
 * or path injection into git").
 *
 * git is always started with an argument vector, never through a shell, and the
 * repository is named with `--git-dir`, so a value from a request can only ever
 * be one whole argument. The callers add `--end-of-options` in front of every
 * value that came from a request.
 *
 * The child's environment drops every inherited `GIT_*` variable. Several of
 * them redirect where git reads objects or config from (`GIT_DIR`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_*`), and the rule that a
 * repository borrows no objects (R-GS-6) would not hold if the shell that
 * started the server could add an object store behind its back.
 */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { GitResult, RunGit } from './protocol.js';

/** Room for the long listing of a very large tree; past this `/tree` answers 500. */
export const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;

/** How long one plumbing call may run. A git that hangs (a dead NFS mount, a
 *  held lock) is killed and reported as any other failure, so its request ends.
 *  It does not apply to `git http-backend` or to a streamed blob: a clone or a
 *  push of a large repository is not bounded by time. */
export const GIT_TIMEOUT_MS = 60_000;

export const gitEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  // Never wait on a terminal, and never take a lock for a read.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
};

const gitArgs = (repoDir: string, args: readonly string[]): string[] => [
  '--git-dir',
  repoDir,
  ...args,
];

export const runGit: RunGit = (repoDir, args, options = {}) =>
  new Promise<GitResult>((resolve) => {
    const child = execFile(
      'git',
      gitArgs(repoDir, args),
      {
        encoding: 'buffer',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        // The caller's variables are set after the inherited GIT_* were dropped.
        env: { ...gitEnv(), ...(options.env ?? {}) },
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : -1;
        resolve({ code, stdout, stderr: stderr.toString('utf8') });
      },
    );
    // A git that exits before reading its input closes the pipe; the exit code
    // above already reports that failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
  });

/** Starts git with its stdout left as a stream, for a body too large to buffer. */
export const spawnGit = (
  repoDir: string,
  args: readonly string[],
): ChildProcessByStdio<null, Readable, null> =>
  spawn('git', gitArgs(repoDir, args), { stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() });
