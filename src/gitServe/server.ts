/*
 * The HTTP server behind `immediately-run git-serve` (GIT_SERVE_SPEC §4, §9,
 * §10). It only wires: the guards decide who is served (`guards.ts`,
 * `peerGate.ts`), the read routes decide what is answered (`readRoutes.ts`),
 * the pairing and connection stores hold the credentials, and this file moves
 * bytes.
 *
 * Two binds:
 *
 *   loopback  127.0.0.1, plain HTTP. One session credential minted per start.
 *             No peer gate (there is no tailnet), no `/pair`, no git routes.
 *   tailnet   the node's tailnet address, HTTPS. Every request passes the peer
 *             gate. Credentials are per-browser connections minted by `/pair`.
 *             Stock git clients clone (and, with `allowPush`, push) through the
 *             smart-HTTP routes (`smartHttp.ts`).
 *
 * It reads committed objects only; there is no working tree and no stream route.
 * Its one write is `POST /commit` (`commit.ts`), behind `--allow-commit` and the
 * `write` scope, both checked on every request (R-GS-23).
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { realpathSync } from 'node:fs';

import { LOOPBACK_HOSTS, admittedOrigins } from '../devServer.js';
import { connectionLookup, type ConnectionScope } from './connections.js';
import {
  MAX_COMMIT_BODY_BYTES,
  applyCommit,
  parseCommitRequest,
  type CommitIdentity,
  type CommitRefusal,
} from './commit.js';
import { LOOPBACK_ROUTES, TAILNET_ROUTES, admit, authorize, sameSecret } from './guards.js';
import { gitServeNamespace } from './namespace.js';
import { exchangePairingCodeAsync } from './pairing.js';
import { checkPeer, type PeerGateConfig } from './peerGate.js';
import { GIT_SERVE_PROTOCOL, GIT_SERVE_SERVER, type RunGit } from './protocol.js';
import { answerRead, type ReadAnswer } from './readRoutes.js';
import { runGit as realRunGit, spawnGit } from './runGit.js';
import { hasBrowserHeaders, planGitRequest, runBackend } from './smartHttp.js';
import { resolveRepo } from './repoName.js';
import { loadInstanceId } from './state.js';

/** How long a connection whose answer went out before its body was read stays
 *  half-open for that answer to be read. */
export const UNREAD_BODY_GRACE_MS = 2000;

export interface TailnetBinding {
  /** The MagicDNS name: the Host pin, and the origin the namespace is bound to. */
  host: string;
  /** The address to listen on: the node's IPv4 tailnet address, never 0.0.0.0. */
  address: string;
  /** The `tailscale cert` pair. Absent only when a test starts the server on
   *  loopback through this entry; the command always supplies both. */
  cert?: string | Buffer;
  key?: string | Buffer;
  /** Who is served (R-GS-16). */
  peerGate: PeerGateConfig;
}

export interface GitServeOptions {
  /** The directory of bare repositories. */
  root: string;
  /** The allowed browser origin (and deep-link base); its mediator is admitted with it. */
  origin: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Loopback bind: the session credential, 256 random bits minted per start. */
  token?: string;
  /** Tailnet bind. Exactly one of `token` and `tailnet` is given. */
  tailnet?: TailnetBinding;
  /** `--allow-push`: git clients may push (fast-forward only, no deletes). It is
   *  the only thing that turns push on; a repository's own config cannot. */
  allowPush?: boolean;
  /** `--allow-commit`: `POST /commit` is served to a connection that holds the
   *  `write` scope. On loopback the session credential holds `write` exactly
   *  when this is set. Requires `identity`. */
  allowCommit?: boolean;
  /** The author and committer of every browser commit (R-GS-22). */
  identity?: CommitIdentity;
  /** The git routes' idle bound (default `GIT_IDLE_TIMEOUT_MS`); tests shorten it. */
  gitIdleTimeoutMs?: number;
  /** Tests inject a `runGit` to move a ref between two of the server's own git calls. */
  runGit?: RunGit;
  /** Where refusals are logged (default: stderr). Never receives a credential. */
  log?: (line: string) => void;
  /** The clock the pairing exchange reads (tests). */
  now?: () => number;
}

