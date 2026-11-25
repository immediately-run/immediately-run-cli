/*
 * `immediately-run git-serve` — serve a directory of bare git repositories to
 * hosted immediately.run, so a repository that never leaves this machine mounts
 * there at a real commit (GIT_SERVE_SPEC §4, §9).
 *
 * This file parses arguments and prints; the server is `src/gitServe/`.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { flagValue, type ParsedArgs } from '../args.js';
import { buildProviderDeepLink } from '../deepLink.js';
import { DEFAULT_ORIGIN, runUntilShutdown } from '../devServer.js';
import { gitServeNamespace } from '../gitServe/namespace.js';
import { DEFAULT_GIT_SERVE_PORT, GIT_SERVE_PROTOCOL } from '../gitServe/protocol.js';
import { objectFormat } from '../gitServe/readRoutes.js';
import { headBranchOf, resolveRef } from '../gitServe/refs.js';
import { REPO_DIR_SUFFIX, isRepoName, listRepos } from '../gitServe/repoName.js';
import { gitEnv, runGit } from '../gitServe/runGit.js';
import { startGitServe } from '../gitServe/server.js';
import { isRecognizedOrigin } from './dev.js';

export const GIT_SERVE_USAGE = `Usage: immediately.run git-serve <root> [options]
       immediately.run git-serve init <root> <name>

Serve the bare git repositories under <root> (each one <root>/<name>.git) to
hosted immediately.run and print a link per repository. The page mounts a
repository read-only at a real commit. Only committed objects are served; no
working tree is read. Keep this process running while a page is open.

Commands:
  init <root> <name>        Create <root>/<name>.git as a bare repository.
                            A name is letters, digits, '_' and '-'.

Options:
  --port <n>                Port to listen on (default: ${DEFAULT_GIT_SERVE_PORT})
  --bind <where>            'localhost' (default). 'tailscale' is not available
                            yet (roadmap item R3-1360).
  --origin <url>            Allowed browser origin and deep-link base
                            (default: https://immediately.run; use
                            https://local.immediately.run against the local
                            stack). The site's local-development mediator
                            origin is admitted with it. Only immediately.run,
                            loopback and preview origins are accepted without
                            --origin-unsafe.
  --origin-unsafe           Allow an --origin outside the recognized set
                            (the session token still gates every request)
  --json                    Print one machine-readable JSON line to stdout
                            ({ endpoint, namespace, port, protocol, allowPush,
                            allowCommit, token, links: [{ repo, url }] });
                            diagnostics go to stderr
  -h, --help                Show this help

The state directory <root>/.git-serve/ holds the root's instance id. Deleting it
gives every repository under the root a new namespace on the host, with new
grants and a fresh overlay.`;

const requireDirectory = (path: string): void => {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${path} is not a directory`);
  }
};

/** `git-serve init <root> <name>`: one bare repository, never anything else. */
export const runGitServeInit = (rootArg: string | undefined, name: string | undefined): number => {
  if (rootArg === undefined || name === undefined) {
    throw new Error('Usage: immediately.run git-serve init <root> <name>');
  }
  if (!isRepoName(name)) {
    throw new Error(
      `Invalid repository name: ${JSON.stringify(name)} (letters, digits, '_' and '-' only; ` +
        `the directory gets the ${REPO_DIR_SUFFIX} suffix itself).`,
    );
  }
  const root = resolve(rootArg);
  mkdirSync(root, { recursive: true });
  requireDirectory(root);
  const dir = join(root, name + REPO_DIR_SUFFIX);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  // The path follows `--`, so it is a path whatever it looks like.
  execFileSync('git', ['init', '--bare', '-q', '--', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: gitEnv(),
  });
  console.log(`Created ${dir}`);
  return 0;
};

/**
 * The default branch a repository's link opens, or why it gets no link: the
 * line printed for an unlinked repository names the real cause, never a
 * generic "no commit yet" for a repository that has commits.
 */
