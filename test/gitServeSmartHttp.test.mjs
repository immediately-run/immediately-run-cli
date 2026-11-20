// G-GS-6 and G-GS-13 — git's own HTTP protocol through git-serve
// (GIT_SERVE_SPEC §7 R-GS-14, R-GS-15, R-GS-17; roadmap R3-1361). Runs against
// the compiled dist/.
//
// The client is a real `git` binary and every repository is made by real
// commits. The server is started through its programmatic entry in the tailnet
// configuration on loopback, with an injected `whois` that answers from a
// recording made on a live tailnet; `http.curloptResolve` points the client at
// 127.0.0.1 while it sends the MagicDNS name as its Host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { startGitServe } from '../dist/gitServe/server.js';
import {
  backendEnv,
  forcedConfig,
  hasBrowserHeaders,
  matchGitRoute,
  parseCgiHead,
} from '../dist/gitServe/smartHttp.js';
import { parseTailnetIdentity, parseWhois } from '../dist/gitServe/tailscaleWhois.js';
import { runGitServeInit } from '../dist/commands/gitServe.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/tailscale-whois/', import.meta.url));
const identity = parseTailnetIdentity(readFileSync(join(FIXTURES, 'status.json'), 'utf8'));
const sameUser = parseWhois(0, readFileSync(join(FIXTURES, 'same-user.json'), 'utf8'), '');
const HOST = 'serving-node.example-tailnet.ts.net';
const ORIGIN = 'https://local.immediately.run';

let tmp;
let seq = 0;

const git = (cwd, args, opts = {}) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();

/**
 * Runs a git CLIENT command against the server, returning its exit code and
 * output. Asynchronous on purpose: the server under test lives in this process,
 * so a synchronous child would stop the event loop it needs to answer.
 */
const tryGit = (cwd, args) =>
  new Promise((resolvePromise) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolvePromise({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : -1), out: `${stdout}${stderr}` });
    });
  });

/** A served root with one repository `notes` holding two commits on `main`,
 *  and a working clone that made them. */