export interface GitServeHandle {
  server: http.Server | https.Server;
  port: number;
  /** The root's instance id, as `/meta` reports it. */
  instanceId: string;
  /** The root as served: absolute, symlinks resolved. */
  root: string;
  /** The origin a browser reaches the server at. */
  endpoint: string;
  /** The namespace of every mount from this server (R-GS-8). */
  namespace: string;
  close(): Promise<void>;
}

/** Who a request is, once its credential checked out. */
interface Caller {
  connectionId: string;
  scope: ConnectionScope;
}

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
};

const sendRefusal = (
  res: http.ServerResponse,
  status: number,
  reason: string,
  cors: Record<string, string>,
): void =>
  sendJson(res, status, { server: GIT_SERVE_SERVER, protocol: GIT_SERVE_PROTOCOL, reason }, cors);

/** Reads a request body, counting bytes as they arrive. Resolves null once the
 *  count passes `limit`; the rest of the body is then discarded, not buffered. */
const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });

const sendBlob = (
  res: http.ServerResponse,
  answer: Extract<ReadAnswer, { kind: 'blob' }>,
  cors: Record<string, string>,
): void => {
  // No caching header: the host keeps its own verified blob cache, and the
  // spec's review dropped a browser-cache header for these bytes.
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
  };
  const child = spawnGit(answer.repoDir, ['cat-file', 'blob', answer.sha]);
  let started = false;
  const fail = (): void => {
    if (!started) {
      started = true;
      sendRefusal(res, 500, 'git-failed', cors);
    } else if (!res.writableEnded) {
      // Headers are gone; a cut connection is the only honest signal left. The
      // host checks the blob's SHA, so a short body can never read as the file.
      res.destroy();
    }
  };
  child.on('error', fail);
  // The status line waits for the first byte, so a git that fails before
  // writing anything still gets a 500 and not an empty 200.
  child.stdout.once('data', (first: Buffer) => {
    if (started) return;
    started = true;
    res.writeHead(200, headers);
    res.write(first);
    child.stdout.pipe(res);
  });
  child.on('close', (code) => {
    if (code !== 0) {
      fail();
    } else if (!started) {
      // An empty blob: git wrote nothing and exited cleanly.
      started = true;
      res.writeHead(200, headers);
      res.end();
    }
  });
  res.on('close', () => {
    if (child.exitCode === null) child.kill();
  });
};

