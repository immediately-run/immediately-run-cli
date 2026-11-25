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
import { buildProviderDeepLink, buildProviderLink } from '../deepLink.js';
import { DEFAULT_ORIGIN, runUntilShutdown } from '../devServer.js';
import {
  isScope,
  readConnections,
  revokeConnection,
  type ConnectionScope,
} from '../gitServe/connections.js';
import { PAIRING_TTL_MS, createPairingCode } from '../gitServe/pairing.js';
import { DEFAULT_GIT_SERVE_PORT, GIT_SERVE_PROTOCOL } from '../gitServe/protocol.js';
import { objectFormat } from '../gitServe/readRoutes.js';
import { headBranchOf, resolveRef } from '../gitServe/refs.js';
import { REPO_DIR_SUFFIX, isRepoName, listRepos } from '../gitServe/repoName.js';
import { gitEnv, runGit } from '../gitServe/runGit.js';
import { startGitServe, type TailnetBinding } from '../gitServe/server.js';
import { ensureStateDir } from '../gitServe/state.js';
import {
  readTailnetIdentity,
  resolveAllowLogins,
  tailscaleWhois,
} from '../gitServe/tailscaleWhois.js';
import { resolveTailscaleBin, resolveTailscaleCert, tailscaleSelf } from '../tailscale.js';
import { isRecognizedOrigin } from './dev.js';

export const GIT_SERVE_USAGE = `Usage: immediately.run git-serve <root> [options]
       immediately.run git-serve init <root> <name>
       immediately.run git-serve pair <root> [--scope read|write]
       immediately.run git-serve connections <root> [--revoke <id>]

Serve the bare git repositories under <root> (each one <root>/<name>.git) to
hosted immediately.run and print a link per repository. The page mounts a
repository read-only at a real commit. Only committed objects are served; no
working tree is read. Keep this process running while a page is open.

Commands:
  init <root> <name>        Create <root>/<name>.git as a bare repository.
                            A name is letters, digits, '_' and '-'.
  pair <root>               Print a one-time pairing code for a server running
                            with --bind tailscale. Enter it, with the server's
                            endpoint, under Settings > Local endpoints in the
                            browser. The code works once, for ten minutes, and
                            dies after five wrong guesses. --scope read (default)
                            or write sets what the connection may do.
  connections <root>        List the browsers that have paired. With
                            --revoke <id>, remove one: its next request fails.

Options:
  --port <n>                Port to listen on (default: ${DEFAULT_GIT_SERVE_PORT})
  --bind <where>            'localhost' (default; a browser on this machine)
                            or 'tailscale': serve HTTPS on this node's tailnet
                            address to your own devices. Every request is then
                            checked against the Tailscale daemon: only devices
                            signed in as you are served, never a tagged node.
                            A browser connects with a pairing code (see pair);
                            no token is printed.
  --host <magicdns>         Override the MagicDNS hostname for --bind tailscale
                            (default: this node's tailnet name).
  --cert <path>             TLS cert (.crt) for --bind tailscale; its .key
                            sibling is the private key. Default: look for
                            <host>.crt/.key in <root>/.git-serve/, <root> and
                            the current directory, else mint one into
                            <root>/.git-serve/ via \`tailscale cert\`.
  --allow-login <login>     With --bind tailscale, also serve devices of this
                            tailnet user (repeatable). Required when this node
                            is itself tagged.
  --allow-push              With --bind tailscale, let git clients push. A push
                            must be a fast-forward and cannot delete a branch;
                            only branches can be pushed (no tags or other refs).
                            Without the flag every push is refused, whatever a
                            repository's own config says. \`git clone\` and
                            \`git fetch\` need no flag.
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
                            allowCommit, links: [{ repo, url }] }, plus the
                            session token on localhost only); diagnostics go
                            to stderr
  -h, --help                Show this help

The state directory <root>/.git-serve/ holds the root's instance id and, for a
tailnet server, its connections (tokens are stored hashed). Deleting it gives
every loopback mount of the root a new namespace on the host, with new grants
and a fresh overlay, and disconnects every paired browser.`;

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

/** `git-serve pair <root> [--scope read|write]`: mint the root's one live code. */
export const runGitServePair = (rootArg: string | undefined, scopeFlag: string | undefined): number => {
  if (rootArg === undefined) {
    throw new Error('Usage: immediately.run git-serve pair <root> [--scope read|write]');
  }
  const scope: unknown = scopeFlag ?? 'read';
  if (!isScope(scope)) throw new Error(`Invalid --scope: ${scopeFlag} (expected 'read' or 'write')`);
  const root = resolve(rootArg);
  requireDirectory(root);
  const granted: ConnectionScope = scope;
  const { code } = createPairingCode(root, granted);
  console.log(`Pairing code: ${code}`);
  console.log(
    `Scope: ${granted}. Valid for ${PAIRING_TTL_MS / 60000} minutes, for one browser. ` +
      `Enter it with the server's endpoint under Settings > Local endpoints.`,
  );
  return 0;
};

