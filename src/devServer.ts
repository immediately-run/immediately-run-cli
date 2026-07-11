/*
 * Localhost HTTP server behind `immediately.run dev` (LOCAL_DEVELOPMENT_SPEC
 * §6.3): serves a project's working tree to hosted immediately.run as the
 * readonly source of a `local` provider mount.
 *
 *   GET  /tree          → { ref: 'live', files: [{ path, size, type }] }
 *   GET  /blob?path=/x  → raw file bytes
 *   GET  /meta          → { gitRemote?, headSha?, defaultBranch? }  (best effort)
 *   GET  /watch         → SSE stream of { eventType, path }
 *   OPTIONS *           → CORS + Private Network Access preflight
 *
 * With an {@link DevServerOptions.bridge} attached (R3-76 /
 * LOCAL_DEV_AUTHED_SERVER_SPEC §2.1) the server additionally exposes the
 * authenticated agent-bridge endpoints — all behind the SAME guard chain:
 *
 *   GET  /agent/pending → SSE stream of { callId, tool, params } (host pulls)
 *   POST /agent/result  → { callId, result | error }            (host posts)
 *   POST /agent/catalog → grant-filtered catalog the host publishes
 *
 * Read-only by construction unless the bridge is attached (then only the three
 * routes above accept POST/SSE, never a relaxation of the guards). Security
 * (spec §8 / LOCAL_DEV_AUTHED_SERVER_SPEC §4): binds
 * 127.0.0.1 only, requires a per-session bearer token on every request
 * (`Authorization: Bearer …`, or `?token=` for EventSource, which cannot send
 * headers), enforces an Origin allowlist when the request carries an Origin
 * (browser requests always do; curl tests don't), and jails all paths to the
 * project root (resolveSafe, after dev-fs/src/plugin.ts).
 *
 * With a {@link DevServerOptions.bind} attached (Tier-1.5, §9.1) the server
 * instead serves HTTPS on the tailnet interface IP (never `0.0.0.0`) using the
 * supplied `tailscale cert`, and the Host-header pin matches the MagicDNS
 * hostname instead of loopback. Every other §8 guard (token, Origin, path jail,
 * read-only) is unchanged — the tailnet only swaps the network boundary.
 *
 * The SSE watcher uses fs.watch(root, { recursive: true }) — native on macOS
 * and Windows; on Linux recursive watch requires Node >= 20.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { watch as fsWatch, statSync, createReadStream, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import {
  defaultBranchOf,
  git,
  headCommitSha,
  isGitRepo,
  stripRemoteCredentials,
} from './git.js';
import type { AgentBridge } from './bridge.js';
import {
  type LlmUpstream,
  resolveUpstreamTarget,
  buildUpstreamHeaders,
  DEFAULT_LLM_BODY_BYTES,
  LLM_ROUTE_PREFIX,
} from './llmProxy.js';

export interface DevServerOptions {
  root: string; // absolute project root
  origin: string; // allowed browser Origin (and deep-link base)
  token: string; // per-session bearer token
  port: number; // 0 = ephemeral (tests)
  /** LD2-5 listing cap override (default {@link MAX_TREE_ENTRIES}); tests lower it. */
  maxTreeEntries?: number;
  /** LD2-5 single-blob cap override (default {@link MAX_BLOB_BYTES}); tests lower it. */
  maxBlobBytes?: number;
  /**
   * R3-76 / LOCAL_DEV_AUTHED_SERVER_SPEC §2.1. When present, the server exposes
   * the authenticated agent-bridge endpoints (`GET /agent/pending` SSE,
   * `POST /agent/result`, `POST /agent/catalog`) behind the *same* T25 hardening
   * — additive, not a relaxation of the read-only stance. Absent ⇒ the server
   * stays GET-only and read-only exactly as before.
   */
  bridge?: AgentBridge;
  /**
   * R3-77 / P3-75. When present, the server exposes the authenticated
   * `POST /llm/...` proxy route behind the *same* T25 guard chain, forwarding to
   * the SINGLE configured upstream (`llm.baseUrl`) with the user's key injected
   * server-side. Not an open relay — the target is pinned to that origin
   * (`resolveUpstreamTarget`). Reuses this server scaffold; it does not stand up
   * a second one. Absent means `/llm` does not exist and POST stays refused.
   */
  llm?: LlmUpstream;
  /**
   * Tier-1.5 tailnet binding (LOCAL_DEVELOPMENT_SPEC §9.1). Absent ⇒ loopback
   * (127.0.0.1, plain HTTP) exactly as before. Present ⇒ the server listens on
   * `address` (the tailnet interface IP — never `0.0.0.0`), serves HTTPS with the
   * supplied `cert`/`key`, and pins the Host header to `host` (the MagicDNS name)
   * instead of loopback. All other §8 guards are unchanged.
   */
  bind?: {
    host: string; // MagicDNS hostname — the Host-pin target (e.g. mac.tailxyz.ts.net)
    address: string; // tailnet interface IP to listen on (never 0.0.0.0)
    cert: string | Buffer;
    key: string | Buffer;
  };
}