const makeRoot = () => {
  const dir = join(tmp, `case-${++seq}`);
  const root = join(dir, 'root');
  runGitServeInit(root, 'notes');
  const bare = join(root, 'notes.git');
  const work = join(dir, 'work');
  mkdirSync(work);
  git(work, ['init', '-q']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(work, 'a.txt'), 'two\n');
  git(work, ['commit', '-q', '-am', 'two']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-q', bare, 'main:main']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { dir, root, bare, work };
};

const serve = async (root, { allowPush = false, whois = async () => sameUser } = {}) => {
  const logs = [];
  const handle = await startGitServe({
    root,
    origin: ORIGIN,
    port: 0,
    allowPush,
    log: (line) => logs.push(line),
    tailnet: {
      host: HOST,
      address: '127.0.0.1',
      peerGate: { self: identity.self, allowUserIds: new Set(), whois },
    },
  });
  const url = (repo) => `http://${HOST}:${handle.port}/${repo}.git`;
  // What a stock client needs to reach the MagicDNS name at this loopback port.
  const client = ['-c', `http.curloptResolve=${HOST}:${handle.port}:127.0.0.1`, '-c', 'http.proxy=', '-c', 'protocol.version=2'];
  const raw = (path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolvePromise, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path, method, headers: { Host: `${HOST}:${handle.port}`, ...headers } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { handle, logs, url, client, raw };
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ir-git-serve-http-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

// --- the working path --------------------------------------------------------

test('a real `git clone` succeeds, and the clone\'s HEAD is the repository\'s', async () => {
  const { dir, root, bare } = makeRoot();
  const s = await serve(root);
  try {
    const dest = join(dir, 'clone');
    const cloned = await tryGit(dir, [...s.client, 'clone', '-q', s.url('notes'), dest]);
    assert.equal(cloned.code, 0, cloned.out);
    assert.equal(git(dest, ['rev-parse', 'HEAD']), git(bare, ['rev-parse', 'refs/heads/main']));
    assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'two\n');
    assert.equal(git(dest, ['rev-list', '--count', 'HEAD']), '2');
    // A later fetch sees a commit pushed to the bare repository meanwhile.
    const { work } = { work: join(dir, 'work') };
    writeFileSync(join(work, 'a.txt'), 'three\n');
    git(work, ['commit', '-q', '-am', 'three']);
    git(work, ['push', '-q', bare, 'main:main']);
    const pulled = await tryGit(dest, [...s.client, 'pull', '-q', '--ff-only']);
    assert.equal(pulled.code, 0, pulled.out);
    assert.equal(git(dest, ['rev-parse', 'HEAD']), git(bare, ['rev-parse', 'refs/heads/main']));
  } finally {
    await s.handle.close();
  }
});

test('the child is told who the peer is: REMOTE_USER is the peer\'s Tailscale login', () => {
  const env = backendEnv({
    root: '/srv/repos',
    route: { repo: 'notes', service: 'git-upload-pack', phase: 'advertise' },
    method: 'GET',
    allowPush: false,
    remoteAddress: '100.64.0.2',
    remoteUser: sameUser.peer.login,
  });
  assert.equal(env.REMOTE_USER, 'owner@example.com');
  assert.equal(env.REMOTE_ADDR, '100.64.0.2');
  assert.equal(env.GIT_PROJECT_ROOT, '/srv/repos');
  assert.equal(env.GIT_HTTP_EXPORT_ALL, '1');
  assert.equal(env.PATH_INFO, '/notes.git/info/refs');
  assert.equal(env.QUERY_STRING, 'service=git-upload-pack');
});

// --- G-GS-6 ------------------------------------------------------------------

test('G-GS-6: a request carrying Origin or any Sec-Fetch-* header is refused on fetch and on push', async () => {
  const { root } = makeRoot();
  const s = await serve(root, { allowPush: true });
  try {
    const paths = [
      ['/notes.git/info/refs?service=git-upload-pack', 'GET'],
      ['/notes.git/info/refs?service=git-receive-pack', 'GET'],
      ['/notes.git/git-upload-pack', 'POST'],
      ['/notes.git/git-receive-pack', 'POST'],
    ];
    const browserHeaders = [
      { Origin: ORIGIN },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Mode': 'no-cors' },
      { 'Sec-Fetch-Dest': 'empty' },
      { 'Sec-Fetch-User': '?1' },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const [path, method] of paths) {
      for (const headers of browserHeaders) {
        const res = await s.raw(path, { method, headers });
        assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(headers)}`);
        assert.equal(JSON.parse(res.body).reason, 'browser');
        assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS header, ever');
      }
      // Without them the same request is routed (the advertisement answers 200).
      if (method === 'GET') assert.equal((await s.raw(path, { method })).status, 200, path);
    }
    // These routes answer no OPTIONS.
    for (const [path] of paths) {
      const res = await s.raw(path, { method: 'OPTIONS' });
      assert.equal(res.status, 404, `OPTIONS ${path}`);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  } finally {
    await s.handle.close();
  }
});

test('G-GS-6: only the four paths are served — dumb routes, suffix-less names, nested paths and a symlinked repository are 404', async () => {
  const { dir, root, bare } = makeRoot();
  // A real repository outside the root, reachable through a symlink inside it,
  // and a real nested one. git http-backend alone would serve both.
  const outside = join(dir, 'outside');
  runGitServeInit(outside, 'secret');
  git(join(dir, 'work'), ['push', '-q', join(outside, 'secret.git'), 'main:main']);
  symlinkSync(join(outside, 'secret.git'), join(root, 'linked.git'));
  runGitServeInit(join(root, 'a'), 'b');
  git(join(dir, 'work'), ['push', '-q', join(root, 'a', 'b.git'), 'main:main']);
  // So that the dumb routes would have something to serve:
  git(bare, ['update-server-info']);
  assert.ok(existsSync(join(bare, 'info', 'refs')));

  const s = await serve(root);
  try {
    const notFound = [
      '/notes.git/HEAD',
      '/notes.git/objects/info/packs',
      '/notes.git/info/refs', // no service: the dumb ref listing
      '/notes.git/info/refs?service=git-upload-archive',
      '/notes.git/info/refs?service=git-upload-pack&x=1',
      '/notes.git/info/refs?x=1&service=git-upload-pack',
      '/notes.git/config',
      '/notes.git/git-upload-pack?service=git-upload-pack',
      '/notes.git/',
      '/notes.git',
      '/notes/info/refs?service=git-upload-pack', // no .git suffix
      '/a/b.git/info/refs?service=git-upload-pack', // nested
      '/a%2Fb.git/info/refs?service=git-upload-pack', // an encoded slash
      '/notes.git./info/refs?service=git-upload-pack', // a trailing dot
      '/notes.git/../notes.git/info/refs?service=git-upload-pack',
      '/linked.git/info/refs?service=git-upload-pack', // a symlinked repository
      '/absent.git/info/refs?service=git-upload-pack',
    ];
    for (const path of notFound) {
      assert.equal((await s.raw(path)).status, 404, path);
    }
    // The method is part of the shape.
    assert.equal((await s.raw('/notes.git/info/refs?service=git-upload-pack', { method: 'POST' })).status, 404);
    assert.equal((await s.raw('/notes.git/git-upload-pack', { method: 'GET' })).status, 404);
    // A real client gets the same answer for the symlink and the nested one.
    for (const repo of ['linked', 'a/b', 'absent']) {
      const res = await tryGit(dir, [...s.client, 'ls-remote', `http://${HOST}:${s.handle.port}/${repo}.git`]);
      assert.notEqual(res.code, 0, repo);
    }
    assert.equal((await tryGit(dir, [...s.client, 'ls-remote', s.url('notes')])).code, 0);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-6: the peer gate holds the git routes — a peer that is not the user cannot clone', async () => {
  const { dir, root } = makeRoot();
  const unknown = JSON.parse(readFileSync(join(FIXTURES, 'unknown.json'), 'utf8'));
  const s = await serve(root, { whois: async () => parseWhois(unknown.exitCode, unknown.stdout, unknown.stderr) });
  try {
    const res = await tryGit(dir, [...s.client, 'clone', '-q', s.url('notes'), join(dir, 'refused-clone')]);
    assert.notEqual(res.code, 0);
    assert.match(res.out, /403/);
    assert.ok(s.logs.some((l) => l.includes('(unknown-peer)')));
  } finally {
    await s.handle.close();
  }
});

test('R-GS-17: on loopback all four paths are 404', async () => {
  const { root } = makeRoot();
  const handle = await startGitServe({ root, origin: ORIGIN, token: 'session', port: 0, log: () => {} });
  try {
    for (const [path, method] of [
      ['/notes.git/info/refs?service=git-upload-pack', 'GET'],
      ['/notes.git/info/refs?service=git-receive-pack', 'GET'],
      ['/notes.git/git-upload-pack', 'POST'],
      ['/notes.git/git-receive-pack', 'POST'],
    ]) {
      const status = await new Promise((resolvePromise, reject) => {
        const req = http.request({ host: '127.0.0.1', port: handle.port, path, method }, (r) => r.resume().on('end', () => resolvePromise(r.statusCode)));
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 404, `${method} ${path}`);
    }
  } finally {
    await handle.close();
  }
});

// --- G-GS-13 -----------------------------------------------------------------

test('G-GS-13: without --allow-push a real push is refused, though the repository\'s own config enables it', async () => {
  const { dir, root, bare, work } = makeRoot();
  // The repository says push is on. git http-backend alone would obey this.
  git(bare, ['config', 'http.receivepack', 'true']);
  const before = git(bare, ['rev-parse', 'refs/heads/main']);
  const s = await serve(root);
  try {
    writeFileSync(join(work, 'a.txt'), 'pushed\n');
    git(work, ['commit', '-q', '-am', 'pushed']);
    const res = await tryGit(work, [...s.client, 'push', s.url('notes'), 'main:main']);
    assert.notEqual(res.code, 0, res.out);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), before, 'the branch did not move');
    // A new branch is refused the same way.
    assert.notEqual((await tryGit(work, [...s.client, 'push', s.url('notes'), 'main:other'])).code, 0);
    assert.equal((await tryGit(bare, ['rev-parse', '--verify', '-q', 'refs/heads/other'])).code, 1);
    // Fetch still works.
    assert.equal((await tryGit(dir, [...s.client, 'ls-remote', s.url('notes')])).code, 0);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-13: with --allow-push a fast-forward lands; a forced rewrite and a delete are refused', async () => {
  const { root, bare, work } = makeRoot();
  // The repository explicitly allows both; the forced environment config must outrank it.
  git(bare, ['config', 'receive.denyNonFastForwards', 'false']);
  git(bare, ['config', 'receive.denyDeletes', 'false']);
  const s = await serve(root, { allowPush: true });
  try {
    // A fast-forward push lands.
    writeFileSync(join(work, 'a.txt'), 'pushed\n');
    git(work, ['commit', '-q', '-am', 'pushed']);
    const pushed = git(work, ['rev-parse', 'HEAD']);
    const ff = await tryGit(work, [...s.client, 'push', s.url('notes'), 'main:main']);
    assert.equal(ff.code, 0, ff.out);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), pushed);
    // A new branch is a fast-forward of nothing and lands too.
    assert.equal((await tryGit(work, [...s.client, 'push', s.url('notes'), 'main:feature'])).code, 0);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/feature']), pushed);

    // A rewritten branch, pushed with --force, is refused.
    git(work, ['commit', '-q', '--amend', '-m', 'rewritten']);
    const rewritten = git(work, ['rev-parse', 'HEAD']);
    assert.notEqual(rewritten, pushed);
    const forced = await tryGit(work, [...s.client, 'push', '--force', s.url('notes'), 'main:main']);
    assert.notEqual(forced.code, 0, forced.out);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), pushed, 'the branch still names the pushed commit');

    // A branch delete is refused.
    const deleted = await tryGit(work, [...s.client, 'push', '--delete', s.url('notes'), 'feature']);
    assert.notEqual(deleted.code, 0, deleted.out);
    assert.equal(git(bare, ['rev-parse', 'refs/heads/feature']), pushed, 'the branch still exists');
  } finally {
    await s.handle.close();
  }
});