export const linkBranchOf = async (
  repoDir: string,
): Promise<{ ok: true; branch: string } | { ok: false; why: string }> => {
  const format = await objectFormat(repoDir, runGit);
  if (format !== 'sha1') {
    // Left out exactly as /meta leaves it out (§2).
    return { ok: false, why: `object format ${format ?? 'unknown'} is not served (SHA-1 only)` };
  }
  const branch = await headBranchOf(repoDir, runGit);
  if (branch === null) return { ok: false, why: 'HEAD names no branch' };
  const resolved = await resolveRef(repoDir, branch, runGit);
  if (resolved.ok && resolved.refKind === 'branch') return { ok: true, branch };
  if (!resolved.ok && resolved.reason === 'ambiguous') {
    return { ok: false, why: `its default branch ${branch} is also a tag name, so a link to it would not resolve` };
  }
  return { ok: false, why: 'no commit on its default branch yet; push one, then restart for its link' };
};

export const runGitServe = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(GIT_SERVE_USAGE);
    return 0;
  }
  if (args.positionals[0] === 'init') {
    return runGitServeInit(args.positionals[1], args.positionals[2]);
  }
  if (args.positionals.length !== 1) {
    throw new Error('git-serve takes one <root> directory. Run with --help for usage.');
  }
  const root = resolve(args.positionals[0]!);
  requireDirectory(root);

  const bindMode = (flagValue(args.flags, 'bind') ?? 'localhost').toLowerCase();
  if (bindMode === 'tailscale') {
    throw new Error(
      '--bind tailscale is not available yet: the tailnet boundary (peer gate, pairing, ' +
        'connections) is roadmap item R3-1360. Serve on localhost for now.',
    );
  }
  if (bindMode !== 'localhost') {
    throw new Error(`Invalid --bind: ${bindMode} (expected 'localhost')`);
  }

  const portFlag = flagValue(args.flags, 'port');
  const port = portFlag === undefined ? DEFAULT_GIT_SERVE_PORT : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${portFlag}`);
  }
  const origin = flagValue(args.flags, 'origin') ?? DEFAULT_ORIGIN;
  if (!isRecognizedOrigin(origin) && args.flags['origin-unsafe'] !== true) {
    throw new Error(
      `Refusing --origin ${origin}: not a recognized immediately.run, loopback, or ` +
        `preview origin. Re-run with --origin-unsafe to allow it (the session ` +
        `token still gates every request).`,
    );
  }

  // 256 random bits, minted per start, compared in constant time (guards.ts).
  const token = randomBytes(32).toString('base64url');
  const handle = await startGitServe({ root, origin, token, port });

  const endpoint = `http://127.0.0.1:${handle.port}`;
  const namespace = gitServeNamespace({ kind: 'loopback', instanceId: handle.instanceId });
  const links: Array<{ repo: string; url: string }> = [];
  const unlinked: Array<{ repo: string; why: string }> = [];
  for (const repo of listRepos(handle.root)) {
    const link = await linkBranchOf(repo.dir);
    if (!link.ok) {
      unlinked.push({ repo: repo.name, why: link.why });
      continue;
    }
    links.push({
      repo: repo.name,
      url: buildProviderDeepLink(origin, 'git', namespace, repo.name, link.branch, endpoint, token),
    });
  }

  if (args.flags.json === true) {
    // Exactly one JSON line on stdout once listening; everything else on stderr.
    process.stdout.write(
      JSON.stringify({
        endpoint,
        namespace,
        port: handle.port,
        protocol: GIT_SERVE_PROTOCOL,
        allowPush: false,
        allowCommit: false,
        token,
        links,
      }) + '\n',
    );
    console.error(`Serving ${handle.root} (read-only) on ${endpoint} for ${origin}. Ctrl-C to stop.`);
  } else {
    console.log(`Serving ${handle.root} (read-only, committed objects only) on ${endpoint}`);
    console.log(`Allowed origin: ${origin}`);
    console.log(`Namespace: ${namespace}`);
    if (links.length === 0 && unlinked.length === 0) {
      console.log(
        `No repositories yet. Create one with: immediately.run git-serve init ${root} <name>`,
      );
    }
    for (const link of links) console.log(`immediately.run git URL (${link.repo}): ${link.url}`);
    for (const { repo, why } of unlinked) console.log(`${repo}: no link — ${why}.`);
    console.log('Press Ctrl-C to stop. Keep this running while a page is open.');
  }

  return await runUntilShutdown(handle);
};