/** `/agent/result` + `/agent/catalog` body cap — bridge payloads are small JSON;
 *  a stated bound must exist at this trust boundary (cf. LD2-5). */
export const MAX_BRIDGE_BODY_BYTES = 4 * 1024 * 1024;
/** Max entries retained in the `/debug` ring buffer (system-app devtools). */
export const DEBUG_RING_MAX = 2000;
/** Body cap for a `POST /debug` batch. */
export const MAX_DEBUG_BODY_BYTES = 4 * 1024 * 1024;

export interface DevServerHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export interface TreeFile {
  path: string; // repo-relative, leading slash, '/'-separated
  size: number;
  type: 'blob';
}

/** Provider-protocol version reported by `GET /health` (LOCAL_DEVELOPMENT_SPEC
 *  §6.3, A3). Additive-only bumps, so the host can detect version skew. */
export const DEV_PROTOCOL_VERSION = 1;

// Size bounds (LD2-5, §6.3): advisory trust-boundary caps — some stated bound
// must exist at this boundary even if a future flag raises them.
/** `/tree` listing cap — beyond it the server answers an explicit error naming
 *  the cap rather than silently truncating. */
export const MAX_TREE_ENTRIES = 50_000;
/** `/blob` single-file cap — beyond it the server answers 413. */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

/** `/watch` coalescing window (LD2-4, §6.3): buffer fs events at least this long
 *  before flushing, so a burst (npm install, branch switch) collapses to one
 *  batch with at most one gitignore subprocess. */
export const WATCH_COALESCE_MS = 50;

// --- path scoping (after dev-fs resolveSafe) --------------------------------

/** Map an app-rooted path (`/src/App.tsx`) to a real disk path under `root`,
 *  rejecting any path that escapes the project root. */
export const resolveSafe = (root: string, p: unknown): string => {
  if (typeof p !== 'string' || p.includes('\0')) {
    throw Object.assign(new Error('invalid path'), { code: 'EINVAL' });
  }
  const rel = p.replace(/^[\\/]+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error(`path escapes project root: ${p}`), { code: 'EACCES' });
  }
  return abs;
};

// --- working-tree listing ----------------------------------------------------

// `git ls-files -co --exclude-standard` lists the working tree (tracked +
// untracked) honoring .gitignore — unlike `ls-tree HEAD`, it sees uncommitted
// files, which are the whole point of `dev`. Non-git directories fall back to a
// plain walk that skips `.git` and `node_modules`.
const gitListFiles = (root: string): string[] =>
  git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);

const WALK_SKIP = new Set(['.git', 'node_modules']);

