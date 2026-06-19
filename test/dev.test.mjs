// Tests for `immediately.run dev` (the localhost provider server). Runs against
// the compiled dist/ (`npm test` builds first), so it exercises exactly what
// ships. Uses node:test — no test-framework dependency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import {
  startDevServer,
  listWorkingTreeFiles,
  resolveSafe,
  isAllowedHost,
  DEV_PROTOCOL_VERSION,
} from '../dist/devServer.js';
import {
  sanitizeProjectName,
  buildDeepLink,
  realpathHash8,
  isRecognizedOrigin,
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
  const url = buildDeepLink('http://localhost:3000/', 'proj-abcd1234', 'proj', 7700, 'tok');
  assert.equal(
    url,
    'http://localhost:3000/edit/local/proj-abcd1234/proj/live#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7700&ir-token=tok',
  );
});

// --- LD2-1: realpath-hash cowName disambiguator (the §6.2 exit criterion) ---

test('LD2-1: two same-named checkouts get distinct overlay identities; same realpath is stable', () => {
  // Two checkouts that share the basename `my-app` at DIFFERENT paths.
  const a = mkdtempSync(join(tmpdir(), 'ir-cow-a-'));
  const b = mkdtempSync(join(tmpdir(), 'ir-cow-b-'));
  try {
    mkdirSync(join(a, 'my-app'));
    mkdirSync(join(b, 'my-app'));
    const ha = realpathHash8(join(a, 'my-app'));
    const hb = realpathHash8(join(b, 'my-app'));
    assert.match(ha, /^[0-9a-f]{8}$/);
    // Distinct checkouts → distinct hash → distinct namespace → distinct overlay
    // (the cross-checkout contamination LD2-1 closes).
    assert.notEqual(ha, hb);
    // Reconnect semantics: the SAME realpath always yields the SAME hash, so the
    // overlay + journal reattach across server restarts / new tokens / new ports.
    assert.equal(realpathHash8(join(a, 'my-app')), ha);
    // The host keys on the namespace segment, which now differs for the two:
    const nsA = `my-app-${ha}`;
    const nsB = `my-app-${hb}`;
    assert.notEqual(
      buildDeepLink('https://immediately.run', nsA, 'my-app', 1, 't'),
      buildDeepLink('https://immediately.run', nsB, 'my-app', 1, 't'),
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
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
