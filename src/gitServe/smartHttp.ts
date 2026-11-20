/*
 * git's own HTTP protocol for stock git clients (GIT_SERVE_SPEC §7, R-GS-14,
 * R-GS-15, R-GS-17), so `git clone` and `git push` work against the same server.
 *
 * `git http-backend` speaks the protocol. What is SERVED is decided here, not
 * by it. On its own it serves nested paths, symlinked repositories, names
 * without the `.git` suffix and the dumb-HTTP file routes, and it enables push
 * whenever a repository's own config says so. So:
 *
 *  - This file parses the request path itself and admits exactly four shapes.
 *    Everything else under a repository is 404 and never reaches the child.
 *  - The child's `PATH_INFO` and `QUERY_STRING` are rebuilt from the parsed
 *    parts. The request path is never passed on.
 *  - The repository name goes through the same rule as every other route
 *    (R-GS-6): no symlink, no nesting, no borrowed objects.
 *  - Push is decided by the `--allow-push` flag alone. `http.receivepack` is
 *    forced through the environment on every request, and environment config
 *    outranks the repository's own. With the flag, a non-fast-forward push and
 *    a ref deletion are forced off the same way (D-GS-10).
 *
 * A browser cannot use these routes: a request that carries `Origin` or any
 * `Sec-Fetch-*` header is refused before anything else, and no CORS header is
 * ever sent. The caller is identified by the tailnet peer gate, not by a token.
 */

import { spawn } from 'node:child_process';
import type * as http from 'node:http';

import { gitEnv } from './runGit.js';
import { REPO_DIR_SUFFIX, isRepoName, resolveRepo } from './repoName.js';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitRoute {
  repo: string;
  service: GitService;
  /** `advertise`: GET …/info/refs?service=…   `rpc`: POST …/<service> */
  phase: 'advertise' | 'rpc';
}

const SERVICES: readonly GitService[] = ['git-upload-pack', 'git-receive-pack'];
const isService = (v: string): v is GitService => (SERVICES as readonly string[]).includes(v);

/**
 * The four served shapes, matched against the RAW path and query of the request
 * line (no percent-decoding, no dot-segment folding: an encoded slash or a
 * trailing dot simply does not match).
 *
 *   /<repo>.git/info/refs?service=git-upload-pack
 *   /<repo>.git/info/refs?service=git-receive-pack
 *   /<repo>.git/git-upload-pack
 *   /<repo>.git/git-receive-pack
 */
export const matchGitRoute = (pathname: string, search: string): GitRoute | null => {
  const m = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return null;
  const repo = m[1]!;
  const tail = m[2]!;
  if (!isRepoName(repo)) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (tail === 'info/refs') {
    // Exactly one parameter, spelled exactly. Without it this would be the
    // dumb-HTTP ref listing, which is not served.
    const sm = /^service=(git-upload-pack|git-receive-pack)$/.exec(query);
    return sm ? { repo, service: sm[1] as GitService, phase: 'advertise' } : null;
  }
  if (query !== '' || !isService(tail)) return null;
  return { repo, service: tail, phase: 'rpc' };
};

/** True when a request carries a header only a browser sends (R-GS-15). */
export const hasBrowserHeaders = (headers: http.IncomingHttpHeaders): boolean =>
  Object.keys(headers).some((name) => name === 'origin' || name.startsWith('sec-fetch-'));

const GIT_PROTOCOL_RE = /^[a-z0-9=:.-]{1,64}$/;
const CONTENT_ENCODINGS = new Set(['gzip', 'x-gzip']);

/** git config forced for one request. Environment config (`GIT_CONFIG_COUNT`)
 *  outranks the repository's own file, so a repository cannot widen its access. */
export const forcedConfig = (allowPush: boolean): Array<[string, string]> => [
  ['http.uploadpack', 'true'],
  ['http.receivepack', allowPush ? 'true' : 'false'],
  // The dumb protocol's file routes are not routed here; this is the same
  // decision stated to the child as well.
  ['http.getanyfile', 'false'],
  ...(allowPush
    ? ([
        ['receive.denyNonFastForwards', 'true'],
        ['receive.denyDeletes', 'true'],
      ] as Array<[string, string]>)
    : []),
];

export interface BackendRequest {
  root: string;
  route: GitRoute;
  method: 'GET' | 'POST';
  allowPush: boolean;
  /** The peer's address and Tailscale login, from the peer gate. */
  remoteAddress: string;
  remoteUser: string;
  contentType?: string;
  contentEncoding?: string;
  contentLength?: string;
  gitProtocol?: string;
}

/** The whole environment of the `git http-backend` child. Built, never copied
 *  from the request: every request-derived value here was parsed or checked. */
export const backendEnv = (req: BackendRequest): NodeJS.ProcessEnv => {
  const env = gitEnv(); // drops every inherited GIT_* variable
  const suffix = req.route.phase === 'advertise' ? 'info/refs' : req.route.service;
  env.GIT_PROJECT_ROOT = req.root;
  env.GIT_HTTP_EXPORT_ALL = '1';
  env.PATH_INFO = `/${req.route.repo}${REPO_DIR_SUFFIX}/${suffix}`;
  env.QUERY_STRING = req.route.phase === 'advertise' ? `service=${req.route.service}` : '';
  env.REQUEST_METHOD = req.method;
  env.GATEWAY_INTERFACE = 'CGI/1.1';
  env.REMOTE_ADDR = req.remoteAddress;
  env.REMOTE_USER = req.remoteUser;
  if (req.contentType !== undefined) env.CONTENT_TYPE = req.contentType;
  if (req.contentEncoding !== undefined) env.HTTP_CONTENT_ENCODING = req.contentEncoding;
  if (req.contentLength !== undefined) env.CONTENT_LENGTH = req.contentLength;
  if (req.gitProtocol !== undefined) env.GIT_PROTOCOL = req.gitProtocol;
  const config = forcedConfig(req.allowPush);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
};

