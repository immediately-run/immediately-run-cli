/*
 * `immediately.run llm` — a localhost LLM proxy for local / self-hosted models
 * (Ollama, LM Studio, vLLM) or a user's OpenAI-compatible gateway (R3-77 / P3-75;
 * LLM_AND_AGENTS_SPEC §2.4/§3.4, D3 — Approach 4; LOCAL_DEV_AUTHED_SERVER_SPEC).
 *
 * It reuses the SAME authenticated localhost server as `immediately.run agent`
 * (it does NOT stand up a second server), attaching a `POST /llm/...` route that
 * forwards to a SINGLE, user-configured upstream with the user's key injected
 * server-side. The key (or the whole computation) never leaves the user's
 * machine — the in-browser host reaches the endpoint over the same localhost
 * channel (locator + pairing token) and uses it as an alternative LLM transport.
 *
 * Not an open relay: every `/llm` request is pinned to the configured upstream
 * origin. The key is read from the environment by default (never echoed, never in
 * the pairing URL, never in argv where `ps` could see it).
 */

import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { startDevServer } from '../devServer.js';
import { flagValue, type ParsedArgs } from '../args.js';
import { DEFAULT_ORIGIN, DEFAULT_PORT, isRecognizedOrigin } from './dev.js';

/** Env var the upstream key is read from (preferred over `--api-key`, which
 *  would be visible to `ps`). */
export const LLM_KEY_ENV = 'IMMEDIATELY_RUN_LLM_KEY';

export const LLM_USAGE = `Usage: immediately.run llm --upstream <base-url> [repo-path] [options]

Run a localhost LLM proxy that forwards to a SINGLE configured OpenAI-compatible
upstream (a local model server or your own gateway), injecting your key on this
machine. The in-browser host connects out to it as an alternative LLM transport.
Keep this process running while the session is open. It is pinned to the one
upstream — not an open relay.

Arguments:
  repo-path                 Path to the project directory (default: cwd)

Options:
  --upstream <base-url>     REQUIRED. The single OpenAI-compatible base URL to
                            forward to, e.g. http://127.0.0.1:11434
  --api-key <key>           Upstream key (prefer the ${LLM_KEY_ENV} env var, which
                            'ps' cannot see). Optional — local models may need none.
  --auth-header <name>      Header to inject the key into (default: authorization)
  --auth-scheme <scheme>    Scheme prefix for the injected header (default: Bearer;
                            pass an empty string for a raw value, e.g. x-api-key)
  --port <n>                Port to listen on (127.0.0.1 only; default: ${DEFAULT_PORT})
  --origin <url>            Allowed browser origin and pairing base
                            (default: ${DEFAULT_ORIGIN})
  --origin-unsafe           Allow an --origin outside the recognized set
                            (the per-session token still gates every request)
  -h, --help                Show this help`;

// The pairing locator rides the URL fragment (never sent to any server), like the
// agent deep link. It carries the localhost endpoint + the per-session token —
// NOT the upstream key, which stays server-side.
export const buildLlmDeepLink = (origin: string, port: number, token: string): string =>
  `${origin.replace(/\/+$/, '')}/agent` +
  `#ir-endpoint=${encodeURIComponent(`http://127.0.0.1:${port}`)}` +
  `&ir-token=${encodeURIComponent(token)}&ir-transport=llm`;

export const runLlm = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(LLM_USAGE);
    return 0;
  }

  const baseUrl = flagValue(args.flags, 'upstream');
  if (!baseUrl) {
    throw new Error('Missing --upstream <base-url>: the single OpenAI-compatible upstream to forward to.');
  }
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid --upstream ${baseUrl}: not a URL.`);
  }
  if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
    throw new Error(`Invalid --upstream ${baseUrl}: must be an http(s) URL.`);
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
  // LD-3: refuse an unrecognized browser --origin unless --origin-unsafe is given.
  if (!isRecognizedOrigin(origin) && args.flags['origin-unsafe'] !== true) {
    throw new Error(
      `Refusing --origin ${origin}: not a recognized immediately.run, loopback, or ` +
        `preview origin. Re-run with --origin-unsafe to allow it (the per-session ` +
        `token still gates every request).`,
    );
  }

  // Key from the environment by default; --api-key is a fallback we warn about.
  const apiKey = process.env[LLM_KEY_ENV] ?? flagValue(args.flags, 'api-key');
  if (process.env[LLM_KEY_ENV] === undefined && flagValue(args.flags, 'api-key') !== undefined) {
    console.error(
      `Warning: --api-key is visible to other processes via 'ps'. Prefer ${LLM_KEY_ENV}.`,
    );
  }
  const authHeader = flagValue(args.flags, 'auth-header');
  const authScheme = flagValue(args.flags, 'auth-scheme');

  // Per-session token — any local page can reach 127.0.0.1, so every request must
  // present it (spec §8). Identical posture to `dev`/`agent`.
  const token = randomBytes(24).toString('base64url');

  const handle = await startDevServer({
    root,
    origin,
    token,
    port,
    llm: {
      baseUrl,
      apiKey,
      authHeader,
      authScheme,
    },
  });
  const endpoint = `http://127.0.0.1:${handle.port}`;
  const url = buildLlmDeepLink(origin, handle.port, token);

  console.error(`immediately.run llm proxy on ${endpoint} → ${upstreamUrl.origin} (pinned).`);
  console.error(`Key injected server-side${apiKey ? '' : ' (none configured)'}; it never leaves this machine.`);
  console.error(`Open this in your browser to pair the in-browser host:`);
  console.error(`  ${url}`);
  console.error(`Allowed origin: ${origin}. Press Ctrl-C to stop.`);

  return await new Promise<number>((resolveExit) => {
    const shutdown = () => {
      void handle.close().finally(() => resolveExit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