test('G-GS-13: nothing is created by pushing to a name that does not exist', async () => {
  const { root, work } = makeRoot();
  const s = await serve(root, { allowPush: true });
  try {
    assert.notEqual((await tryGit(work, [...s.client, 'push', s.url('brandnew'), 'main:main'])).code, 0);
    assert.equal(existsSync(join(root, 'brandnew.git')), false);
  } finally {
    await s.handle.close();
  }
});

test('the forced config: push is the flag\'s alone, and never the request\'s', () => {
  const off = Object.fromEntries(forcedConfig(false));
  assert.equal(off['http.receivepack'], 'false');
  assert.equal(off['http.uploadpack'], 'true');
  const on = Object.fromEntries(forcedConfig(true));
  assert.equal(on['http.receivepack'], 'true');
  assert.equal(on['receive.denyNonFastForwards'], 'true');
  assert.equal(on['receive.denyDeletes'], 'true');
  // The child's environment carries exactly these, and nothing inherited.
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'http.receivepack';
  process.env.GIT_CONFIG_VALUE_0 = 'true';
  process.env.GIT_DIR = '/elsewhere';
  try {
    const env = backendEnv({
      root: '/srv/repos',
      route: { repo: 'notes', service: 'git-receive-pack', phase: 'rpc' },
      method: 'POST',
      allowPush: false,
      remoteAddress: '100.64.0.2',
      remoteUser: 'owner@example.com',
    });
    assert.equal(env.GIT_DIR, undefined, 'an inherited GIT_DIR is dropped');
    const count = Number(env.GIT_CONFIG_COUNT);
    const forced = {};
    for (let i = 0; i < count; i++) forced[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
    assert.equal(forced['http.receivepack'], 'false');
    assert.equal(env.PATH_INFO, '/notes.git/git-receive-pack');
    assert.equal(env.QUERY_STRING, '');
  } finally {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    delete process.env.GIT_DIR;
  }
});

// --- units -------------------------------------------------------------------

test('matchGitRoute: exactly four shapes', () => {
  const up = { repo: 'notes', service: 'git-upload-pack' };
  const rp = { repo: 'notes', service: 'git-receive-pack' };
  assert.deepEqual(matchGitRoute('/notes.git/info/refs', '?service=git-upload-pack'), { ...up, phase: 'advertise' });
  assert.deepEqual(matchGitRoute('/notes.git/info/refs', '?service=git-receive-pack'), { ...rp, phase: 'advertise' });
  assert.deepEqual(matchGitRoute('/notes.git/git-upload-pack', ''), { ...up, phase: 'rpc' });
  assert.deepEqual(matchGitRoute('/notes.git/git-receive-pack', ''), { ...rp, phase: 'rpc' });
  assert.deepEqual(matchGitRoute('/a_b-1.git/git-upload-pack', '')?.repo, 'a_b-1');
  for (const [path, search] of [
    ['/notes.git/info/refs', ''],
    ['/notes.git/info/refs', '?service=git-upload-archive'],
    ['/notes.git/info/refs', '?service=git-upload-pack&service=git-receive-pack'],
    ['/notes.git/info/refs', '?SERVICE=git-upload-pack'],
    ['/notes.git/info/refs', '?service=git-upload-pack%20'],
    ['/notes.git/git-upload-pack', '?x'],
    ['/notes.git/HEAD', ''],
    ['/notes.git/objects/info/packs', ''],
    ['/notes/info/refs', '?service=git-upload-pack'],
    ['/a/b.git/info/refs', '?service=git-upload-pack'],
    ['/a%2Fb.git/info/refs', '?service=git-upload-pack'], // a percent-encoded slash
    ['/notes.git./info/refs', '?service=git-upload-pack'], // a trailing dot
    ['/notes..git/info/refs', '?service=git-upload-pack'],
    ['/.git/info/refs', '?service=git-upload-pack'],
    ['/notes.git/info/refs/', '?service=git-upload-pack'],
    ['/notes.git//info/refs', '?service=git-upload-pack'],
    ['/notes.GIT/info/refs', '?service=git-upload-pack'],
    ['notes.git/info/refs', '?service=git-upload-pack'],
    ['/notes.git/git-upload-pack/', ''],
    ['/no tes.git/git-upload-pack', ''],
  ]) {
    assert.equal(matchGitRoute(path, search), null, `${path}${search}`);
  }
});

test('hasBrowserHeaders, and parseCgiHead', () => {
  assert.equal(hasBrowserHeaders({ host: 'x', 'user-agent': 'git/2' }), false);
  assert.equal(hasBrowserHeaders({ origin: 'https://x' }), true);
  assert.equal(hasBrowserHeaders({ 'sec-fetch-anything-new': '1' }), true);
  // CGI: no Status line means 200; a Status line is honored; unknown headers are not passed on.
  assert.deepEqual(parseCgiHead('Content-Type: application/x-git-upload-pack-advertisement\r\nCache-Control: no-cache'), {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' },
  });
  assert.equal(parseCgiHead('Status: 403 Forbidden\r\nContent-Type: text/plain').status, 403);
  assert.deepEqual(parseCgiHead('Status: 404 Not Found\nAccess-Control-Allow-Origin: *\nX-Other: 1').headers, {});
  assert.equal(parseCgiHead('garbage'), null);
  assert.equal(parseCgiHead('Status: nope'), null);
});

test('an rpc with the wrong media type, or an unknown content encoding, never reaches the child', async () => {
  const { root } = makeRoot();
  const s = await serve(root);
  try {
    const post = (headers) => s.raw('/notes.git/git-upload-pack', { method: 'POST', headers, body: '0000' });
    // The refusal is this server's own JSON, with its reason: git http-backend
    // would also answer 415, so the status alone would not show who refused.
    const refusedHere = async (headers, reason) => {
      const res = await post(headers);
      assert.equal(res.status, 415, JSON.stringify(headers));
      assert.equal(JSON.parse(res.body).reason, reason, JSON.stringify(headers));
    };
    await refusedHere({ 'Content-Type': 'application/json' }, 'content-type');
    await refusedHere({}, 'content-type');
    await refusedHere({ 'Content-Type': 'application/x-git-receive-pack-request' }, 'content-type');
    await refusedHere({ 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'br' }, 'content-encoding');
  } finally {
    await s.handle.close();
  }
});