/** The headers of a CGI answer this server passes on. No CORS header is among them. */
const PASSED_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'expires',
  'pragma',
  'date',
  'last-modified',
]);

/** Splits a CGI header block: the status (200 when the child names none, as CGI
 *  defines) and the headers to pass on. Null when the block cannot be read. */
export const parseCgiHead = (
  block: string,
): { status: number; headers: Record<string, string> } | null => {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') {
      const code = Number(/^(\d{3})\b/.exec(value)?.[1]);
      if (!Number.isInteger(code) || code < 200 || code > 599) return null;
      status = code;
    } else if (PASSED_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return { status, headers };
};

export type GitRefusal = { status: number; reason: string };

/**
 * Checks one git-class request and names the child's inputs, or the refusal.
 * `rawPath` and `rawSearch` are the request line's own, undecoded.
 */
export const planGitRequest = (
  rawPath: string,
  rawSearch: string,
  method: string | undefined,
  headers: http.IncomingHttpHeaders,
  ctx: { root: string; allowPush: boolean; remoteAddress: string; remoteUser: string },
): { ok: true; request: BackendRequest } | ({ ok: false } & GitRefusal) => {
  const route = matchGitRoute(rawPath, rawSearch);
  if (route === null) return { ok: false, status: 404, reason: 'not-found' };
  const wanted = route.phase === 'advertise' ? 'GET' : 'POST';
  if (method !== wanted) return { ok: false, status: 404, reason: 'not-found' };
  // R-GS-6, the same rule as every other route. Nothing is created by pushing
  // to a name that does not exist.
  if (!resolveRepo(ctx.root, route.repo).ok) return { ok: false, status: 404, reason: 'not-found' };

  const request: BackendRequest = {
    root: ctx.root,
    route,
    method: wanted,
    allowPush: ctx.allowPush,
    remoteAddress: ctx.remoteAddress,
    remoteUser: ctx.remoteUser,
  };
  if (route.phase === 'rpc') {
    // The one media type each service takes; anything else is not a git client.
    if (headers['content-type'] !== `application/x-${route.service}-request`) {
      return { ok: false, status: 415, reason: 'content-type' };
    }
    request.contentType = headers['content-type'];
    const encoding = headers['content-encoding'];
    if (encoding !== undefined) {
      if (!CONTENT_ENCODINGS.has(encoding)) return { ok: false, status: 415, reason: 'content-encoding' };
      request.contentEncoding = encoding;
    }
    const length = headers['content-length'];
    if (length !== undefined) {
      if (!/^\d{1,15}$/.test(length)) return { ok: false, status: 400, reason: 'malformed' };
      request.contentLength = length;
    }
  }
  const gitProtocol = headers['git-protocol'];
  if (typeof gitProtocol === 'string' && GIT_PROTOCOL_RE.test(gitProtocol)) {
    request.gitProtocol = gitProtocol;
  }
  return { ok: true, request };
};

/** How much of a child's output may arrive before its header block ends. */
const MAX_CGI_HEAD_BYTES = 16 * 1024;

/**
 * Runs `git http-backend` for a planned request and streams both ways. The
 * request body is piped in without a size limit of this server's own (a pack
 * can be large); the child's body is piped out after its header block.
 */
export const runBackend = (
  request: BackendRequest,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  fail: (status: number, reason: string) => void,
): void => {
  const child = spawn('git', ['http-backend'], {
    env: backendEnv(request),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let headDone = false;
  let pending = Buffer.alloc(0);
  const refuse = (status: number, reason: string): void => {
    if (headDone) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    headDone = true;
    fail(status, reason);
  };

  child.on('error', () => refuse(500, 'git-failed'));
  // A client that goes away mid-upload closes stdin; the child then exits.
  child.stdin.on('error', () => {});
  req.pipe(child.stdin);

  child.stdout.on('data', (chunk: Buffer) => {
    if (headDone) return; // piped from here on
    pending = Buffer.concat([pending, chunk]);
    // The header block ends at the first empty line.
    let end = pending.indexOf('\r\n\r\n');
    let gap = 4;
    const bare = pending.indexOf('\n\n');
    if (end === -1 || (bare !== -1 && bare < end)) {
      end = bare;
      gap = 2;
    }
    if (end === -1) {
      if (pending.length > MAX_CGI_HEAD_BYTES) {
        child.kill();
        refuse(500, 'git-failed');
      }
      return;
    }
    const head = parseCgiHead(pending.subarray(0, end).toString('latin1'));
    if (head === null) {
      child.kill();
      refuse(500, 'git-failed');
      return;
    }
    headDone = true;
    res.writeHead(head.status, head.headers);
    const rest = pending.subarray(end + gap);
    if (rest.length > 0) res.write(rest);
    child.stdout.pipe(res);
  });
  child.on('close', () => {
    // A child that exits without a header block answered nothing.
    if (!headDone) refuse(500, 'git-failed');
  });
  res.on('close', () => {
    if (child.exitCode === null) child.kill();
  });
};
