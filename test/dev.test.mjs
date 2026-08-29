// Tests for `immediately.run dev` (the localhost provider server). Runs against
// the compiled dist/ (`npm test` builds first), so it exercises exactly what
// ships. Uses node:test — no test-framework dependency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import {
  startDevServer,
  runUntilShutdown,
  listWorkingTreeFiles,
  resolveSafe,
  isAllowedHost,
  DEV_PROTOCOL_VERSION,
} from '../dist/devServer.js';
import {
  parseTailscaleSelf,
  resolveTailscaleCert,
} from '../dist/tailscale.js';
import https from 'node:https';
import {
  sanitizeProjectName,
  buildDeepLink,
  buildRegionDeepLink,
  parsePreviewPath,
  defaultPreviewPath,
  identityHash8,
  isRecognizedOrigin,
  resolveDevLlmConfig,
  runDev,
} from '../dist/commands/dev.js';
import { stripRemoteCredentials } from '../dist/git.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'test-token-123';

let root;
let handle;
let base;

const authed = (path, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });

// Raw HTTP client so we can set the Host header (fetch/undici forbids it). Returns
// { status, body }.
const rawGet = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });

before(async () => {
  // Fixture: a git repo with a committed file, an uncommitted file, and a
  // gitignored file.
  root = mkdtempSync(join(tmpdir(), 'ir-dev-test-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'committed.txt'), 'committed contents\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'uncommitted.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'ignored.txt'), 'should not be served\n');

  handle = await startDevServer({ root, origin: ORIGIN, token: TOKEN, port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  rmSync(root, { recursive: true, force: true });
});

test('/tree lists the working tree (uncommitted included, gitignored excluded)', async () => {
  const res = await authed('/tree');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ref, 'live');
  const paths = body.files.map((f) => f.path);
  assert.ok(paths.includes('/committed.txt'));
  assert.ok(paths.includes('/src/uncommitted.ts'), 'uncommitted file must be served');
  assert.ok(paths.includes('/.gitignore'));
  assert.ok(!paths.includes('/ignored.txt'), 'gitignored file must not be served');
  const committed = body.files.find((f) => f.path === '/committed.txt');
  assert.equal(committed.size, 'committed contents\n'.length);
  assert.equal(committed.type, 'blob');
});

test('/blob returns raw bytes', async () => {
  const res = await authed('/blob?path=%2Fsrc%2Funcommitted.ts');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await res.text(), 'export const x = 1;\n');
});

test('/blob 404s on a missing file', async () => {
  const res = await authed('/blob?path=%2Fnope.txt');
  assert.equal(res.status, 404);
});

test('/blob rejects path escapes', async () => {
  const res = await authed(`/blob?path=${encodeURIComponent('/../../../etc/passwd')}`);
  // resolveSafe strips leading slashes then resolves; escapes yield 403,
  // in-jail-but-missing yields 404. Either way the host file must not leak.
  assert.ok([403, 404].includes(res.status));
  const text = await res.text();
  assert.ok(!text.includes('root:'), 'must not leak /etc/passwd');
});

test('missing or wrong token → 403', async () => {
  assert.equal((await fetch(`${base}/tree`)).status, 403);
  const wrong = await fetch(`${base}/tree`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 403);
});

test('token via query param is accepted (EventSource cannot send headers)', async () => {
  const res = await fetch(`${base}/tree?token=${TOKEN}`);
  assert.equal(res.status, 200);
});

test('disallowed Origin → 403 even with a valid token', async () => {
  const res = await authed('/tree', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('LD-1: a rebound Host is rejected even with a valid token', async () => {
  // DNS-rebinding: the socket is 127.0.0.1 but the browser sends the attacker's
  // own (rebound) hostname. The token is presented, yet the request is refused.
  const res = await rawGet('/tree', {
    Authorization: `Bearer ${TOKEN}`,
    Host: `attacker.example:${handle.port}`,
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /host not allowed/);
});

test('LD-1: a loopback Host on the wrong port is rejected', async () => {
  const res = await rawGet('/tree', {
    Authorization: `Bearer ${TOKEN}`,
    Host: '127.0.0.1:1',
  });
  assert.equal(res.status, 403);
});

test('LD-1: localhost and 127.0.0.1 Host on the right port are accepted', async () => {
  for (const name of ['localhost', '127.0.0.1']) {
    const res = await rawGet('/tree', {
      Authorization: `Bearer ${TOKEN}`,
      Host: `${name}:${handle.port}`,
    });
    assert.equal(res.status, 200, `Host ${name} should be accepted`);
  }
});

test('unit: isAllowedHost pins loopback names + the accepting port', () => {
  assert.equal(isAllowedHost('localhost:5179', 5179), true);
  assert.equal(isAllowedHost('127.0.0.1:5179', 5179), true);
  assert.equal(isAllowedHost('[::1]:5179', 5179), true);
  assert.equal(isAllowedHost('LocalHost:5179', 5179), true); // case-insensitive
  assert.equal(isAllowedHost('localhost', 5179), true); // no port → host still pinned
  assert.equal(isAllowedHost('attacker.example:5179', 5179), false);
  assert.equal(isAllowedHost('127.0.0.1:9999', 5179), false); // wrong port
  assert.equal(isAllowedHost('127.0.0.1.evil.com:5179', 5179), false);
  assert.equal(isAllowedHost(undefined, 5179), false);
  assert.equal(isAllowedHost('', 5179), false);
});

test('allowed Origin is echoed in CORS headers', async () => {
  const res = await authed('/tree', { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('OPTIONS preflight carries CORS + Private Network Access headers', async () => {
  const res = await fetch(`${base}/tree`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization');
});

test('/meta reports git info best-effort', async () => {
  const res = await authed('/meta');
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.match(meta.headSha, /^[0-9a-f]{40}$/);
});

test('/watch emits an SSE event when a file changes', async () => {
  const res = await fetch(`${base}/watch?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventPromise = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/data: (.*)\n\n/);
      if (match) return JSON.parse(match[1]);
    }
  })();

  // Give fs.watch a beat to attach, then touch a served file.
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(join(root, 'src', 'uncommitted.ts'), 'export const x = 2;\n');

  const event = await Promise.race([
    eventPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event within 5s')), 5000)),
  ]);
  assert.equal(event.path, '/src/uncommitted.ts');
  assert.ok(['change', 'rename'].includes(event.eventType));
  await reader.cancel();
});

test('unit: sanitizeProjectName maps to the URL charset', () => {
  assert.equal(sanitizeProjectName('my-app'), 'my-app');
  assert.equal(sanitizeProjectName('my.app v2!'), 'my-app-v2');
  assert.equal(sanitizeProjectName('...'), 'project');
});

test('unit: buildDeepLink shape (namespace carries the §6.2 disambiguator)', () => {
  const url = buildDeepLink(
    'http://localhost:3000/',
    'proj-abcd1234',
    'proj',
    'http://127.0.0.1:7700',
    'tok',
  );
  assert.equal(
    url,
    'http://localhost:3000/edit/local/proj-abcd1234/proj/live#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7700&ir-token=tok',
  );
});

test('unit: parsePreviewPath maps owner/repo[@ref] to a present route (§6.8)', () => {
  assert.equal(parsePreviewPath('acme/notes'), 'present/github/acme/notes/main/');
  assert.equal(parsePreviewPath('acme/notes@dev'), 'present/github/acme/notes/dev/');
  assert.equal(parsePreviewPath('github/acme/notes@v2'), 'present/github/acme/notes/v2/');
  // verbatim present/edit routes pass through (allow a file path); leading slash ok
  assert.equal(
    parsePreviewPath('/present/github/acme/notes/main/files/src/App.tsx'),
    'present/github/acme/notes/main/files/src/App.tsx',
  );
  assert.equal(parsePreviewPath('edit/github/acme/notes/main/'), 'edit/github/acme/notes/main/');
});

test('unit: defaultPreviewPath picks edit/new for chrome regions, landing for page.* (§6.8)', () => {
  // editor-chrome regions only render in /edit/, so default to a blank editor
  assert.equal(defaultPreviewPath('panel.files'), 'edit/new');
  assert.equal(defaultPreviewPath('modal.share'), 'edit/new');
  // a full-page region IS the page → host default landing (empty path)
  assert.equal(defaultPreviewPath('page.landing'), '');
});

test('unit: parsePreviewPath rejects a malformed locator (§6.8)', () => {
  assert.throws(() => parsePreviewPath('justone'), /Invalid --preview/);
  assert.throws(() => parsePreviewPath('a/b/c'), /Invalid --preview/);
});

test('unit: buildRegionDeepLink flips path→GitHub preview, local source→fragment (§6.8)', () => {
  const url = buildRegionDeepLink(
    'https://immediately.run',
    'local/proj-abcd1234/proj/live',
    'panel.files',
    'http://127.0.0.1:7700',
    'tok',
    'present/github/acme/notes/main/',
  );
  assert.equal(
    url,
    'https://immediately.run/present/github/acme/notes/main/' +
      '#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7700&ir-token=tok' +
      '&ir-dev-region=panel.files&ir-dev-source=local%2Fproj-abcd1234%2Fproj%2Flive',
  );
});

test('unit: buildRegionDeepLink with an empty preview path → host default landing (§6.8)', () => {
  const url = buildRegionDeepLink(
    'https://immediately.run',
    'local/proj-abcd1234/proj/live',
    'page.landing',
    'http://127.0.0.1:7700',
    'tok',
    '',
  );
  // path is just the origin root; the dev-override directive still rides the fragment
  assert.equal(
    url,
    'https://immediately.run/' +
      '#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7700&ir-token=tok' +
      '&ir-dev-region=page.landing&ir-dev-source=local%2Fproj-abcd1234%2Fproj%2Flive',
  );
});

test('unit: buildDeepLink carries a real https tailnet endpoint under --bind tailscale (§9.1)', () => {
  const url = buildDeepLink(
    'https://immediately.run',
    'proj-abcd1234',
    'proj',
    'https://mac.tailxyz.ts.net:7700',
    'tok',
  );
  assert.equal(
    url,
    'https://immediately.run/edit/local/proj-abcd1234/proj/live' +
      '#ir-endpoint=https%3A%2F%2Fmac.tailxyz.ts.net%3A7700&ir-token=tok',
  );
});

// --- LD2-1: path-hash cowName disambiguator (the §6.2 exit criterion) ---

test('LD2-1: two same-named checkouts get distinct overlay identities; same path is stable', () => {
  // Two checkouts that share the basename `my-app` at DIFFERENT paths.
  const a = mkdtempSync(join(tmpdir(), 'ir-cow-a-'));
  const b = mkdtempSync(join(tmpdir(), 'ir-cow-b-'));
  try {
    mkdirSync(join(a, 'my-app'));
    mkdirSync(join(b, 'my-app'));
    const ha = identityHash8(join(a, 'my-app'));
    const hb = identityHash8(join(b, 'my-app'));
    assert.match(ha, /^[0-9a-f]{8}$/);
    // Distinct checkouts → distinct hash → distinct namespace → distinct overlay
    // (the cross-checkout contamination LD2-1 closes).
    assert.notEqual(ha, hb);
    // Reconnect semantics: the SAME invoked path always yields the SAME hash, so
    // the overlay + journal reattach across server restarts / new tokens / ports.
    assert.equal(identityHash8(join(a, 'my-app')), ha);
    // The host keys on the namespace segment, which now differs for the two:
    const nsA = `my-app-${ha}`;
    const nsB = `my-app-${hb}`;
    assert.notEqual(
      buildDeepLink('https://immediately.run', nsA, 'my-app', 'http://127.0.0.1:1', 't'),
      buildDeepLink('https://immediately.run', nsB, 'my-app', 'http://127.0.0.1:1', 't'),
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// --- R3-422: invoked-path identity (symlinks are honest) + --fresh salting ---

test('R3-422: a symlinked checkout gets its own identity (invoked path, not realpath)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-sym-'));
  try {
    const real = join(dir, 'my-app');
    mkdirSync(real);
    const link = join(dir, 'my-app-link');
    try {
      symlinkSync(real, link, 'dir');
    } catch {
      t.skip('symlinks not permitted on this filesystem');
      return;
    }
    // The docs promise: serving via a different path yields a fresh appKey. A
    // realpath-derived hash collapsed the symlink onto its target and broke
    // that; the invoked-path hash keeps the two identities distinct...
    assert.notEqual(identityHash8(link), identityHash8(real));
    // ...while resolving-to-the-same-realpath still holds for the filesystem
    // (sanity: the link really does point at the same tree).
    assert.equal(realpathSync(link), realpathSync(real));
    // And each spelling is individually stable (reattach semantics preserved).
    assert.equal(identityHash8(link), identityHash8(link));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-422: identityHash8 salt (--fresh) changes the identity; no salt is the stable one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-fresh-'));
  try {
    const base = identityHash8(dir);
    assert.match(base, /^[0-9a-f]{8}$/);
    const salted = identityHash8(dir, ' fresh:0011223344556677');
    assert.match(salted, /^[0-9a-f]{8}$/);
    assert.notEqual(salted, base);
    // Two distinct salts (two --fresh runs) yield two distinct identities.
    assert.notEqual(identityHash8(dir, ' fresh:aa'), identityHash8(dir, ' fresh:bb'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-422: dev --fresh serves a namespace distinct from the stable identity', async () => {
  const proc = spawn(
    process.execPath,
    [CLI_ENTRY, 'dev', root, '--json', '--fresh', '--port', '0', '--origin', ORIGIN],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', (c) => {
        out += c;
        const nl = out.indexOf('\n');
        if (nl !== -1) resolve(out.slice(0, nl));
      });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('no JSON line on stdout within 8s')), 8000);
    });
    const { url } = JSON.parse(line);
    const ns = url.match(/\/edit\/local\/([^/]+)\//)[1];
    // The salted namespace must NOT be the checkout's stable identity — that is
    // the whole point of --fresh (new appKey, no prior grants).
    assert.ok(!ns.endsWith(`-${identityHash8(root)}`), 'namespace must not reuse the stable hash');
    assert.match(ns, /-[0-9a-f]{8}$/);
  } finally {
    proc.kill('SIGKILL');
  }
});

// --- A3: token-gated /health (liveness + protocol version) ---

test('A3: /health is token-gated and reports the protocol version', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 403); // no token → gated
  const res = await authed('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, protocol: DEV_PROTOCOL_VERSION });
});

// --- LD2-5: /tree and /blob size bounds ---

test('LD2-5: /tree answers an explicit 413 naming the cap (no silent truncation)', async () => {
  // A tiny server with a 1-entry cap over the multi-file fixture overflows.
  const capped = await startDevServer({ root, origin: ORIGIN, token: TOKEN, port: 0, maxTreeEntries: 1 });
  try {
    const res = await fetch(`http://127.0.0.1:${capped.port}/tree`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.cap, 1);
    assert.match(body.error, /1-entry/);
  } finally {
    await capped.close();
  }
});

test('LD2-5: /blob answers 413 for a file over the size cap, 200 under it', async () => {
  const capped = await startDevServer({ root, origin: ORIGIN, token: TOKEN, port: 0, maxBlobBytes: 8 });
  try {
    const get = (p) =>
      fetch(`http://127.0.0.1:${capped.port}/blob?path=${encodeURIComponent(p)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
    // committed.txt is 'committed contents\n' (19 bytes) > 8 → 413.
    const tooBig = await get('/committed.txt');
    assert.equal(tooBig.status, 413);
    const body = await tooBig.json();
    assert.equal(body.cap, 8);
    assert.ok(body.size > 8);
    // A small file under the cap still serves.
    writeFileSync(join(root, 'tiny.txt'), 'hi');
    const ok = await get('/tiny.txt');
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'hi');
  } finally {
    await capped.close();
  }
});

// --- LD2-4: watch-event coalescing (the burst load test) ---

test('LD2-4: a burst of writes is coalesced and never wedges the loop', async () => {
  const res = await fetch(`${base}/watch?token=${TOKEN}`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const collect = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let m;
      while ((m = buffer.match(/data: (.*)\n\n/))) {
        events.push(JSON.parse(m[1]));
        buffer = buffer.slice(m.index + m[0].length);
      }
    }
  })();
  void collect;

  await new Promise((r) => setTimeout(r, 200)); // let fs.watch attach
  // Burst: 25 rapid writes to the SAME path, all within one coalescing window.
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(root, 'src', 'uncommitted.ts'), `export const x = ${i};\n`);
  }
  await new Promise((r) => setTimeout(r, 300)); // > the coalescing window

  // The loop is alive — the server still answers (a per-event blocking subprocess
  // would have wedged it).
  assert.equal((await authed('/health')).status, 200);
  // Coalesced: 25 writes to one path collapse to a handful of events, not 25.
  const mine = events.filter((e) => e.path === '/src/uncommitted.ts');
  assert.ok(mine.length >= 1, 'the change must still be delivered');
  assert.ok(mine.length <= 5, `coalesced (got ${mine.length} events for 25 writes)`);
  await reader.cancel();
});

// --- A3: machine-readable `dev --json` output ---

test('A3: dev --json prints exactly one JSON line { url, endpoint, token, port }', async () => {
  const proc = spawn(
    process.execPath,
    [CLI_ENTRY, 'dev', root, '--json', '--port', '0', '--origin', ORIGIN],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', (c) => {
        out += c;
        const nl = out.indexOf('\n');
        if (nl !== -1) resolve(out.slice(0, nl));
      });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('no JSON line on stdout within 8s')), 8000);
    });
    const obj = JSON.parse(line); // must be valid JSON, not prose
    assert.match(obj.url, /\/edit\/local\/[^/]+-[0-9a-f]{8}\//); // disambiguated namespace
    assert.match(obj.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(typeof obj.token, 'string');
    assert.ok(obj.token.length > 0);
    assert.equal(typeof obj.port, 'number');
  } finally {
    proc.kill('SIGINT');
  }
});

// --- R3-422: graceful shutdown on SIGTERM/SIGINT --------------------------------
// Mechanism under test: `http.Server.close()` waits for in-flight connections,
// and the SSE routes (`/watch` etc.) hold never-ending keep-alive streams — so
// before R3-422 a `dev` process with a page attached ignored a plain SIGTERM
// (close() never called back) until `kill -9`. `close()` now destroys live
// sockets, and `runUntilShutdown` adds the grace-timeout backstop.

test('R3-422: handle.close() resolves promptly even with a live SSE /watch stream', async () => {
  const srv = await startDevServer({ root, origin: ORIGIN, token: TOKEN, port: 0 });
  // Attach a never-ending SSE consumer (this is what wedged the old close()).
  const res = await fetch(`http://127.0.0.1:${srv.port}/watch?token=${TOKEN}`);
  assert.equal(res.status, 200);
  const closed = srv.close();
  const outcome = await Promise.race([
    closed.then(() => 'closed'),
    new Promise((r) => setTimeout(() => r('hung'), 3000)),
  ]);
  assert.equal(outcome, 'closed', 'close() must not wait out a never-ending SSE stream');
  await res.body.cancel().catch(() => {});
});

test('R3-422: runUntilShutdown force-exits when teardown hangs past the grace period', async () => {
  const before = process.listeners('SIGTERM');
  const forced = [];
  const neverCloses = { close: () => new Promise(() => {}) };
  const running = runUntilShutdown(neverCloses, {
    graceMs: 50,
    forceExit: (code) => forced.push(code),
  });
  try {
    process.emit('SIGTERM', 'SIGTERM'); // in-process signal dispatch
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(forced, [1], 'a hung close() must trip the grace-timeout force exit');
    // A second signal force-exits immediately (no second grace wait).
    process.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(forced, [1, 1]);
    void running; // never resolves by design here — the forceExit hook fired instead
  } finally {
    // Drop the listeners runUntilShutdown registered so later tests are unaffected.
    for (const l of process.listeners('SIGTERM')) {
      if (!before.includes(l)) process.removeListener('SIGTERM', l);
    }
    for (const l of process.listeners('SIGINT')) {
      if (!before.includes(l)) process.removeListener('SIGINT', l);
    }
  }
});

test('R3-422: a dev process with a live SSE consumer exits on a plain SIGTERM', async () => {
  const proc = spawn(
    process.execPath,
    [CLI_ENTRY, 'dev', root, '--json', '--port', '0', '--origin', ORIGIN],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let sseRes;
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', (c) => {
        out += c;
        const nl = out.indexOf('\n');
        if (nl !== -1) resolve(out.slice(0, nl));
      });
      proc.on('error', reject);
      setTimeout(() => reject(new Error('no JSON line on stdout within 8s')), 8000);
    });
    const { endpoint, token } = JSON.parse(line);
    // Reproduce the reported hang: hold a /watch SSE stream open, then SIGTERM.
    sseRes = await fetch(`${endpoint}/watch?token=${token}`);
    assert.equal(sseRes.status, 200);

    const exit = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
    proc.kill('SIGTERM'); // the plain `kill` that used to be ignored
    const outcome = await Promise.race([
      exit,
      new Promise((_, rej) => setTimeout(() => rej(new Error('process ignored SIGTERM (still alive after 5s)')), 5000)),
    ]);
    // Graceful path: exit code 0 (the grace-timeout force path would be 1 —
    // either is termination, but the clean close must win here).
    assert.equal(outcome.code, 0, `expected a clean exit, got ${JSON.stringify(outcome)}`);
  } finally {
    if (sseRes) await sseRes.body.cancel().catch(() => {});
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});

test('unit: resolveSafe jails paths to the root', () => {
  assert.equal(resolveSafe('/a/b', '/x.txt'), '/a/b/x.txt');
  assert.throws(() => resolveSafe('/a/b', '/../escape'), /escapes|EACCES/);
});

test('unit: listWorkingTreeFiles on a non-git directory skips node_modules', () => {
  const plain = mkdtempSync(join(tmpdir(), 'ir-dev-plain-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'x');
    mkdirSync(join(plain, 'node_modules'));
    writeFileSync(join(plain, 'node_modules', 'dep.js'), 'y');
    const files = listWorkingTreeFiles(plain).map((f) => f.path);
    assert.deepEqual(files, ['/index.js']);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

// --- LD-5: /blob enforces the .gitignore filter (no read-through of hidden paths) ---

test('LD-5: /blob 404s a gitignored file even with a valid token', async () => {
  // `ignored.txt` is gitignored (the before() fixture) and absent from /tree;
  // /blob must answer the SAME 404 as a missing file — no existence oracle.
  const res = await authed('/blob?path=%2Fignored.txt');
  assert.equal(res.status, 404);
});

test('LD-5: /blob 404s a .git/ path', async () => {
  const res = await authed(`/blob?path=${encodeURIComponent('/.git/config')}`);
  assert.equal(res.status, 404);
});

test('LD-5: /blob 404s a node_modules path', async () => {
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n');
  const res = await authed(`/blob?path=${encodeURIComponent('/node_modules/pkg/index.js')}`);
  assert.equal(res.status, 404);
});

// --- LD2-2: /meta.gitRemote is credential-stripped ---

test('LD2-2: stripRemoteCredentials removes userinfo from a URL remote, leaves the rest', () => {
  assert.equal(
    stripRemoteCredentials('https://user:ghp_secret@github.com/o/r.git'),
    'https://github.com/o/r.git',
  );
  // a lone token (bare username, no password) — the whole userinfo still goes.
  assert.equal(
    stripRemoteCredentials('https://ghp_tok@github.com/o/r.git'),
    'https://github.com/o/r.git',
  );
  // scp-like form is not a URL; its bare username carries no secret → unchanged.
  assert.equal(stripRemoteCredentials('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  // a credential-free https remote is unchanged.
  assert.equal(stripRemoteCredentials('https://github.com/o/r.git'), 'https://github.com/o/r.git');
});

test('LD2-2: /meta.gitRemote never carries a credentialed remote across loopback', async () => {
  execFileSync(
    'git',
    ['-C', root, 'remote', 'add', 'origin', 'https://user:ghp_secret@github.com/o/r.git'],
    { stdio: 'pipe' },
  );
  const meta = await (await authed('/meta')).json();
  assert.equal(meta.gitRemote, 'https://github.com/o/r.git');
  assert.ok(!meta.gitRemote.includes('ghp_secret'));
});

// --- LD-3: --origin allowlist + --origin-unsafe escape ---

test('LD-3: isRecognizedOrigin accepts immediately.run, loopback, and preview origins', () => {
  for (const ok of [
    'https://immediately.run',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'https://site.local.immediately.run',
    'https://my-app--preview.web.app',
    'https://my-app.firebaseapp.com',
  ]) {
    assert.equal(isRecognizedOrigin(ok), true, ok);
  }
});

test('LD-3: isRecognizedOrigin refuses arbitrary or malformed origins', () => {
  for (const bad of [
    'https://evil.example',
    'http://immediately.run.evil.com', // suffix-spoof
    'https://immediately.run/path', // an Origin has no path
    'https://user@immediately.run', // userinfo present
    'http://github.com',
    'not-a-url',
  ]) {
    assert.equal(isRecognizedOrigin(bad), false, bad);
  }
});

test('LD-3: runDev refuses an unrecognized --origin unless --origin-unsafe is given', async () => {
  // The check runs BEFORE the server starts, so this rejects without leaking a
  // listener. (The allowed path would start a blocking server — covered by the
  // pure isRecognizedOrigin test above.)
  await assert.rejects(
    runDev({ positionals: [root], flags: { origin: 'https://evil.example' } }),
    /origin-unsafe/,
  );
});

// --- §9.1: Tier-1.5 tailnet binding (--bind tailscale) ----------------------

test('§9.1: isAllowedHost pins the MagicDNS name (+ port) under a tailnet bind', () => {
  const ts = new Set(['mac.tailxyz.ts.net']);
  // The MagicDNS name on the accepting port is accepted (case-insensitive).
  assert.equal(isAllowedHost('mac.tailxyz.ts.net:7700', 7700, ts), true);
  assert.equal(isAllowedHost('MAC.TailXYZ.ts.net:7700', 7700, ts), true);
  assert.equal(isAllowedHost('mac.tailxyz.ts.net', 7700, ts), true); // no port → host still pinned
  // A rebound / foreign Host is refused even on the right port; so is loopback,
  // which is NOT in the tailnet allowlist (the pin moved off localhost).
  assert.equal(isAllowedHost('attacker.example:7700', 7700, ts), false);
  assert.equal(isAllowedHost('mac.tailxyz.ts.net:1', 7700, ts), false); // wrong port
  assert.equal(isAllowedHost('localhost:7700', 7700, ts), false);
  assert.equal(isAllowedHost('127.0.0.1:7700', 7700, ts), false);
});

test('§9.1: parseTailscaleSelf reads the MagicDNS name + prefers the 100.x tailnet IP', () => {
  const self = parseTailscaleSelf(
    JSON.stringify({
      Self: { DNSName: 'mac.tailxyz.ts.net.', TailscaleIPs: ['fd7a:115c::1', '100.101.102.103'] },
    }),
  );
  assert.equal(self.dnsName, 'mac.tailxyz.ts.net'); // trailing dot stripped
  assert.equal(self.address, '100.101.102.103'); // IPv4 CGNAT preferred for the bind
});

test('§9.1: parseTailscaleSelf gives actionable errors for a down / unconfigured tailnet', () => {
  assert.throws(() => parseTailscaleSelf('not json'), /installed and running/);
  assert.throws(() => parseTailscaleSelf('{}'), /no Self node/);
  assert.throws(
    () => parseTailscaleSelf(JSON.stringify({ Self: { TailscaleIPs: ['100.1.1.1'] } })),
    /no MagicDNS name/,
  );
  assert.throws(
    () => parseTailscaleSelf(JSON.stringify({ Self: { DNSName: 'mac.ts.net.' } })),
    /no tailnet IP/,
  );
});

test('§9.1: resolveTailscaleCert finds <host>.crt/.key on disk and reads both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-cert-'));
  try {
    const host = 'mac.tailxyz.ts.net';
    writeFileSync(join(dir, `${host}.crt`), 'CERTBYTES');
    writeFileSync(join(dir, `${host}.key`), 'KEYBYTES');
    const { cert, key } = resolveTailscaleCert(host, [dir]);
    assert.equal(cert.toString(), 'CERTBYTES');
    assert.equal(key.toString(), 'KEYBYTES');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§9.1: resolveTailscaleCert honors an explicit --cert and derives its .key sibling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-cert-'));
  try {
    const crt = join(dir, 'custom.crt');
    writeFileSync(crt, 'C');
    writeFileSync(join(dir, 'custom.key'), 'K');
    const { cert, key } = resolveTailscaleCert('mac.tailxyz.ts.net', [], { certPath: crt });
    assert.equal(cert.toString(), 'C');
    assert.equal(key.toString(), 'K');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end HTTPS bind. Generated with `openssl` when present; skipped cleanly
// where it isn't (keeps the suite green everywhere while covering the https path
// + the MagicDNS Host-pin on the boxes that have openssl — CI/dev macOS/Linux).
test('§9.1: a tailnet-bound server serves HTTPS and pins the MagicDNS Host', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-tls-'));
  const HOST = 'mac.tailxyz.ts.net';
  const certPath = join(dir, 'tls.crt');
  const keyPath = join(dir, 'tls.key');
  try {
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath, '-out', certPath, '-days', '1',
          '-subj', `/CN=${HOST}`,
          '-addext', `subjectAltName=DNS:${HOST}`,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      t.skip('openssl not available to mint a test cert');
      return;
    }
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);

    // Bind the tailnet transport to loopback (no real tailnet in the test) but
    // keep the MagicDNS Host pin — exercises the exact §9.1 wiring.
    const tls = await startDevServer({
      root,
      origin: ORIGIN,
      token: TOKEN,
      port: 0,
      bind: { host: HOST, address: '127.0.0.1', cert, key },
    });
    try {
      const req = (headers) =>
        new Promise((resolve, reject) => {
          const r = https.request(
            {
              host: '127.0.0.1',
              port: tls.port,
              path: '/health',
              method: 'GET',
              headers,
              rejectUnauthorized: false, // self-signed test cert
            },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ status: res.statusCode, body }));
            },
          );
          r.on('error', reject);
          r.end();
        });

      // The MagicDNS Host on the accepting port + a valid token → 200 over TLS.
      const ok = await req({ Authorization: `Bearer ${TOKEN}`, Host: `${HOST}:${tls.port}` });
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.body), { ok: true, protocol: DEV_PROTOCOL_VERSION });

      // Loopback Host is no longer accepted under a tailnet bind (pin moved).
      const rebound = await req({
        Authorization: `Bearer ${TOKEN}`,
        Host: `localhost:${tls.port}`,
      });
      assert.equal(rebound.status, 403);
      assert.match(rebound.body, /host not allowed/);
    } finally {
      await tls.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wire contract with the host (immediately-run-site-main) ──────────────────
// `immediately.run dev --region` emits a deep link whose fragment the HOST parses
// in src/filesystem/localLocator.ts. The two repos deploy independently, so this
// is the seam that silently rots: the existing buildRegionDeepLink tests above
// assert the literal STRING, but a coordinated rename of a param on both the
// emitter and its own test would still break the host. This test parses the
// emitted link the way the host does and asserts the round-trip, so a divergence
// from the host's parser is caught here.
//
// The param names and the `local/<ns>/<repo>/<ref>` dev-source PATH form below are
// COPIED from the host's localLocator.ts and MUST stay in sync with it; the host's
// localLocator.test.ts asserts the parse half of this same contract
// (parseLocalLocator / parseDevRegionOverride / devSourceToBindingId).
const HOST_PARAM = {
  endpoint: 'ir-endpoint',
  token: 'ir-token',
  devRegion: 'ir-dev-region',
  devSource: 'ir-dev-source',
};

// Mirror of host devSourceToBindingId: local/<ns…>/<repo>/<ref> → local:<ns>/<repo>@<ref>.
const hostDevSourceToBindingId = (raw) => {
  const segs = raw.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segs.length < 4 || segs[0] !== 'local') return null;
  const [, ...rest] = segs;
  const ref = rest.pop();
  const repository = rest.pop();
  const namespace = rest.join('/');
  return namespace && repository && ref ? `local:${namespace}/${repository}@${ref}` : null;
};

// Mirror of how the host reads the fragment (parseLocalLocator + parseDevRegionOverride):
// endpoint is normalized to drop a trailing slash; the dev-source is converted to a
// canonical binding id.
const hostParse = (url) => {
  const p = new URLSearchParams(new URL(url).hash.replace(/^#/, ''));
  const endpoint = p.get(HOST_PARAM.endpoint);
  const source = p.get(HOST_PARAM.devSource);
  return {
    endpoint: endpoint ? endpoint.replace(/\/+$/, '') : null,
    token: p.get(HOST_PARAM.token),
    region: p.get(HOST_PARAM.devRegion),
    bindingId: source ? hostDevSourceToBindingId(source) : null,
  };
};

test('wire contract: the host parses the --region deep link the CLI emits (§6.8)', () => {
  const url = buildRegionDeepLink(
    'https://immediately.run',
    'local/proj-abcd1234/proj/live',
    'panel.editor',
    'http://127.0.0.1:7715',
    'sekret',
    'edit/github/acme/notes/main/',
  );
  // What the HOST extracts from the fragment must round-trip to the CLI's inputs.
  assert.deepEqual(hostParse(url), {
    endpoint: 'http://127.0.0.1:7715',
    token: 'sekret',
    region: 'panel.editor',
    bindingId: 'local:proj-abcd1234/proj@live',
  });
});

// ── System-app devtools `/debug` (plan: docs/plans/system-app-devtools.md) ──
// Read an SSE stream until `want` data events arrive, then abort. Origin omitted
// (token-bearing agent request — admitted by the §8 guard).
const readSse = (path, want) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path, method: 'GET' },
      (res) => {
        let buf = '';
        const got = [];
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) got.push(line.slice(6));
            }
            if (got.length >= want) {
              req.destroy();
              resolve(got.slice(0, want));
              return;
            }
          }
        });
      },
    );
    req.on('error', () => {}); // destroy after resolve surfaces here — ignore
    const t = setTimeout(() => {
      req.destroy();
      reject(new Error('sse timeout'));
    }, 3000);
    t.unref?.();
    req.end();
  });

test('/debug: POST a batch, then GET replays it (token-gated SSE)', async () => {
  const post = await authed('/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ kind: 'log', message: 'hello' }, { kind: 'trace', type: 'auth' }] }),
  });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ok: true, count: 2 });

  const events = (await readSse(`/debug?token=${TOKEN}&since=0`, 2)).map((l) => JSON.parse(l));
  assert.equal(events.length, 2);
  assert.equal(events[0].message, 'hello');
  assert.equal(events[0].seq, 1); // server stamps a monotonic seq
  assert.equal(events[1].type, 'auth');
});

test('/debug: GET ?since streams only newer entries', async () => {
  // Buffer now holds seq 1,2 from the prior test; add a third and read since=2.
  await authed('/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ message: 'third' }]),
  });
  const events = (await readSse(`/debug?token=${TOKEN}&since=2`, 1)).map((l) => JSON.parse(l));
  assert.equal(events[0].message, 'third');
  assert.equal(events[0].seq, 3);
});

