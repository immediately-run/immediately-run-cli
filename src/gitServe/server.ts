/*
 * The HTTP server behind `immediately-run git-serve` (GIT_SERVE_SPEC §4, §9,
 * §10.1). It only wires: the guards decide who is served (`guards.ts`), the read
 * routes decide what is answered (`readRoutes.ts`), and this file moves bytes.
 *
 * Phase 1 binds 127.0.0.1 and serves plain HTTP. It reads committed objects
 * only; there is no working tree, no stream route and no write.
 */

import * as http from 'node:http';
import type { Socket } from 'node:net';
import { realpathSync } from 'node:fs';

import { LOOPBACK_HOSTS, admittedOrigins } from '../devServer.js';
import { guardRequest, sameSecret } from './guards.js';
import { GIT_SERVE_PROTOCOL, GIT_SERVE_SERVER, type RunGit } from './protocol.js';
import { answerRead, type ReadAnswer } from './readRoutes.js';
import { runGit as realRunGit, spawnGit } from './runGit.js';
import { loadInstanceId } from './state.js';

export interface GitServeOptions {
  /** The directory of bare repositories. */
  root: string;
  /** The allowed browser origin (and deep-link base); its mediator is admitted with it. */
  origin: string;
  /** The session token: 256 random bits, minted per start. It carries the `read` scope. */
  token: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Tests inject a `runGit` to move a ref between two of the server's own git calls. */
  runGit?: RunGit;
}

export interface GitServeHandle {
  server: http.Server;
  port: number;
  /** The root's instance id, as `/meta` reports it. */
  instanceId: string;
  /** The root as served: absolute, symlinks resolved. */
  root: string;
  close(): Promise<void>;
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
  const root = realpathSync(opts.root);
  const instanceId = loadInstanceId(root);
  const runGit = opts.runGit ?? realRunGit;
  const origins = admittedOrigins(opts.origin);
  const isToken = (bearer: string): boolean => sameSecret(bearer, opts.token);

  const handler: http.RequestListener = (req, res) => {
    // A request target the URL parser refuses (`//`, for one) is a 400, never a throw.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendRefusal(res, 400, 'malformed', {});
      return;
    }
    const verdict = guardRequest({
      method: req.method,
      pathname: url.pathname,
      host: req.headers.host,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      localPort: req.socket.localPort ?? opts.port,
      allowedHosts: LOOPBACK_HOSTS,
      origins,
      isToken,
    });
    if (verdict.kind === 'preflight') {
      res.writeHead(204, verdict.headers);
      res.end();
      return;
    }
    if (verdict.kind === 'refuse') {
      sendRefusal(res, verdict.status, verdict.reason, verdict.cors);
      return;
    }
    const cors = verdict.cors;
    answerRead(url.pathname, url.searchParams, {
      root,
      instanceId,
      allowCommit: false,
      runGit,
    })
      .then((answer) => {
        if (answer.kind === 'json') sendJson(res, answer.status, answer.body, cors);
        else sendBlob(res, answer, cors);
      })
      .catch(() => {
        // Any failure while answering ends the request: a 500 if nothing was
        // sent yet, a cut connection otherwise. A request is never left open.
        if (!res.headersSent) sendRefusal(res, 500, 'git-failed', cors);
        else res.destroy();
      });
  };

  return new Promise((resolvePromise, reject) => {
    const server = http.createServer(handler);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : opts.port;
      resolvePromise({
        server,
        port,
        instanceId,
        root,
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