const walkFiles = (root: string, dir = '', out: string[] = []): string[] => {
  const entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (WALK_SKIP.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
};

// `cap` (LD2-5) stops collection one past the limit so the caller can detect an
// overflow and answer an explicit error instead of silently truncating.
export const listWorkingTreeFiles = (root: string, cap = MAX_TREE_ENTRIES): TreeFile[] => {
  const rels = isGitRepo(root) ? gitListFiles(root) : walkFiles(root);
  const files: TreeFile[] = [];
  for (const rel of new Set(rels)) {
    try {
      // statSync follows symlinks; isFile() drops directories/specials. A
      // listed-but-deleted tracked file fails stat and is skipped.
      const st = statSync(path.join(root, rel));
      if (!st.isFile()) continue;
      files.push({ path: '/' + rel.split(path.sep).join('/'), size: st.size, type: 'blob' });
      if (files.length > cap) break; // overflow sentinel: cap+1 entries → 413
    } catch {
      /* deleted since listing */
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return files;
};

// Is a repo-relative path gitignored? Used to filter /watch events for files
// that postdate the last /tree listing. exit 0 = ignored, exit 1 = not.
const isGitIgnored = (root: string, rel: string): boolean => {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
};

// LD2-4: the gitignore check for a WHOLE batch in a single `git check-ignore`
// subprocess (NUL-delimited stdin/stdout), so a burst of events costs O(1) git
// invocations regardless of event count — never one spawn per event. Returns the
// subset of `rels` that git ignores. Fail-open (empty) on any error: a stray
// gitignored path leaking onto /watch is informational (`/blob` still 404s it via
// the per-request `isHiddenPath`), and the watcher must never wedge.
const batchGitIgnored = (root: string, rels: readonly string[]): Set<string> => {
  if (rels.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      input: rels.join('\0') + '\0',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.toString('utf8').split('\0').filter(Boolean));
  } catch {
    // exit 1 = nothing ignored (no stdout); any other failure → fail-open.
    return new Set();
  }
};

// The cheap, subprocess-free half of `isHiddenPath`: VCS/dependency noise
// (`.git/`, `node_modules`). Safe to run per-event on the /watch hot path.
const isVcsNoise = (rel: string): boolean =>
  rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('node_modules');

// A repo-relative path the `/tree` filter hides — VCS/dependency noise (`.git/`,
// `node_modules`) plus anything `.gitignore`'d (`.env` the canonical example).
// `/blob` must 404 these (LD-5) and `/watch` must not emit them: a token-holder
// must not read through `/blob` what `/tree` omits. Single source for both paths.
const isHiddenPath = (root: string, rel: string, inGitRepo: boolean): boolean => {
  if (isVcsNoise(rel)) return true;
  if (inGitRepo && isGitIgnored(root, rel)) return true;
  return false;
};

// --- request guard -----------------------------------------------------------

const CORS_MAX_AGE = '600';

// LD-1 DNS-rebinding defense (LOCAL_DEVELOPMENT_SPEC §8). The server binds
// 127.0.0.1, so the only legitimate `Host` names a loopback host. A malicious
// page that rebinds its OWN DNS name to 127.0.0.1 reaches the socket but the
// browser sends `Host: attacker.example` — reject it before the Origin/token
// checks even run. Pinning the port to the accepting socket (`localPort`) also
// refuses a Host that names the right loopback but the wrong port.
//
// Under a §9.1 tailnet bind the legitimate Host is instead the MagicDNS name, so
// the caller passes that as `allowedHosts`; the rebinding defense is identical,
// only the pinned name changes (lowercased entries — comparison is case-insensitive).
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export const isAllowedHost = (
  hostHeader: string | undefined,
  localPort: number,
  allowedHosts: ReadonlySet<string> = LOOPBACK_HOSTS,
): boolean => {
  if (!hostHeader) return false; // HTTP/1.1 requires Host; a missing one is suspect.
  let host = hostHeader;
  let port: string | undefined;
  if (hostHeader.startsWith('[')) {
    // IPv6 literal: [::1] or [::1]:port
    const end = hostHeader.indexOf(']');
    if (end === -1) return false;
    host = hostHeader.slice(1, end);
    const rest = hostHeader.slice(end + 1);
    if (rest.startsWith(':')) port = rest.slice(1);
    else if (rest.length > 0) return false;
  } else {
    const colon = hostHeader.lastIndexOf(':');
    if (colon !== -1) {
      host = hostHeader.slice(0, colon);
      port = hostHeader.slice(colon + 1);
    }
  }
  if (!allowedHosts.has(host.toLowerCase())) return false;
  // A present port must match the accepting socket; absent port still pins host.
  if (port !== undefined && port !== String(localPort)) return false;
  return true;
};

const corsHeaders = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
});

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
};

// Read a capped JSON request body for the authenticated bridge POSTs. Rejects
// (resolves to a typed error) past the byte cap so a hostile body can't grow
// memory unbounded; the Host/Origin/token guard has already run.
const readJsonBody = (
  req: http.IncomingMessage,
  cap: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> =>
  new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        resolve({ ok: false, status: 413, error: `body exceeds the ${cap}-byte cap` });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({ ok: true, value: undefined });
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request stream error' }));
  });

