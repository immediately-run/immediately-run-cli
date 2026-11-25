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
 *    a ref deletion are forced off the same way (D-GS-10), and every ref
 *    outside `refs/heads/` is hidden from receive-pack, so a push can neither
 *    create, move nor delete a tag.
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
  // A push may only touch branches. git's two deny settings below apply to
  // refs/heads/ alone, so without this a tag (or any other ref) could be
  // force-moved and deleted. Hiding every ref but refs/heads/ from
  // receive-pack makes it refuse any update outside them (R-GS-14, R-GS-19).
  ['receive.hideRefs', 'refs/'],
  ['receive.hideRefs', '!refs/heads/'],
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

/** The only variables the child takes from this process's environment: what
 *  git needs to find its binaries, home, temp space and locale. Everything else
 *  — a CGI meta-variable (`CONTENT_LENGTH`, `PATH_INFO`, …) above all — would
 *  be read by `http-backend` as if the request had sent it. */
const INHERITED_ENV = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'USER', 'LOGNAME',
  // Windows, where names are case-insensitive (`Path`, `SystemRoot`): matched uppercased there.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
]);

/** The whole environment of the `git http-backend` child. Built, never copied
 *  from the request: every request-derived value here was parsed or checked,
 *  and of this process's own environment only `INHERITED_ENV` and `LC_*` pass. */
export const backendEnv = (
  req: BackendRequest,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const kept: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const name = platform === 'win32' ? k.toUpperCase() : k;
    if (INHERITED_ENV.has(name) || name.startsWith('LC_')) kept[k] = v;
  }
  const env = gitEnv(kept); // adds git's own no-prompt, no-lock settings
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

/** How long a git request may sit with neither the client's upload nor the
 *  child's output moving before the child is killed and the connection cut.
 *  It is an idle bound, not a total one: a large pack keeps streaming past it. */
export const GIT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of the child's stderr is kept for the server's own log. */
const MAX_STDERR_TAIL_BYTES = 2 * 1024;

export interface RunBackendOptions {
  /** Default `GIT_IDLE_TIMEOUT_MS`; tests shorten it. */
  idleTimeoutMs?: number;
  /** The server's log. Receives the tail of the child's stderr when a request
   *  fails; that text never reaches the client. */
  log?: (line: string) => void;
}

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
  options: RunBackendOptions = {},
): void => {
  const child = spawn('git', ['http-backend'], {
    env: backendEnv(request),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let headDone = false;
  let pending = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  const logStderr = (): void => {
    const text = stderrTail.toString('utf8').trim();
    if (text !== '' && options.log !== undefined) {
      options.log(`git-serve: git http-backend (${request.route.repo}): ${text.replace(/\s+/g, ' ')}`);
    }
  };
  const refuse = (status: number, reason: string): void => {
    logStderr();
    if (headDone) {
      // The status is already sent; the server's refusal log never sees this.
      options.log?.(`git-serve: cut (${reason}) ${request.method} /${request.route.repo}${REPO_DIR_SUFFIX}`);
      if (!res.writableEnded) res.destroy();
      return;
    }
    headDone = true;
    fail(status, reason);
  };

  // The idle bound: reset by every chunk either way.
  const idleMs = options.idleTimeoutMs ?? GIT_IDLE_TIMEOUT_MS;
  let idle: NodeJS.Timeout | undefined;
  const touch = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => {
      // `git http-backend` writes its header block before the service reads a
      // byte, so a stall is past the status line: kill the child and cut the
      // connection (a stalled client gets no further answer).
      headDone = true;
      child.kill();
      options.log?.(`git-serve: cut (git-idle) ${request.method} /${request.route.repo}${REPO_DIR_SUFFIX}`);
      req.socket.destroy();
    }, idleMs);
  };
  touch();
  req.on('data', touch);

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, chunk]);
    if (stderrTail.length > MAX_STDERR_TAIL_BYTES) {
      stderrTail = stderrTail.subarray(stderrTail.length - MAX_STDERR_TAIL_BYTES);
    }
  });
  child.on('error', () => refuse(500, 'git-failed'));
  // A client that goes away mid-upload closes stdin; the child then exits.
  child.stdin.on('error', () => {});
  req.pipe(child.stdin);

  child.stdout.on('data', (chunk: Buffer) => {
    touch();
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
  child.on('close', (code) => {
    if (idle !== undefined) clearTimeout(idle);
    // A child that exits without a header block answered nothing.
    if (!headDone) refuse(500, 'git-failed');
    else if (code !== 0) logStderr();
  });
  res.on('close', () => {
    if (idle !== undefined) clearTimeout(idle);
    if (child.exitCode === null) child.kill();
  });
};
