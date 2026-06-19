/*
 * `immediately.run dev` — serve the current project's working tree to hosted
 * immediately.run over localhost, and print/open the deep link that mounts it
 * as a `local` provider source (LOCAL_DEVELOPMENT_SPEC §6.3/§6.4/§10).
 *
 * Nothing is committed or pushed: the page reads the live working tree
 * (uncommitted edits included) and hot-updates on every save via the /watch
 * SSE stream. Agent-facing: runs non-interactively and prints the URL on a
 * single parseable line.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';

import { startDevServer, type DevServerOptions } from '../devServer.js';
import { flagValue, type ParsedArgs } from '../args.js';
import { resolveTailscaleCert, tailscaleSelf } from '../tailscale.js';

export const DEV_USAGE = `Usage: immediately.run dev [repo-path] [options]

Serve the project's working tree to hosted immediately.run and print the deep
link that loads it (no commit, no push). Keep this process running while the
page is open.

Arguments:
  repo-path                 Path to the project directory (default: cwd)

Options:
  --port <n>                Port to listen on (default: 7700)
  --bind <where>            'localhost' (default; Chrome/Firefox, same machine)
                            or 'tailscale' to serve HTTPS on the tailnet
                            interface for cross-machine / iPhone-Safari use (§9.1).
  --host <magicdns>         Override the MagicDNS hostname for --bind tailscale
                            (default: this node's tailnet name).
  --cert <path>             TLS cert (.crt) for --bind tailscale; its .key sibling
                            is used for the private key. Default: look for
                            <host>.crt/.key, else mint via \`tailscale cert\`.
  --origin <url>            Allowed browser origin and deep-link base
                            (default: https://immediately.run; use e.g.
                            http://localhost:3000 against a local site build).
                            Only immediately.run, loopback, and preview origins
                            are accepted without --origin-unsafe.
  --origin-unsafe           Allow an --origin outside the recognized set
                            (the per-session token still gates every request)
  --open                    Open the deep link in the default browser
  --json                    Print one machine-readable JSON line to stdout
                            ({ url, endpoint, token, port }); diagnostics → stderr
  -h, --help                Show this help`;

export const DEFAULT_PORT = 7700;
export const DEFAULT_ORIGIN = 'https://immediately.run';

// LD-3 (LOCAL_DEVELOPMENT_SPEC §8, decision §6a#24b): `--origin` must not let one
// careless flag silently disable the Origin defense. These values are accepted
// silently — the production origin, loopback origins (any port) for local site
// builds, and the deployment's recognized self-host / Firebase preview patterns;
// ANY other value is refused unless `--origin-unsafe` accompanies it. The
// per-session token remains the backstop either way. Returns false for anything
// that isn't a bare `scheme://host[:port]` origin (a path/query/userinfo means it
// isn't an Origin a browser would ever send).
export const isRecognizedOrigin = (origin: string): boolean => {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.pathname !== '' && u.pathname !== '/') return false;
  const host = u.hostname;
  // Loopback site builds (http/https, any port).
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // Production + self-host/preview subdomains + Firebase preview channels (https).
  if (u.protocol === 'https:') {
    if (host === 'immediately.run' || host.endsWith('.immediately.run')) return true;
    if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) return true;
  }
  return false;
};

// The URL path segments only admit [a-zA-Z0-9-_] (immediately-run-sdk
// urlUtils PATH_SEGMENTS), so the project name must be sanitized to that set.
export const sanitizeProjectName = (name: string): string => {
  const cleaned = name
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'project';
};

// The per-checkout disambiguator (LD2-1, LOCAL_DEVELOPMENT_SPEC §6.2, decision
// #23): the first 8 lowercase-hex chars of SHA-256 over the project root's
// RESOLVED real path. The CoW overlay/journal identity the host keys on is
// `local/<name>-<hash8>/<name>/live`, so:
//  - the SAME checkout (same realpath) always yields the same hash ⇒ the same
//    overlay reattaches across server restarts / new tokens / new ports;
//  - two same-named checkouts at DIFFERENT paths get distinct hashes ⇒ distinct
//    overlays, never cross-contaminating each other's in-browser edits.
// Baking it into the deep-link namespace means the host needs no disk-path
// knowledge — it just keys on the namespace segment it already parses.
export const realpathHash8 = (root: string): string =>
  createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 8);

// The connection locator rides the URL fragment — never sent to any server —
// because the path charset can't carry it (LOCAL_DEVELOPMENT_SPEC §6.4). The
// `endpoint` is `http://127.0.0.1:<port>` for a loopback bind, or the real
// `https://<magicdns>:<port>` tailnet URL under `--bind tailscale` (§9.1).
export const buildDeepLink = (
  origin: string,
  namespace: string,
  repository: string,
  endpoint: string,
  token: string,
): string =>
  `${origin.replace(/\/+$/, '')}/edit/local/${namespace}/${repository}/live` +
  `#ir-endpoint=${encodeURIComponent(endpoint)}&ir-token=${encodeURIComponent(token)}`;

const openInBrowser = (url: string): void => {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url] as string[]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url] as string[]]
        : ['xdg-open', [url] as string[]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best effort */
  }
};