// Read a capped RAW request body (bytes, not parsed) for the `/llm` proxy — the
// body is forwarded verbatim to the upstream, so it must not be re-serialized.
const readRawBody = (
  req: http.IncomingMessage,
  cap: number,
): Promise<{ ok: true; value: Buffer } | { ok: false; status: number; error: string }> =>
  new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        resolve({ ok: false, status: 413, error: `body exceeds the ${cap}-byte cap` });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ ok: true, value: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request stream error' }));
  });

// --- server -------------------------------------------------------------------

export const startDevServer = (opts: DevServerOptions): Promise<DevServerHandle> => {
  const root = path.resolve(opts.root);
  const inGitRepo = isGitRepo(root);
  const maxTreeEntries = opts.maxTreeEntries ?? MAX_TREE_ENTRIES;
  const maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_BYTES;

  // §9.1: under a tailnet bind the only legitimate Host is the MagicDNS name;
  // otherwise it's a loopback name. Same DNS-rebinding defense, different pin.
  const allowedHosts = opts.bind ? new Set([opts.bind.host.toLowerCase()]) : LOOPBACK_HOSTS;

  // System-app devtools (plan: docs/plans/system-app-devtools.md, the CLI
  // transport). A token-gated `/debug` sink + SSE so a HEADLESS agent (no
  // browser) can stream the entries the browser host already redacts and forwards
  // — `debug.log` lines and the redacted host↔app channel trace. POST appends a
  // batch and fans out to GET subscribers; the buffer is a bounded ring. The
  // server stores/relays VERBATIM what the host sends — redaction is the host's
  // job (done before the POST); this never reads the working tree, holds no
  // authority, and rides the SAME §8 token/Host/Origin guard as every route.
  const debugBuffer: Array<Record<string, unknown>> = [];
  const debugSubs = new Set<http.ServerResponse>();
  let debugSeq = 0;
  const debugIngest = (entries: unknown[]): number => {
    let n = 0;
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const e: Record<string, unknown> = { ...(raw as Record<string, unknown>), seq: ++debugSeq };
      debugBuffer.push(e);
      n++;
      const line = `data: ${JSON.stringify(e)}\n\n`;
      for (const sub of debugSubs) {
        try {
          sub.write(line);
        } catch {
          /* a broken subscriber is dropped on its own 'close' */
        }
      }
    }
    if (debugBuffer.length > DEBUG_RING_MAX) debugBuffer.splice(0, debugBuffer.length - DEBUG_RING_MAX);
    return n;
  };

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const requestOrigin = req.headers.origin;

    // LD-1: pin the Host to the bound name on the accepting port BEFORE anything
    // else (DNS-rebinding defense). Never echo CORS for a rejected host.
    if (!isAllowedHost(req.headers.host, req.socket.localPort ?? opts.port, allowedHosts)) {
      sendJson(res, 403, { error: 'host not allowed' });
      return;
    }

    // Origin allowlist: browser requests always carry Origin — it must match
    // exactly. Token-bearing curl/agent requests carry none and are admitted
    // (the token is the gate; never echo ACAO for a foreign origin).
    if (requestOrigin !== undefined && requestOrigin !== opts.origin) {
      sendJson(res, 403, { error: 'origin not allowed' });
      return;
    }
    const cors = requestOrigin === opts.origin ? corsHeaders(opts.origin) : {};

    // CORS + Private Network Access preflight (spec §8). Chrome preflights the
    // Authorization-carrying GETs and adds Access-Control-Request-Private-Network
    // for public→private fetches; answer both in one response. The bridge POSTs
    // (R3-76) send a JSON body, so advertise POST + Content-Type only when the
    // bridge is enabled — a read-only server stays strictly GET-only.
    // Any POST-accepting feature on, or the always-available `/debug` sink. A
    // browser cross-origin POST is preflighted, so its OPTIONS must advertise
    // POST + Content-Type or the forwarder's fetch is blocked (found in live
    // testing — the Node-fetch unit test isn't preflighted, so it missed this).
    const authedPost = !!opts.bridge || !!opts.llm || url.pathname === '/debug';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': authedPost ? 'GET, POST, OPTIONS' : 'GET, OPTIONS',
        'Access-Control-Allow-Headers': authedPost ? 'Authorization, Content-Type' : 'Authorization',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': CORS_MAX_AGE,
      });
      res.end();
      return;
    }

    // POST is admitted only for the authenticated bridge / llm routes, and only
    // when that feature is enabled. Everything else stays GET-only (read-only).
    const isBridgePost =
      req.method === 'POST' &&
      !!opts.bridge &&
      (url.pathname === '/agent/result' || url.pathname === '/agent/catalog');
    const isLlmPost =
      req.method === 'POST' &&
      !!opts.llm &&
      (url.pathname === LLM_ROUTE_PREFIX || url.pathname.startsWith(LLM_ROUTE_PREFIX + '/'));
    // System-app devtools: `POST /debug` ingests a batch of redacted entries.
    const isDebugPost = req.method === 'POST' && url.pathname === '/debug';
    if (req.method !== 'GET' && !isBridgePost && !isLlmPost && !isDebugPost) {
      sendJson(res, 405, { error: 'method not allowed' }, cors);
      return;
    }

    // Per-session token, on every request. Header for fetch; query for
    // EventSource (which cannot send headers).
    const bearer = req.headers.authorization;
    const tokenOk =
      bearer === `Bearer ${opts.token}` || url.searchParams.get('token') === opts.token;
    if (!tokenOk) {
      sendJson(res, 403, { error: 'missing or invalid token' }, cors);
      return;
    }

    // System-app devtools `/debug` (plan: docs/plans/system-app-devtools.md).
    // Sits BEHIND the Host → Origin → token guard like every other route.
    //   POST /debug  → the browser host appends a batch of already-redacted
    //                  entries ({ entries: [...] } or a bare array).
    //   GET  /debug  → SSE: replay the ring (optionally `?since=<seq>`) then
    //                  stream new entries (`?token=` for EventSource).
    if (url.pathname === '/debug') {
      if (req.method === 'POST') {
        void readJsonBody(req, MAX_DEBUG_BODY_BYTES).then((parsed) => {
          if (!parsed.ok) {
            sendJson(res, parsed.status, { error: parsed.error }, cors);
            return;
          }
          const v = parsed.value as unknown;
          const entries = Array.isArray(v)
            ? v
            : Array.isArray((v as { entries?: unknown })?.entries)
              ? (v as { entries: unknown[] }).entries
              : undefined;
          if (!entries) {
            sendJson(res, 400, { error: 'expected an entries array' }, cors);
            return;
          }
          const count = debugIngest(entries);
          sendJson(res, 200, { ok: true, count }, cors);
        });
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...cors,
        });
        res.write('retry: 1000\n\n');
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        for (const e of debugBuffer) {
          if (!since || (e.seq as number) > since) res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        debugSubs.add(res);
        const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000);
        req.on('close', () => {
          clearInterval(heartbeat);
          debugSubs.delete(res);
        });
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' }, cors);
      return;
    }

    // R3-76 authenticated bridge POSTs (LOCAL_DEV_AUTHED_SERVER_SPEC §2.1). These
    // sit BEHIND the Host → Origin → token guard above (so only the kernel
    // connects; a drive-by/opaque-origin `Origin: null` is already refused) and
    // relay to the in-memory bridge — additive, never a relaxation.
    if (isBridgePost && opts.bridge) {
      const bridge = opts.bridge;
      void readJsonBody(req, MAX_BRIDGE_BODY_BYTES).then((parsed) => {
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error }, cors);
          return;
        }
        if (url.pathname === '/agent/result') {
          // The browser host posts the gated invoke() outcome for a callId.
          const body = (parsed.value ?? {}) as { callId?: unknown; result?: unknown; error?: unknown };
          const payload =
            body.error !== undefined
              ? { error: body.error as { code: string; message: string } }
              : { result: body.result };
          const matched = bridge.resolveCall(body.callId, payload);
          if (!matched) {
            sendJson(res, 404, { error: 'unknown or expired callId' }, cors);
            return;
          }
          sendJson(res, 200, { ok: true }, cors);
          return;
        }
        // /agent/catalog — the host publishes its grant-filtered catalog; accept
        // either a bare array or { catalog: [...] }.
        const v = parsed.value as unknown;
        const entries = Array.isArray(v)
          ? v
          : Array.isArray((v as { catalog?: unknown })?.catalog)
            ? (v as { catalog: unknown[] }).catalog
            : undefined;
        if (!entries) {
          sendJson(res, 400, { error: 'expected a catalog array' }, cors);
          return;
        }
        bridge.setCatalog(entries as Parameters<AgentBridge['setCatalog']>[0]);
        sendJson(res, 200, { ok: true, count: entries.length }, cors);
      });
      return;
    }

    // R3-77 `/llm` proxy (LLM_AND_AGENTS_SPEC §2.4, D3). Sits BEHIND the same
    // Host → Origin → token guard as the bridge (so only the kernel connects).
    // Pins the target to the configured upstream (not an open relay), injects the
    // user's key server-side, and streams the response back. The key is never
    // read from, nor echoed to, the caller.
    if (isLlmPost && opts.llm) {
      const llm = opts.llm;
      const target = resolveUpstreamTarget(llm.baseUrl, url.pathname, url.search);
      if (!target.ok) {
        sendJson(res, 403, { error: target.reason }, cors);
        return;
      }
      const cap = llm.maxBodyBytes ?? DEFAULT_LLM_BODY_BYTES;
      void readRawBody(req, cap).then(async (parsed) => {
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error }, cors);
          return;
        }
        const headers = buildUpstreamHeaders(req.headers, llm);
        const doFetch = llm.fetchImpl ?? fetch;
        // R3-224 (§3.3 "abort the in-flight LLM request"): propagate a CALLER
        // disconnect to the upstream. When the host aborts its fetch to this proxy
        // (the app's stop button → cancel frame → `streamViaDevProxy` fetch abort),
        // this connection closes; tear the proxy→provider request down too so the
        // provider stops GENERATING and BILLING. Without this the client sees the
        // stream stop while the upstream runs the completion to the end and bills it.
        const upstreamAbort = new AbortController();
        const onCallerGone = (): void => {
          // Only abort a still-running stream — a normal end also emits 'close'.
          if (!res.writableFinished) upstreamAbort.abort();
        };
        res.on('close', onCallerGone);
        let upstream: Response;
        try {
          upstream = await doFetch(target.url, {
            method: 'POST',
            headers,
            body: parsed.value.length > 0 ? parsed.value : undefined,
            // Never chase a redirect to another origin with the key attached —
            // hand the 3xx back instead (keeps the pin; mirrors the bridge stance).
            redirect: 'manual',
            signal: upstreamAbort.signal,
          });
        } catch {
          // A caller-disconnect abort races the connect; don't write to a dead socket.
          if (!upstreamAbort.signal.aborted) sendJson(res, 502, { error: 'upstream unreachable' }, cors);
          return;
        }
        // Stream the upstream response straight back. Pass the content-type
        // through (SSE token streams included); strip nothing INTO the caller
        // except the upstream's own bytes — the injected auth was request-only.
        const out: Record<string, string> = { ...cors };
        const ct = upstream.headers.get('content-type');
        if (ct) out['Content-Type'] = ct;
        res.writeHead(upstream.status, out);
        if (upstream.body) {
          const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
          // If the caller vanishes mid-stream, destroy the source too so reading
          // stops and the upstream `signal` abort actually closes the connection.
          res.on('close', () => {
            if (!res.writableFinished) body.destroy();
          });
          body.pipe(res);
        } else {
          res.end();
        }
      });
      return;
    }

    try {
      switch (url.pathname) {
        case '/health': {
          // A3: token-gated liveness + provider-protocol version. The token check
          // above already gates this route; reaching here means a valid token.
          sendJson(res, 200, { ok: true, protocol: DEV_PROTOCOL_VERSION }, cors);
          return;
        }
        case '/tree': {
          // LD2-5: cap the listing. `listWorkingTreeFiles` returns cap+1 on
          // overflow → answer an explicit error naming the cap, never a silent
          // truncation that would hide files from the in-browser tree.
          const files = listWorkingTreeFiles(root, maxTreeEntries);
          if (files.length > maxTreeEntries) {
            sendJson(
              res,
              413,
              { error: `working tree exceeds the ${maxTreeEntries}-entry listing cap`, cap: maxTreeEntries },
              cors,
            );
            return;
          }
          sendJson(res, 200, { ref: 'live', files }, cors);
          return;
        }
        case '/blob': {
          const abs = resolveSafe(root, url.searchParams.get('path'));
          // LD-5: never serve a path `/tree` hides (`.gitignore`'d — e.g. `.env` —
          // plus `.git/`, `node_modules`). Answer the SAME 404 as an absent file so
          // a token-holder gets no existence oracle for hidden paths.
          const rel = path.relative(root, abs).split(path.sep).join('/');
          if (isHiddenPath(root, rel, inGitRepo)) {
            sendJson(res, 404, { error: 'not found' }, cors);
            return;
          }
          let st;
          try {
            st = statSync(abs); // existence + size + type in one syscall
          } catch {
            sendJson(res, 404, { error: 'not found' }, cors);
            return;
          }
          if (!st.isFile()) {
            sendJson(res, 404, { error: 'not found' }, cors);
            return;
          }
          // LD2-5: cap single-file size (413). Large-but-allowed blobs are STREAMED
          // (not buffered whole) so memory stays bounded regardless of file size.
          if (st.size > maxBlobBytes) {
            sendJson(
              res,
              413,
              { error: `blob exceeds the ${maxBlobBytes}-byte cap`, cap: maxBlobBytes, size: st.size },
              cors,
            );
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(st.size),
            ...cors,
          });
          const stream = createReadStream(abs);
          stream.on('error', () => res.destroy()); // existence was checked; rare
          stream.pipe(res);
          return;
        }
        case '/meta': {
          const meta: { gitRemote?: string; headSha?: string; defaultBranch?: string } = {};
          if (inGitRepo) {
            // LD2-2: credential-strip before it leaves loopback — a remote may
            // embed a token in its userinfo; the raw string never crosses.
            try { meta.gitRemote = stripRemoteCredentials(git(root, ['remote', 'get-url', 'origin'])); } catch { /* no remote */ }
            try { meta.headSha = headCommitSha(root); } catch { /* unborn HEAD */ }
            try { meta.defaultBranch = defaultBranchOf(root, 'main'); } catch { /* best effort */ }
          }
          sendJson(res, 200, meta, cors);
          return;
        }
        case '/agent/pending': {
          // R3-76: the browser host kernel connects OUT here and pulls queued
          // tool calls as SSE. Token + Host + Origin already checked above, so
          // only the kernel reaches this stream. 404 unless the bridge is on.
          if (!opts.bridge) {
            sendJson(res, 404, { error: 'not found' }, cors);
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...cors,
          });
          res.write('retry: 1000\n\n');
          const unsubscribe = opts.bridge.subscribe((call) => {
            res.write(`data: ${JSON.stringify(call)}\n\n`);
          });
          const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000);
          req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
          });
          return;
        }
        case '/watch': {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...cors,
          });
          res.write('retry: 1000\n\n');
          // LD2-4: coalesce bursts. Buffer events (rel → latest eventType) and
          // flush on a ≥WATCH_COALESCE_MS timer; the cheap VCS-noise filter runs
          // per event (no subprocess), but the gitignore check runs at most ONCE
          // per batch (a single `git check-ignore`), bounding subprocess spawns to
          // O(1) per window regardless of how many events the burst delivered.
          const pending = new Map<string, string>();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const flush = () => {
            timer = undefined;
            if (pending.size === 0) return;
            const batch = [...pending];
            pending.clear();
            const rels = batch.map(([rel]) => rel);
            const ignored = inGitRepo ? batchGitIgnored(root, rels) : new Set<string>();
            for (const [rel, eventType] of batch) {
              if (ignored.has(rel)) continue;
              res.write(`data: ${JSON.stringify({ eventType, path: `/${rel}` })}\n\n`);
            }
          };
          const watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const rel = String(filename).split(path.sep).join('/');
            // Cheap, subprocess-free drop of VCS/dependency noise on the hot path;
            // the gitignore check is deferred to the once-per-batch flush.
            if (isVcsNoise(rel)) return;
            pending.set(rel, eventType); // last write per path wins
            if (!timer) timer = setTimeout(flush, WATCH_COALESCE_MS);
          });
          const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000);
          req.on('close', () => {
            clearInterval(heartbeat);
            if (timer) clearTimeout(timer);
            watcher.close();
          });
          return;
        }
        default:
          sendJson(res, 404, { error: 'not found' }, cors);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EINVAL') {
        sendJson(res, 403, { error: 'forbidden path' }, cors);
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }, cors);
    }
  };

  // §9.1: HTTPS over the tailnet interface when bound; loopback HTTP otherwise.
  const server: http.Server = opts.bind
    ? https.createServer({ cert: opts.bind.cert, key: opts.bind.key }, handler)
    : http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only (spec §8) unless a §9.1 tailnet bind is requested, in which
    // case the tailnet interface IP — never 0.0.0.0, never reachable off-tailnet.
    server.listen(opts.port, opts.bind ? opts.bind.address : '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res2, rej2) => server.close((e) => (e ? rej2(e) : res2()))),
      });
    });
  });
};
