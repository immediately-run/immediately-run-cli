/*
 * Localhost HTTP server behind `immediately-run dev` (LOCAL_DEVELOPMENT_SPEC
 * §6.3): serves a project's working tree to hosted immediately.run as the
 * readonly source of a `local` provider mount.
 *
 *   GET  /tree          → { ref: 'live', files: [{ path, size, type }] }
 *   GET  /blob?path=/x  → raw file bytes
 *   GET  /meta          → { gitRemote?, headSha?, defaultBranch? }  (best effort)
 *   GET  /watch         → SSE stream of { eventType, path }
 *   OPTIONS *           → CORS + Private Network Access preflight
 *
 * Read-only by construction: no write route exists. Security (spec §8): binds
 * 127.0.0.1 only, requires a per-session bearer token on every request
 * (`Authorization: Bearer …`, or `?token=` for EventSource, which cannot send
 * headers), enforces an Origin allowlist when the request carries an Origin
 * (browser requests always do; curl tests don't), and jails all paths to the
 * project root (resolveSafe, after dev-fs/src/plugin.ts).
 *
 * The SSE watcher uses fs.watch(root, { recursive: true }) — native on macOS
 * and Windows; on Linux recursive watch requires Node >= 20.
 */

import * as http from 'node:http';
import { watch as fsWatch, statSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import {
  defaultBranchOf,
  git,
  headCommitSha,
  isGitRepo,
} from './git.js';

export interface DevServerOptions {
  root: string; // absolute project root
  origin: string; // allowed browser Origin (and deep-link base)
  token: string; // per-session bearer token
  port: number; // 0 = ephemeral (tests)
}

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

export const listWorkingTreeFiles = (root: string): TreeFile[] => {
  const rels = isGitRepo(root) ? gitListFiles(root) : walkFiles(root);
  const files: TreeFile[] = [];
  for (const rel of new Set(rels)) {
    try {
      // statSync follows symlinks; isFile() drops directories/specials. A
      // listed-but-deleted tracked file fails stat and is skipped.
      const st = statSync(path.join(root, rel));
      if (!st.isFile()) continue;
      files.push({ path: '/' + rel.split(path.sep).join('/'), size: st.size, type: 'blob' });
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

// --- request guard -----------------------------------------------------------

const CORS_MAX_AGE = '600';

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

// --- server -------------------------------------------------------------------

export const startDevServer = (opts: DevServerOptions): Promise<DevServerHandle> => {
  const root = path.resolve(opts.root);
  const inGitRepo = isGitRepo(root);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const requestOrigin = req.headers.origin;

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
    // for public→private fetches; answer both in one response.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': CORS_MAX_AGE,
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
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

    try {
      switch (url.pathname) {
        case '/tree': {
          sendJson(res, 200, { ref: 'live', files: listWorkingTreeFiles(root) }, cors);
          return;
        }
        case '/blob': {
          const abs = resolveSafe(root, url.searchParams.get('path'));
          let bytes: Buffer;
          try {
            bytes = readFileSync(abs);
          } catch {
            sendJson(res, 404, { error: 'not found' }, cors);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...cors });
          res.end(bytes);
          return;
        }
        case '/meta': {
          const meta: { gitRemote?: string; headSha?: string; defaultBranch?: string } = {};
          if (inGitRepo) {
            try { meta.gitRemote = git(root, ['remote', 'get-url', 'origin']); } catch { /* no remote */ }
            try { meta.headSha = headCommitSha(root); } catch { /* unborn HEAD */ }
            try { meta.defaultBranch = defaultBranchOf(root, 'main'); } catch { /* best effort */ }
          }
          sendJson(res, 200, meta, cors);
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
          const watcher = fsWatch(root, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const rel = String(filename).split(path.sep).join('/');
            // Never emit VCS/dependency noise; gitignored files mirror /tree.
            if (rel === '.git' || rel.startsWith('.git/')) return;
            if (rel.split('/').includes('node_modules')) return;
            if (inGitRepo && isGitIgnored(root, rel)) return;
            res.write(`data: ${JSON.stringify({ eventType, path: `/${rel}` })}\n\n`);
          });
          const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000);
          req.on('close', () => {
            clearInterval(heartbeat);
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
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only — never reachable from the network (spec §8).
    server.listen(opts.port, '127.0.0.1', () => {
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