export const runDev = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(DEV_USAGE);
    return 0;
  }

  const root = resolve(args.positionals[0] ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }

  const portFlag = flagValue(args.flags, 'port');
  const port = portFlag === undefined ? DEFAULT_PORT : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port: ${portFlag}`);
  }
  const origin = flagValue(args.flags, 'origin') ?? DEFAULT_ORIGIN;
  // LD-3: refuse an unrecognized --origin unless --origin-unsafe is given too.
  if (!isRecognizedOrigin(origin) && args.flags['origin-unsafe'] !== true) {
    throw new Error(
      `Refusing --origin ${origin}: not a recognized immediately.run, loopback, or ` +
        `preview origin. Re-run with --origin-unsafe to allow it (the per-session ` +
        `token still gates every request).`,
    );
  }

  // §9.1 bind selection. `localhost` (default) is the v1 loopback path; `tailscale`
  // serves HTTPS on the tailnet interface for cross-machine / iPhone-Safari use.
  const bindMode = (flagValue(args.flags, 'bind') ?? 'localhost').toLowerCase();
  if (bindMode !== 'localhost' && bindMode !== 'tailscale') {
    throw new Error(`Invalid --bind: ${bindMode} (expected 'localhost' or 'tailscale')`);
  }

  // Per-session secret: any web page can fetch the dev server, so every request
  // must present this token (spec §8) — the load-bearing control on both binds.
  const token = randomBytes(24).toString('base64url');

  // Resolve the tailnet binding BEFORE starting the server: discover this node's
  // MagicDNS name + tailnet IP and its `tailscale cert` (minting one if absent).
  let bind: DevServerOptions['bind'];
  let endpointHost: string | undefined;
  if (bindMode === 'tailscale') {
    const self = tailscaleSelf();
    const host = flagValue(args.flags, 'host') ?? self.dnsName;
    const { cert, key } = resolveTailscaleCert(host, [root, process.cwd()], {
      certPath: flagValue(args.flags, 'cert'),
    });
    bind = { host, address: self.address, cert, key };
    endpointHost = host;
  }

  const handle = await startDevServer({ root, origin, token, port, bind });
  const projectName = sanitizeProjectName(basename(root));
  // LD2-1: the namespace carries the realpath disambiguator; repository stays the
  // bare project name (`local/<name>-<hash8>/<name>/live`).
  const namespace = `${projectName}-${realpathHash8(root)}`;
  // The endpoint the iPhone/browser connects to: real https tailnet URL under a
  // tailnet bind, loopback http otherwise.
  const endpoint = bind
    ? `https://${endpointHost}:${handle.port}`
    : `http://127.0.0.1:${handle.port}`;
  const url = buildDeepLink(origin, namespace, projectName, endpoint, token);

  if (args.flags.json === true) {
    // A3 (§10): exactly one JSON line on stdout once listening; everything else
    // (so an agent can parse stdout without scraping prose) goes to stderr.
    process.stdout.write(
      JSON.stringify({ url, endpoint, token, port: handle.port }) + '\n',
    );
    console.error(`Serving ${root} (read-only) on ${endpoint} for ${origin}. Ctrl-C to stop.`);
  } else {
    console.log(`Serving ${root} (read-only) on ${endpoint}`);
    if (bind) console.log(`Bound to the tailnet interface ${bind.address} (tailnet peers only).`);
    console.log(`Allowed origin: ${origin}`);
    console.log(`immediately.run dev URL: ${url}`);
    console.log('Press Ctrl-C to stop. Keep this running while the page is open.');
  }

  if (args.flags.open) {
    openInBrowser(url);
  }

  // Run until interrupted; close the server cleanly on SIGINT/SIGTERM.
  return await new Promise<number>((resolveExit) => {
    const shutdown = () => {
      void handle.close().finally(() => resolveExit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
