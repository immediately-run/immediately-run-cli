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

import { existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';

import { startDevServer, runUntilShutdown, type DevServerOptions } from '../devServer.js';
import type { LlmUpstream } from '../llmProxy.js';
import { flagValue, type ParsedArgs } from '../args.js';
import { resolveTailscaleCert, tailscaleSelf } from '../tailscale.js';

export const DEV_USAGE = `Usage: immediately.run dev [repo-path] [options]

Serve the project's working tree to hosted immediately.run and print the deep
link that loads it (no commit, no push). Keep this process running while the
page is open.

Arguments:
  repo-path                 Path to the project directory (default: cwd)
                            The app's identity (its per-checkout namespace, and
                            therefore its appKey on the host) derives from this
                            path AS INVOKED — symlinks are not resolved — so a
                            symlinked view of a checkout runs as a distinct app
                            with its own grants and overlay.

Options:
  --fresh                   Salt the app identity for this run: the host sees a
                            brand-new appKey with no prior grants or overlay —
                            test your first-run consent flow honestly without
                            copying the tree. Each --fresh run is distinct; drop
                            the flag to return to the checkout's stable identity.
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
  --region <regionId>       Serve the working tree as a UI region (e.g.
                            panel.files, page.landing, the editor) instead of the
                            previewed app; the preview then loads from GitHub (§6.8).
  --preview <locator>       With --region, the GitHub app to preview:
                            owner/repo[@ref] or a verbatim present/… route.
                            Default: a blank editor (edit/new) for chrome regions
                            (panel.*, modal.*); the platform landing for page.*.
  --llm-url <baseUrl>       Enable the localhost LLM proxy: forward llm.chat to this
                            single OpenAI-compatible upstream (the host appends
                            /v1/chat/completions), with the key injected server-side
                            on this machine so no passkey seal is needed for an
                            autonomous/CI session. Requires --llm-model.
  --llm-model <id>          Model id the host runs through the proxy (e.g.
                            openai/gpt-4o-mini). Required with --llm-url.
  --llm-key <key>           Key injected SERVER-SIDE into the upstream request; never
                            sent to the browser. Optional (local models need none).
  --llm-auth-header <name>  Header to inject the key into (default: authorization).
  --llm-auth-scheme <s>     Scheme prefix for the key (default: Bearer; '' = raw).
                            (--llm-* also read from IR_DEV_LLM_URL / _MODEL / _KEY /
                            _AUTH_HEADER / _AUTH_SCHEME, so CI needs no flags.)
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

// R3-77 dev LLM proxy config (LOCAL_DEV_AUTHED_SERVER_SPEC §2.2). `--llm-url`
// opts the localhost `POST /llm/…` proxy in; the user's key is injected
// SERVER-SIDE on this machine (never sent to the browser). Flags fall back to
// `IR_DEV_LLM_*` env vars so CI configures it without flags (the backend's
// process.env-first pattern). When `--llm-url` is set, `--llm-model` is REQUIRED:
// the upstream needs a model id for the chat body, which the host reads off the
// `ir-llm-model` deep-link fragment (beside the `ir-transport=llm` routing flag).
// Returns null when no upstream is configured
// (the proxy stays off; the server is GET-only as before). PURE / unit-testable.
export interface DevLlmConfig {
  upstream: LlmUpstream;
  /** Model id surfaced to the host via the `ir-llm-model` fragment. */
  model: string;
}

export const resolveDevLlmConfig = (
  flags: ParsedArgs['flags'],
  env: NodeJS.ProcessEnv = process.env,
): DevLlmConfig | null => {
  const baseUrl = flagValue(flags, 'llm-url') ?? env.IR_DEV_LLM_URL;
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    throw new Error(`Invalid --llm-url: ${baseUrl} (expected an http(s) base URL).`);
  }
  const model = flagValue(flags, 'llm-model') ?? env.IR_DEV_LLM_MODEL;
  if (!model) {
    throw new Error(
      '--llm-url requires --llm-model (or IR_DEV_LLM_MODEL): the upstream needs a model id for chat completions.',
    );
  }
  const apiKey = flagValue(flags, 'llm-key') ?? env.IR_DEV_LLM_KEY;
  const authHeader = flagValue(flags, 'llm-auth-header') ?? env.IR_DEV_LLM_AUTH_HEADER;
  const authScheme = flagValue(flags, 'llm-auth-scheme') ?? env.IR_DEV_LLM_AUTH_SCHEME;
  return {
    upstream: {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(authHeader ? { authHeader } : {}),
      ...(authScheme !== undefined ? { authScheme } : {}),
    },
    model,
  };
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
// #23): the first 8 lowercase-hex chars of SHA-256 over the project root path.
// The CoW overlay/journal identity the host keys on is
// `local/<name>-<hash8>/<name>/live`, so:
//  - the SAME checkout (same invoked path) always yields the same hash ⇒ the
//    same overlay reattaches across server restarts / new tokens / new ports;
//  - two same-named checkouts at DIFFERENT paths get distinct hashes ⇒ distinct
//    overlays, never cross-contaminating each other's in-browser edits.
// Baking it into the deep-link namespace means the host needs no disk-path
// knowledge — it just keys on the namespace segment it already parses.
//
// R3-422: the hash covers the path AS INVOKED (absolute-resolved, but symlinks
// NOT followed — `resolve`, not `realpathSync`). The old realpath derivation
// collapsed a symlinked checkout onto its target's identity, which silently
// broke the documented "serve the tree from another path to get a fresh appKey"
// consent-testing recipe; the invoked path keeps reattach semantics (same
// spelling ⇒ same overlay) while letting a symlink honestly be a distinct app.
// Serving/watching still follow symlinks naturally via the filesystem — only
// identity is spelled the way the user typed it.
//
// `salt` (from `--fresh`) folds extra entropy into the identity so a run serves
// under a brand-new namespace ⇒ a brand-new appKey with no prior grants.
export const identityHash8 = (root: string, salt = ''): string =>
  createHash('sha256')
    .update(resolve(root) + salt)
    .digest('hex')
    .slice(0, 8);

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

// §6.8: turn a `--preview` value into the deep-link path (after the origin, no
// leading slash). Accepts `owner/repo[@ref]` / `github/owner/repo[@ref]` (→ a
// `present/github/…/<ref>/` run route, default ref `main`), or a verbatim
// `present/…` / `edit/…` route passed through unchanged. An empty path (no
// `--preview`) lets the host load its default landing.
export const parsePreviewPath = (spec: string): string => {
  const s = spec.trim().replace(/^\/+/, '');
  if (s.startsWith('present/') || s.startsWith('edit/')) return s; // verbatim route
  const [repoPart, ref = 'main'] = s.replace(/^github\//, '').split('@');
  const segs = repoPart.split('/').filter(Boolean);
  if (segs.length !== 2) {
    throw new Error(
      `Invalid --preview: "${spec}" (expected owner/repo[@ref] or a present/… route)`,
    );
  }
  const [owner, repo] = segs;
  return `present/github/${owner}/${repo}/${ref}/`;
};

// When `--preview` is omitted, pick a default route that actually SHOWS the
// overridden region: editor-chrome regions (panel.*, modal.*, …) only render inside
// an /edit/ view, so default to a blank editor (`edit/new`); a full-page `page.*`
// region IS the page, so the host's default landing (empty path) shows it.
export const defaultPreviewPath = (region: string): string =>
  region.startsWith('page.') ? '' : 'edit/new';

// §6.8 flipped deep link: the PATH is the previewed (GitHub) app — or empty for
// the host default landing — and the local source rides the fragment as a
// dev-override directive (`ir-dev-region`/`ir-dev-source`) alongside the §6.4
// locator. The host binds the named region to the local source; the previewed
// app loads normally. The region directive and token are consumed-and-stripped
// before any sandbox handoff (token hygiene, §6.4).
export const buildRegionDeepLink = (
  origin: string,
  source: string,
  region: string,
  endpoint: string,
  token: string,
  previewPath: string,
): string =>
  `${origin.replace(/\/+$/, '')}/${previewPath}` +
  `#ir-endpoint=${encodeURIComponent(endpoint)}&ir-token=${encodeURIComponent(token)}` +
  `&ir-dev-region=${encodeURIComponent(region)}&ir-dev-source=${encodeURIComponent(source)}`;

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

  // R3-77: resolve the optional dev LLM proxy (flags + IR_DEV_LLM_* env). Throws a
  // clear error on a malformed --llm-url or a missing --llm-model.
  const llmConfig = resolveDevLlmConfig(args.flags);

  // §9.1 bind selection. `localhost` (default) is the v1 loopback path; `tailscale`
  // serves HTTPS on the tailnet interface for cross-machine / iPhone-Safari use.
  const bindMode = (flagValue(args.flags, 'bind') ?? 'localhost').toLowerCase();
  if (bindMode !== 'localhost' && bindMode !== 'tailscale') {
    throw new Error(`Invalid --bind: ${bindMode} (expected 'localhost' or 'tailscale')`);
  }

  // §6.8: serve the working tree as a UI *region* (not the previewed app). The
  // preview then loads from GitHub; --preview selects it (default: platform
  // landing). --preview without --region is meaningless and refused.
  const region = flagValue(args.flags, 'region');
  const previewFlag = flagValue(args.flags, 'preview');
  if (previewFlag !== undefined && region === undefined) {
    throw new Error(
      '--preview requires --region (it selects the previewed app while a UI region is served from local).',
    );
  }
  if (region !== undefined && !region.includes('.')) {
    throw new Error(`Invalid --region: "${region}" (expected a region id like panel.files).`);
  }
  const previewPath =
    previewFlag !== undefined
      ? parsePreviewPath(previewFlag)
      : region !== undefined
        ? defaultPreviewPath(region)
        : '';

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

  const handle = await startDevServer({
    root,
    origin,
    token,
    port,
    bind,
    ...(llmConfig ? { llm: llmConfig.upstream } : {}),
  });
  const projectName = sanitizeProjectName(basename(root));
  // LD2-1: the namespace carries the invoked-path disambiguator; repository stays
  // the bare project name (`local/<name>-<hash8>/<name>/live`). R3-422 `--fresh`
  // salts it with per-run entropy so the host mints a brand-new appKey (no prior
  // grants/overlay) without the tree having to be copied.
  const freshSalt = args.flags.fresh === true ? ` fresh:${randomBytes(8).toString('hex')}` : '';
  const namespace = `${projectName}-${identityHash8(root, freshSalt)}`;
  // The endpoint the iPhone/browser connects to: real https tailnet URL under a
  // tailnet bind, loopback http otherwise.
  const endpoint = bind
    ? `https://${endpointHost}:${handle.port}`
    : `http://127.0.0.1:${handle.port}`;
  // §6.8: a --region run flips the deep link — the path is the previewed GitHub
  // app (or empty for the host default landing) and the local source binds to the
  // named UI region via the fragment. Otherwise the local source IS the preview.
  let url =
    region !== undefined
      ? buildRegionDeepLink(
          origin,
          `local/${namespace}/${projectName}/live`,
          region,
          endpoint,
          token,
          previewPath,
        )
      : buildDeepLink(origin, namespace, projectName, endpoint, token);
  // R3-77: when the `/llm` proxy is configured, signal the host to route
  // `llm.chat@1` through `${endpoint}/llm` with `ir-transport=llm` (the same param
  // `immediately.run llm` emits), and carry the chosen model as `ir-llm-model`. The
  // key is NEVER in the link — it lives server-side on this machine; only the
  // (non-secret) transport flag + model id ride along, beside the host-only `ir-*`
  // params, all stripped before any sandbox handoff.
  if (llmConfig) {
    url += `&ir-transport=llm&ir-llm-model=${encodeURIComponent(llmConfig.model)}`;
  }

  if (args.flags.json === true) {
    // A3 (§10): exactly one JSON line on stdout once listening; everything else
    // (so an agent can parse stdout without scraping prose) goes to stderr. The
    // base four fields never change; `region`/`preview` are additive (§6.8).
    process.stdout.write(
      JSON.stringify({
        url,
        endpoint,
        token,
        port: handle.port,
        ...(region !== undefined ? { region, preview: previewFlag ?? null } : {}),
      }) + '\n',
    );
    console.error(`Serving ${root} (read-only) on ${endpoint} for ${origin}. Ctrl-C to stop.`);
  } else {
    console.log(`Serving ${root} (read-only) on ${endpoint}`);
    if (freshSalt) {
      console.log('Fresh identity (--fresh): the host will mint a new appKey with no prior grants.');
    }
    if (bind) console.log(`Bound to the tailnet interface ${bind.address} (tailnet peers only).`);
    console.log(`Allowed origin: ${origin}`);
    if (llmConfig) {
      console.log(
        `LLM proxy: llm.chat → ${llmConfig.upstream.baseUrl} (model ${llmConfig.model}, ` +
          `key injected server-side${llmConfig.upstream.apiKey ? '' : ' — none configured'}).`,
      );
    }
    if (region !== undefined) {
      console.log(
        `Serving as UI region: ${region} ` +
          `(preview: ${previewFlag ?? (previewPath || 'platform landing')})`,
      );
    }
    console.log(`immediately.run dev URL: ${url}`);
    console.log('Press Ctrl-C to stop. Keep this running while the page is open.');
  }

  if (args.flags.open) {
    openInBrowser(url);
  }

  // Run until interrupted; close the server cleanly on SIGINT/SIGTERM. R3-422:
  // runUntilShutdown destroys the live SSE connections and force-exits past a
  // grace period, so a plain `kill` (SIGTERM) always terminates the process —
  // see its doc comment for the mechanism behind the old hang.
  return await runUntilShutdown(handle);
};
