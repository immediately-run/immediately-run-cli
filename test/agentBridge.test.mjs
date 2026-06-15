// Adversarial + functional tests for the authenticated agent-bridge endpoints on
// the localhost dev server (R3-76 / LOCAL_DEV_AUTHED_SERVER_SPEC §4, §6). The
// T25 negative space — no token, wrong Origin, Origin: null (only the kernel
// connects), rebound Host — is proven against the NEW POST/SSE routes, not just
// the read routes. Runs against compiled dist/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { startDevServer } from '../dist/devServer.js';
import { AgentBridge } from '../dist/bridge.js';

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'bridge-token-xyz';

let root;
let handle;
let bridge;
let base;

const authedPost = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// Raw client so we can set Host (fetch/undici forbids it).
const rawPost = (path, headers = {}, body = '{}') =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path, method: 'POST', headers },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ir-agent-test-'));
  writeFileSync(join(root, 'a.txt'), 'hi\n');
  bridge = new AgentBridge();
  handle = await startDevServer({ root, origin: ORIGIN, token: TOKEN, port: 0, bridge });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  rmSync(root, { recursive: true, force: true });
});

// --- T25 negative space on the bridge routes --------------------------------

test('drive-by: POST /agent/result with no token → 403', async () => {
  const res = await fetch(`${base}/agent/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('drive-by: a wrong Origin → 403 even with a valid token', async () => {
  const res = await authedPost('/agent/catalog', [], { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('only the kernel connects: an opaque-origin iframe forcing Origin: null → refused', async () => {
  // A sandboxed app iframe has an opaque origin and sends `Origin: null`; it is
  // not the host kernel's allowed origin, so the bridge refuses it.
  const res = await rawPost(
    '/agent/catalog',
    { Host: `127.0.0.1:${handle.port}`, Authorization: `Bearer ${TOKEN}`, Origin: 'null', 'Content-Type': 'application/json' },
    '[]',
  );
  assert.equal(res.status, 403);
  assert.match(res.body, /origin not allowed/);
});

test('only the kernel connects: SSE /agent/pending with no token → 403', async () => {
  const res = await fetch(`${base}/agent/pending`);
  assert.equal(res.status, 403);
});

test('LD-1: a rebound Host is rejected on the bridge route even with a valid token', async () => {
  const res = await rawPost('/agent/result', {
    Host: 'attacker.example',
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /host not allowed/);
});

// --- functional round-trip ---------------------------------------------------

test('POST /agent/catalog publishes the grant-filtered catalog', async () => {
  const res = await authedPost('/agent/catalog', { catalog: [{ name: 'spaces:read' }] }, { Origin: ORIGIN });
  assert.equal(res.status, 200);
  assert.deepEqual(bridge.getCatalog(), [{ name: 'spaces:read' }]);
});

test('POST /agent/result resolves an in-flight call; the SSE delivered it', async () => {
  // Enqueue a call; the dev server's /agent/pending SSE must deliver it to a
  // connected (token-bearing) subscriber, then /agent/result resolves it.
  const callP = bridge.enqueueCall('spaces:read', { path: '/a.txt' });

  // Connect to the SSE as the kernel would (query-param token, like EventSource).
  const sse = await fetch(`${base}/agent/pending?token=${TOKEN}`, { headers: { Origin: ORIGIN } });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const call = JSON.parse(dataLine.slice('data: '.length));
  assert.equal(call.tool, 'spaces:read');
  assert.deepEqual(call.params, { path: '/a.txt' });

  const res = await authedPost('/agent/result', { callId: call.callId, result: 'file body' }, { Origin: ORIGIN });
  assert.equal(res.status, 200);
  assert.deepEqual(await callP, { result: 'file body' });
  await reader.cancel();
});

test('POST /agent/result with an unknown callId → 404', async () => {
  const res = await authedPost('/agent/result', { callId: 'ghost', result: 1 }, { Origin: ORIGIN });
  assert.equal(res.status, 404);
});

test('OPTIONS preflight advertises POST + Content-Type when the bridge is enabled', async () => {
  const res = await fetch(`${base}/agent/result`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/);
});

// --- the bridge stays off on a plain (read-only) dev server ------------------

test('without a bridge, /agent/* routes do not exist and POST is refused', async () => {
  const plainRoot = mkdtempSync(join(tmpdir(), 'ir-plain-test-'));
  const plain = await startDevServer({ root: plainRoot, origin: ORIGIN, token: TOKEN, port: 0 });
  const pbase = `http://127.0.0.1:${plain.port}`;
  try {
    // POST is method-not-allowed (read-only server stays GET-only).
    const post = await fetch(`${pbase}/agent/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 405);
    // The SSE route 404s rather than streaming.
    const sse = await fetch(`${pbase}/agent/pending?token=${TOKEN}`, { headers: { Origin: ORIGIN } });
    assert.equal(sse.status, 404);
    // Preflight advertises GET only.
    const opt = await fetch(`${pbase}/agent/result`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });
    assert.doesNotMatch(opt.headers.get('access-control-allow-methods') ?? '', /POST/);
  } finally {
    await plain.close();
    rmSync(plainRoot, { recursive: true, force: true });
  }
});