test('/debug: rejects a non-array body', async () => {
  const res = await authed('/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
});

test('/debug: requires the token', async () => {
  assert.equal((await fetch(`${base}/debug`, { method: 'POST', body: '[]' })).status, 403);
});

test('/debug: OPTIONS preflight advertises POST + Content-Type + PNA (browser forwarder)', async () => {
  const res = await new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        path: '/debug',
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end();
  });
  assert.equal(res.status, 204);
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
});

// ── R3-77: dev LLM proxy config (--llm-* flags + IR_DEV_LLM_* env fallback) ──

test('resolveDevLlmConfig: null when no --llm-url / env (proxy stays off)', () => {
  assert.equal(resolveDevLlmConfig({}, {}), null);
});

test('resolveDevLlmConfig: builds the upstream + model from flags', () => {
  const cfg = resolveDevLlmConfig(
    { 'llm-url': 'https://openrouter.ai/api', 'llm-model': 'openai/gpt-4o-mini', 'llm-key': 'sk-TEST' },
    {},
  );
  assert.deepEqual(cfg, {
    upstream: { baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-TEST' },
    model: 'openai/gpt-4o-mini',
  });
});

test('resolveDevLlmConfig: env vars are the fallback (CI needs no flags)', () => {
  const cfg = resolveDevLlmConfig(
    {},
    { IR_DEV_LLM_URL: 'http://127.0.0.1:11434', IR_DEV_LLM_MODEL: 'llama3' },
  );
  // A local model needs no key.
  assert.deepEqual(cfg, { upstream: { baseUrl: 'http://127.0.0.1:11434' }, model: 'llama3' });
});

test('resolveDevLlmConfig: flags win over env', () => {
  const cfg = resolveDevLlmConfig(
    { 'llm-url': 'http://127.0.0.1:9999', 'llm-model': 'flag-model' },
    { IR_DEV_LLM_URL: 'http://127.0.0.1:11434', IR_DEV_LLM_MODEL: 'env-model' },
  );
  assert.equal(cfg.upstream.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(cfg.model, 'flag-model');
});

test('resolveDevLlmConfig: --llm-url without a model is rejected', () => {
  assert.throws(
    () => resolveDevLlmConfig({ 'llm-url': 'http://127.0.0.1:11434' }, {}),
    /requires --llm-model/,
  );
});

test('resolveDevLlmConfig: a non-http(s) --llm-url is rejected', () => {
  assert.throws(
    () => resolveDevLlmConfig({ 'llm-url': 'ftp://x', 'llm-model': 'm' }, {}),
    /Invalid --llm-url/,
  );
});

test('resolveDevLlmConfig: custom auth header/scheme pass through (incl. raw)', () => {
  const cfg = resolveDevLlmConfig(
    {
      'llm-url': 'https://gw.example',
      'llm-model': 'm',
      'llm-key': 'k',
      'llm-auth-header': 'x-api-key',
      'llm-auth-scheme': '',
    },
    {},
  );
  assert.equal(cfg.upstream.authHeader, 'x-api-key');
  assert.equal(cfg.upstream.authScheme, '');
});
