// Tests for `immediately-run dev` (the localhost provider server). Runs against
// the compiled dist/ (`npm test` builds first), so it exercises exactly what
// ships. Uses node:test — no test-framework dependency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { startDevServer, listWorkingTreeFiles, resolveSafe, isAllowedHost } from '../dist/devServer.js';
import { sanitizeProjectName, buildDeepLink } from '../dist/commands/dev.js';

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

test('unit: buildDeepLink shape', () => {
  const url = buildDeepLink('http://localhost:3000/', 'proj', 7700, 'tok');
  assert.equal(
    url,
    'http://localhost:3000/edit/local/proj/proj/live#ir-endpoint=http%3A%2F%2F127.0.0.1%3A7700&ir-token=tok',
  );
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