/** `git-serve connections <root> [--revoke <id>]`. */
export const runGitServeConnections = (
  rootArg: string | undefined,
  revoke: string | true | undefined,
): number => {
  if (rootArg === undefined) {
    throw new Error('Usage: immediately.run git-serve connections <root> [--revoke <id>]');
  }
  const root = resolve(rootArg);
  requireDirectory(root);
  if (revoke !== undefined) {
    if (revoke === true) throw new Error('--revoke takes a connection id');
    if (!revokeConnection(root, revoke)) throw new Error(`No connection with id ${revoke}`);
    console.log(`Revoked ${revoke}. Its next request is refused.`);
    return 0;
  }
  const list = readConnections(root);
  if (list.length === 0) {
    console.log('No connections. Pair a browser with: immediately.run git-serve pair <root>');
    return 0;
  }
  // Ids, scopes and dates only: the file holds no usable credential to print.
  for (const c of list) console.log(`${c.id}  ${c.scope.padEnd(5)}  connected ${c.createdAt}`);
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

/** Each repository with the branch its link opens, and those with none yet. */
const describeRepos = async (
  root: string,
): Promise<{
  linked: Array<{ repo: string; branch: string }>;
  unlinked: Array<{ repo: string; why: string }>;
}> => {
  const linked: Array<{ repo: string; branch: string }> = [];
  const unlinked: Array<{ repo: string; why: string }> = [];
  for (const repo of listRepos(root)) {
    const link = await linkBranchOf(repo.dir);
    if (link.ok) linked.push({ repo: repo.name, branch: link.branch });
    else unlinked.push({ repo: repo.name, why: link.why });
  }
  return { linked, unlinked };
};

const printRepoLines = (
  root: string,
  links: ReadonlyArray<{ repo: string; url: string }>,
  unlinked: ReadonlyArray<{ repo: string; why: string }>,
): void => {
  if (links.length === 0 && unlinked.length === 0) {
    console.log(`No repositories yet. Create one with: immediately.run git-serve init ${root} <name>`);
  }
  for (const link of links) console.log(`immediately.run git URL (${link.repo}): ${link.url}`);
  for (const { repo, why } of unlinked) console.log(`${repo}: no link — ${why}.`);
};

/**
 * `--bind tailscale`: HTTPS on the node's tailnet address, the peer gate on
 * every request, and no credential printed anywhere. A browser connects with a
 * code from `git-serve pair`.
 */
const serveTailnet = async (
  args: ParsedArgs,
  root: string,
  origin: string,
  port: number,
  allowLogins: readonly string[],
  allowPush: boolean,
): Promise<number> => {
  const bin = resolveTailscaleBin();
  const identity = await readTailnetIdentity(bin);
  // Resolved once, here: a login that names nobody stops the start.
  const allowUserIds = resolveAllowLogins(identity, allowLogins);
  const address = identity.self.addresses.find((ip) => ip.startsWith('100.')) ?? identity.self.addresses[0]!;
  const host = flagValue(args.flags, 'host') ?? tailscaleSelf(bin).dnsName;
  // The certificate is looked for in the state directory first, and minted
  // there when absent: it is 0700, and the private key should not sit in the
  // directory the repositories are in.
  const stateDir = ensureStateDir(root);
  const { cert, key } = resolveTailscaleCert(host, [stateDir, root, process.cwd()], {
    certPath: flagValue(args.flags, 'cert'),
    bin,
    provisionInto: stateDir,
  });
  const tailnet: TailnetBinding = {
    host,
    address,
    cert,
    key,
    peerGate: { self: identity.self, allowUserIds, whois: tailscaleWhois(bin) },
  };
  const handle = await startGitServe({ root, origin, port, tailnet, allowPush });
  const repos = await describeRepos(handle.root);
  // A tailnet link carries no endpoint and no credential: the host finds both
  // in the connection the user made (R-GS-9).
  const links = repos.linked.map(({ repo, branch }) => ({
    repo,
    url: buildProviderLink(origin, 'git', handle.namespace, repo, branch),
  }));

  if (args.flags.json === true) {
    process.stdout.write(
      JSON.stringify({
        endpoint: handle.endpoint,
        namespace: handle.namespace,
        port: handle.port,
        protocol: GIT_SERVE_PROTOCOL,
        allowPush,
        allowCommit: false,
        links,
      }) + '\n',
    );
    console.error(`Serving ${handle.root} (read-only) on ${handle.endpoint} for ${origin}. Ctrl-C to stop.`);
  } else {
    console.log(`Serving ${handle.root} (read-only, committed objects only) on ${handle.endpoint}`);
    console.log(`Bound to the tailnet interface ${address}. Only your own devices are served.`);
    if (allowUserIds.size > 0) console.log(`Also served: devices of ${allowLogins.join(', ')}`);
    console.log(`Allowed origin: ${origin}`);
    console.log(`Namespace: ${handle.namespace}`);
    console.log(`To connect a browser: immediately.run git-serve pair ${root}`);
    console.log(
      allowPush
        ? 'git clients may clone and push branches (fast-forward only, no branch deletes, no tags).'
        : 'git clients may clone and fetch. Push is off (start with --allow-push to allow it).',
    );
    for (const repo of listRepos(handle.root)) {
      console.log(`git clone ${handle.endpoint}/${repo.name}${REPO_DIR_SUFFIX}`);
    }
    printRepoLines(root, links, repos.unlinked);
    console.log('Press Ctrl-C to stop.');
  }
  return await runUntilShutdown(handle);
};

export const runGitServe = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(GIT_SERVE_USAGE);
    return 0;
  }
  if (args.positionals[0] === 'init') {
    return runGitServeInit(args.positionals[1], args.positionals[2]);
  }
  if (args.positionals[0] === 'pair') {
    return runGitServePair(args.positionals[1], flagValue(args.flags, 'scope'));
  }
  if (args.positionals[0] === 'connections') {
    return runGitServeConnections(args.positionals[1], args.flags.revoke);
  }
  if (args.positionals.length !== 1) {
    throw new Error('git-serve takes one <root> directory. Run with --help for usage.');
  }
  const root = resolve(args.positionals[0]!);
  requireDirectory(root);

  const bindMode = (flagValue(args.flags, 'bind') ?? 'localhost').toLowerCase();
  if (bindMode !== 'localhost' && bindMode !== 'tailscale') {
    throw new Error(`Invalid --bind: ${bindMode} (expected 'localhost' or 'tailscale')`);
  }
  const allowLogins = args.repeated['allow-login'] ?? [flagValue(args.flags, 'allow-login')].filter(
    (v): v is string => v !== undefined,
  );
  if (bindMode === 'localhost' && allowLogins.length > 0) {
    throw new Error('--allow-login applies to --bind tailscale only.');
  }
  // R-GS-17: git clients are served on a tailnet only. On localhost the
  // repository is on the same disk; push to its path.
  const allowPush = args.flags['allow-push'] === true;
  if (bindMode === 'localhost' && allowPush) {
    throw new Error(
      '--allow-push applies to --bind tailscale only: on localhost, push to the ' +
        "repository's path on disk (git push <root>/<name>.git <branch>).",
    );
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

  if (bindMode === 'tailscale') {
    return await serveTailnet(args, root, origin, port, allowLogins, allowPush);
  }

  // 256 random bits, minted per start, compared in constant time (guards.ts).
  const token = randomBytes(32).toString('base64url');
  const handle = await startGitServe({ root, origin, token, port });
  const repos = await describeRepos(handle.root);
  const links = repos.linked.map(({ repo, branch }) => ({
    repo,
    url: buildProviderDeepLink(origin, 'git', handle.namespace, repo, branch, handle.endpoint, token),
  }));

  if (args.flags.json === true) {
    // Exactly one JSON line on stdout once listening; everything else on stderr.
    process.stdout.write(
      JSON.stringify({
        endpoint: handle.endpoint,
        namespace: handle.namespace,
        port: handle.port,
        protocol: GIT_SERVE_PROTOCOL,
        allowPush: false,
        allowCommit: false,
        token,
        links,
      }) + '\n',
    );
    console.error(
      `Serving ${handle.root} (read-only) on ${handle.endpoint} for ${origin}. Ctrl-C to stop.`,
    );
  } else {
    console.log(`Serving ${handle.root} (read-only, committed objects only) on ${handle.endpoint}`);
    console.log(`Allowed origin: ${origin}`);
    console.log(`Namespace: ${handle.namespace}`);
    printRepoLines(root, links, repos.unlinked);
    console.log('Press Ctrl-C to stop. Keep this running while a page is open.');
  }

  return await runUntilShutdown(handle);
};
