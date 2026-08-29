/*
 * `immediately.run agent` — bridge a locally-running Claude Code to the
 * in-browser immediately.run host (R3-76; LLM_AND_AGENTS_SPEC §3.4;
 * LOCAL_DEV_AUTHED_SERVER_SPEC). Two things run in one process:
 *
 *  1. an **MCP server over stdio** (the v1-only MCP transport — LA-5) that
 *     Claude Code connects to as an ordinary MCP server; its tools are the
 *     platform's grant-filtered catalog, and a `tools/call` is bridged to the
 *     browser host; and
 *  2. the **authenticated localhost bridge server** (the §6.3/§8 dev server with
 *     a bridge attached) that the in-browser host **kernel connects OUT** to —
 *     it pulls queued calls over `GET /agent/pending`, runs each through its
 *     §8.4-gated `invoke()`, and posts results to `POST /agent/result`.
 *
 * The bridged agent's native local power is the user's own and is NOT
 * over-claimed as confined (T23); only the *platform* actions it drives are
 * grant-bounded, by the host's gate. stdout is reserved for MCP JSON-RPC, so all
 * human-facing output (the pairing URL) goes to stderr.
 */

import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';

import { startDevServer, runUntilShutdown } from '../devServer.js';
import { AgentBridge, DEFAULT_CALL_TIMEOUT_MS } from '../bridge.js';
import { runMcpStdio } from '../mcp.js';
import { flagValue, type ParsedArgs } from '../args.js';
import {
  DEFAULT_ORIGIN,
  DEFAULT_PORT,
  isRecognizedOrigin,
  identityHash8,
  sanitizeProjectName,
} from './dev.js';

export const AGENT_USAGE = `Usage: immediately.run agent [repo-path] [options]

Bridge a local Claude Code to the in-browser immediately.run host. Runs an MCP
server over stdio (add it to Claude Code with 'claude mcp add') plus the
authenticated localhost bridge the in-browser host connects out to. Keep this
process running while the agent session is open.

Arguments:
  repo-path                 Path to the project directory (default: cwd)

Options:
  --port <n>                Bridge port to listen on (127.0.0.1 only; default: 7700)
  --origin <url>            Allowed browser origin and pairing base
                            (default: https://immediately.run). Only
                            immediately.run, loopback, and preview origins are
                            accepted without --origin-unsafe.
  --origin-unsafe           Allow an --origin outside the recognized set
                            (the per-session token still gates every request)
  --timeout <ms>            Per-call wait for the browser host (default: ${DEFAULT_CALL_TIMEOUT_MS})
  -h, --help                Show this help`;

// The pairing locator rides the URL fragment (never sent to any server), exactly
// like the dev deep link — the in-browser Agent panel parses ir-endpoint/ir-token
// out of the hash (site-main localLocator). The path names the agent surface.
export const buildAgentDeepLink = (origin: string, port: number, token: string): string =>
  `${origin.replace(/\/+$/, '')}/agent` +
  `#ir-endpoint=${encodeURIComponent(`http://127.0.0.1:${port}`)}&ir-token=${encodeURIComponent(token)}`;

export const runAgent = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(AGENT_USAGE);
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
  // LD-3: refuse an unrecognized --origin unless --origin-unsafe is also given.
  if (!isRecognizedOrigin(origin) && args.flags['origin-unsafe'] !== true) {
    throw new Error(
      `Refusing --origin ${origin}: not a recognized immediately.run, loopback, or ` +
        `preview origin. Re-run with --origin-unsafe to allow it (the per-session ` +
        `token still gates every request).`,
    );
  }
  const timeoutFlag = flagValue(args.flags, 'timeout');
  const timeoutMs = timeoutFlag === undefined ? DEFAULT_CALL_TIMEOUT_MS : Number(timeoutFlag);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout: ${timeoutFlag}`);
  }

  // Per-session token — any local page can reach 127.0.0.1, so every bridge
  // request must present it (spec §8). Identical posture to `dev`.
  const token = randomBytes(24).toString('base64url');
  const bridge = new AgentBridge(timeoutMs);

  const handle = await startDevServer({ root, origin, token, port, bridge });
  const endpoint = `http://127.0.0.1:${handle.port}`;
  const projectName = sanitizeProjectName(basename(root));
  const namespace = `${projectName}-${identityHash8(root)}`;
  const url = buildAgentDeepLink(origin, handle.port, token);

  // stdout is the MCP JSON-RPC channel; everything human-facing → stderr.
  console.error(`immediately.run agent bridge on ${endpoint} (namespace ${namespace}).`);
  console.error(`Open this in your browser to pair the in-browser host:`);
  console.error(`  ${url}`);
  console.error(`Allowed origin: ${origin}. Press Ctrl-C to stop.`);

  // Drive the MCP server over this process's stdio (Claude Code spawns us).
  const stopMcp = runMcpStdio(bridge);

  // R3-422: same graceful-shutdown path as `dev` — destroy live SSE
  // connections, bounded grace period, force-exit on a wedge or second signal.
  return await runUntilShutdown(handle, { onShutdown: stopMcp });
};