export const startGitServe = (opts: GitServeOptions): Promise<GitServeHandle> => {
  if ((opts.token === undefined) === (opts.tailnet === undefined)) {
    throw new Error('startGitServe takes exactly one of `token` (loopback) and `tailnet`.');
  }
  const allowCommit = opts.allowCommit === true;
  const identity = opts.identity;
  if (allowCommit && identity === undefined) {
    throw new Error('allowCommit needs the identity that browser commits are written under.');
  }
  // HTTPS on the tailnet address (R-GS-9): a binding without the certificate
  // pair may only listen on loopback, which is how the tests drive this entry.
  const t = opts.tailnet;
  if (t !== undefined && (t.cert === undefined || t.key === undefined) && t.address !== '127.0.0.1') {
    throw new Error(`startGitServe: a tailnet binding on ${t.address} needs its certificate and key.`);
  }
  const root = realpathSync(opts.root);
  const instanceId = loadInstanceId(root);
  const runGit = opts.runGit ?? realRunGit;
  const log = opts.log ?? ((line: string) => console.error(line));
  /** Responses streamed from `git http-backend` (see `handler`). */
  const piped = new WeakSet<http.ServerResponse>();
  const now = opts.now ?? (() => Date.now());
  const origins = admittedOrigins(opts.origin);
  const tailnet = opts.tailnet;
  const allowedHosts = tailnet ? new Set([tailnet.host.toLowerCase()]) : LOOPBACK_HOSTS;
  const routes = tailnet ? TAILNET_ROUTES : LOOPBACK_ROUTES;
  // Set once the port is known; the handler runs only after that.
  let namespace = '';

  // Who a bearer value is. Loopback has the one session credential; a tailnet
  // server looks the value up among its connections on every request, so a
  // revoked one fails at once.
  const connections = tailnet ? connectionLookup(root) : null;
  const sessionSecret = opts.token;
  const callerOf = (bearer: string): Caller | null => {
    if (connections !== null) {
      const record = connections.find(bearer);
      return record === null ? null : { connectionId: record.id, scope: record.scope };
    }
    // On loopback there are no connections: the session credential carries
    // `write` exactly when the server was started with --allow-commit (R-GS-23).
    return sessionSecret !== undefined && sameSecret(bearer, sessionSecret)
      ? { connectionId: 'loopback', scope: allowCommit ? 'write' : 'read' }
      : null;
  };

  const serve = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // A request target the URL parser refuses (`//`, for one) is a 400, never a throw.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      log(`git-serve: refused (malformed) request target from ${req.socket.remoteAddress ?? 'unknown'}`);
      sendRefusal(res, 400, 'malformed', {});
      return;
    }
    const refuse = (status: number, reason: string, cors: Record<string, string>): void => {
      log(
        `git-serve: refused (${reason}) ${req.method ?? '?'} ${url.pathname} ` +
          `from ${req.socket.remoteAddress ?? 'unknown'}`,
      );
      sendRefusal(res, status, reason, cors);
    };

    // 1. Host, the path's class, and (browser class) the Origin.
    const admission = admit({
      pathname: url.pathname,
      host: req.headers.host,
      origin: req.headers.origin,
      localPort: req.socket.localPort ?? opts.port,
      allowedHosts,
      origins,
      routes,
      gitClass: tailnet !== undefined,
    });
    if (admission.kind === 'refuse') {
      refuse(admission.status, admission.reason, admission.cors);
      return;
    }

    // A browser cannot use the git-client routes (R-GS-15): a request there
    // that carries `Origin` or any `Sec-Fetch-*` header is refused before
    // anything else, the peer gate included.
    if (admission.kind === 'git' && hasBrowserHeaders(req.headers)) {
      refuse(403, 'browser', {});
      return;
    }

    // 2. On a tailnet, the peer gate: every request of both classes, before any
    //    credential is looked at. A valid credential never stands in for it.
    let peerLogin = '';
    if (tailnet !== undefined) {
      const peer = await checkPeer(req.socket.remoteAddress, tailnet.peerGate);
      if (!peer.ok) {
        // A connection with no remote address is answered as an unknown peer:
        // §10.2 names five reasons, and the distinction is kept in the log.
        if (peer.reason === 'no-address') log('git-serve: refused a connection with no remote address');
        const reason = peer.reason === 'no-address' ? 'unknown-peer' : peer.reason;
        refuse(403, reason, admission.kind === 'browser' ? admission.cors : {});
        return;
      }
      peerLogin = peer.login;
    }

    // The git-client class: no token, no CORS, no OPTIONS. The peer gate above
    // is its whole gate; what is served is decided by `planGitRequest`.
    if (admission.kind === 'git') {
      // The request line as sent: the route match reads it undecoded.
      const target = req.url ?? '/';
      const mark = target.indexOf('?');
      const planned = planGitRequest(
        mark === -1 ? target : target.slice(0, mark),
        mark === -1 ? '' : target.slice(mark),
        req.method,
        req.headers,
        {
          root,
          allowPush: opts.allowPush === true,
          remoteAddress: req.socket.remoteAddress ?? '',
          remoteUser: peerLogin,
        },
      );
      if (!planned.ok) {
        refuse(planned.status, planned.reason, {});
        return;
      }
      piped.add(res);
      runBackend(planned.request, req, res, (status, reason) => refuse(status, reason, {}), {
        idleTimeoutMs: opts.gitIdleTimeoutMs,
        log,
      });
      return;
    }

    // 3. Browser class: preflight, method, and the bearer value.
    const authorization = authorize(admission, req.method, req.headers.authorization);
    if (authorization.kind === 'preflight') {
      res.writeHead(204, authorization.headers);
      res.end();
      return;
    }
    if (authorization.kind === 'refuse') {
      // On `/pair` the bearer value is the code, so an absent or unreadable one
      // is an absent code (R-GS-24), not a token refusal.
      const reason =
        url.pathname === '/pair' && authorization.reason === 'token' ? 'code' : authorization.reason;
      refuse(authorization.status, reason, authorization.cors);
      return;
    }
    const { cors, bearer } = authorization;

    // `/pair`: the bearer value is the pairing code, and a valid peer is still
    // not enough without it.
    if (url.pathname === '/pair') {
      req.resume(); // the route reads no body
      const paired = await exchangePairingCodeAsync(root, bearer, now());
      if (!paired.ok) {
        refuse(401, 'code', cors);
        return;
      }
      log(`git-serve: paired connection ${paired.record.id} (${paired.record.scope})`);
      sendJson(
        res,
        200,
        {
          server: GIT_SERVE_SERVER,
          protocol: GIT_SERVE_PROTOCOL,
          connectionId: paired.record.id,
          token: paired.token,
          scope: paired.record.scope,
          namespace,
        },
        cors,
      );
      return;
    }

    // Every other browser route needs a live credential.
    const caller = callerOf(bearer);
    if (caller === null) {
      refuse(401, 'token', cors);
      return;
    }

    if (url.pathname === '/commit') {
      // R-GS-23: two gates, both checked on every request. Neither stands in
      // for the other, and the mediator relaying the route is not a gate.
      if (!allowCommit || identity === undefined) {
        req.resume();
        refuse(403, 'commit-disabled', cors);
        return;
      }
      if (caller.scope !== 'write') {
        req.resume();
        refuse(403, 'scope', cors);
        return;
      }
      const raw = await readBody(req, MAX_COMMIT_BODY_BYTES);
      if (raw === null) {
        refuse(413, 'too-large', cors);
        return;
      }
      const sendCommitRefusal = (refusal: CommitRefusal): void => {
        const { status, ...rest } = refusal;
        log(`git-serve: refused (${refusal.reason}) POST /commit by connection ${caller.connectionId}`);
        sendJson(res, status, { server: GIT_SERVE_SERVER, protocol: GIT_SERVE_PROTOCOL, ...rest }, cors);
      };
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendCommitRefusal({ status: 400, reason: 'malformed' });
        return;
      }
      const parsed = parseCommitRequest(body);
      if (!parsed.ok) {
        sendCommitRefusal(parsed.refusal);
        return;
      }
      // R-GS-6, the same rule as every other route that names a repository.
      const repo = resolveRepo(root, parsed.request.repo);
      if (!repo.ok) {
        refuse(repo.reason === 'malformed' ? 400 : 404, repo.reason === 'malformed' ? 'malformed' : 'not-found', cors);
        return;
      }
      const applied = await applyCommit(repo.dir, parsed.request, {
        runGit,
        identity,
        connectionId: caller.connectionId,
      });
      if (!applied.ok) {
        sendCommitRefusal(applied.refusal);
        return;
      }
      log(
        `git-serve: commit ${applied.commitSha} on ${repo.name} ${parsed.request.branch} ` +
          `by connection ${caller.connectionId}`,
      );
      sendJson(
        res,
        200,
        {
          server: GIT_SERVE_SERVER,
          protocol: GIT_SERVE_PROTOCOL,
          commitSha: applied.commitSha,
          treeSha: applied.treeSha,
        },
        cors,
      );
      return;
    }

    const answer = await answerRead(url.pathname, url.searchParams, {
      root,
      instanceId,
      allowCommit,
      runGit,
    });
    if (answer.kind === 'json') sendJson(res, answer.status, answer.body, cors);
    else sendBlob(res, answer, cors);
  };

  const handler: http.RequestListener = (req, res) => {
    // An answer sent before the request's body was read (a refusal, or any route
    // that takes no body) closes the connection: on a tailnet `requestTimeout`
    // is off, so otherwise a client could trickle an endless body into it. The
    // answer says `Connection: close`, so no client reuses the connection; it
    // is half-closed so the answer is read, then cut after a grace. A git
    // request piped to `http-backend` keeps its connection (git reuses it
    // between rounds) and has its own idle bound. Whether a body is coming is
    // read from the framing, not `req.complete`: a bodyless request (a CORS
    // preflight, a GET) may not be `complete` yet when it is answered, and it
    // must keep its connection. An unparsable Content-Length counts as a body.
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      Number(req.headers['content-length'] ?? 0) !== 0;
    const hasUnreadBody = () => hasBody && !req.complete;
    const writeHead = res.writeHead;
    res.writeHead = function (this: http.ServerResponse, ...args: unknown[]) {
      if (hasUnreadBody() && !piped.has(res)) {
        res.setHeader('Connection', 'close');
        // With `Connection: close` Node calls `socket.destroySoon()` once the
        // answer is written, which closes the socket with the unread body still
        // in its receive buffer: the kernel then sends a reset that can discard
        // the answer before the client reads it (G-GS-15's 413 came back as
        // ECONNRESET). Only half-close here; the body keeps draining and the
        // grace below cuts the connection.
        const socket = req.socket;
        socket.destroySoon = () => {
          socket.end();
        };
      }
      return (writeHead as (...a: unknown[]) => http.ServerResponse).apply(this, args);
    } as typeof res.writeHead;
    res.once('finish', () => {
      if (!hasUnreadBody()) return;
      if (piped.has(res)) {
        // http-backend answered without reading the whole body: nothing more
        // can be said on this connection.
        req.socket.destroy();
        return;
      }
      req.socket.end();
      setTimeout(() => req.socket.destroy(), UNREAD_BODY_GRACE_MS).unref();
    });
    serve(req, res).catch(() => {
      // Any failure while answering ends the request: a 500 if nothing was sent
      // yet, a cut connection otherwise. A request is never left open, and a
      // failure inside a gate serves nothing (fail closed).
      if (!res.headersSent) sendRefusal(res, 500, 'failed', {});
      else res.destroy();
    });
  };

  return new Promise((resolvePromise, reject) => {
    const server =
      tailnet?.cert !== undefined && tailnet.key !== undefined
        ? https.createServer({ cert: tailnet.cert, key: tailnet.key }, handler)
        : http.createServer(handler);
    // Node's default `requestTimeout` (300 s) bounds a whole request, body
    // included, which would cut a long push. On a tailnet the git routes carry
    // their own idle bound instead (`GIT_IDLE_TIMEOUT_MS`, smartHttp.ts);
    // `headersTimeout` still bounds a request's head, and an answer sent before
    // its body was read closes the connection (`handler`).
    if (tailnet !== undefined) server.requestTimeout = 0;
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(opts.port, tailnet ? tailnet.address : '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : opts.port;
      const endpoint = tailnet
        ? `https://${tailnet.host.toLowerCase()}:${port}`
        : `http://127.0.0.1:${port}`;
      namespace = tailnet
        ? gitServeNamespace({ kind: 'tailnet', origin: endpoint })
        : gitServeNamespace({ kind: 'loopback', instanceId });
      resolvePromise({
        server,
        port,
        instanceId,
        root,
        endpoint,
        namespace,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Keep-alive connections would otherwise hold `close` open.
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
};
