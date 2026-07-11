// Tests for the `immediately.run llm` proxy (R3-77 / P3-75; LLM_AND_AGENTS_SPEC
// §2.4, D3). The §9 D3 exit — NOT an open relay — is proven both as a pure unit
// (resolveUpstreamTarget pins to the configured origin) and end-to-end against a
// live fake upstream on the real dev server, alongside the T25 negative space
// (no token / wrong Origin / rebound Host) inherited from the shared guard chain.
// Runs against compiled dist/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { startDevServer } from '../dist/devServer.js';
import { resolveUpstreamTarget, buildUpstreamHeaders } from '../dist/llmProxy.js';

// --- unit: the not-an-open-relay pin ----------------------------------------

test('resolveUpstreamTarget pins a subpath under the configured upstream', () => {
  const r = resolveUpstreamTarget('http://127.0.0.1:11434', '/llm/v1/chat/completions', '');
  assert.deepEqual(r, { ok: true, url: 'http://127.0.0.1:11434/v1/chat/completions' });
});

test('resolveUpstreamTarget preserves a base path prefix and the query string', () => {
  const r = resolveUpstreamTarget('https://gw.example/openai', '/llm/v1/models', '?stream=true');
  assert.deepEqual(r, { ok: true, url: 'https://gw.example/openai/v1/models?stream=true' });
});

test('resolveUpstreamTarget REFUSES a caller-supplied absolute target (open relay)', () => {
  const r = resolveUpstreamTarget('http://127.0.0.1:11434', '/llm/http://evil.example/x', '');
  assert.equal(r.ok, false);
});

test('resolveUpstreamTarget REFUSES a protocol-relative //host target', () => {
  const r = resolveUpstreamTarget('http://127.0.0.1:11434', '/llm//evil.example/x', '');
  assert.equal(r.ok, false);
});

test('resolveUpstreamTarget REFUSES backslash/NUL and non-/llm routes', () => {
  assert.equal(resolveUpstreamTarget('http://127.0.0.1:11434', '/llm/a\\b', '').ok, false);
  assert.equal(resolveUpstreamTarget('http://127.0.0.1:11434', '/agent/x', '').ok, false);
});

// --- unit: server-side key injection ----------------------------------------

test('buildUpstreamHeaders injects the key and drops the caller credential', () => {
  const h = buildUpstreamHeaders(
    { 'content-type': 'application/json', accept: 'text/event-stream', authorization: 'Bearer localhost-token', host: 'x', origin: 'y', cookie: 'c=1' },
    { baseUrl: 'http://127.0.0.1:11434', apiKey: 'secret-key' },
  );
  assert.equal(h['authorization'], 'Bearer secret-key'); // injected, not the caller's token
  assert.equal(h['content-type'], 'application/json'); // safe header forwarded
  assert.equal(h['accept'], 'text/event-stream');
  assert.equal(h['host'], undefined); // caller host/origin/cookie dropped
  assert.equal(h['origin'], undefined);
  assert.equal(h['cookie'], undefined);
});

test('buildUpstreamHeaders honors a raw scheme + custom header (x-api-key)', () => {
  const h = buildUpstreamHeaders({}, { baseUrl: 'http://x', apiKey: 'k', authHeader: 'x-api-key', authScheme: '' });
  assert.equal(h['x-api-key'], 'k');
  assert.equal(h['authorization'], undefined);
});

// --- integration: live proxy against a fake upstream ------------------------

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'llm-token-xyz';
const KEY = 'sk-secret-key';

let root;
let handle;
let base;
let upstream;
let upstreamBase;
let reqs;

before(async () => {
  reqs = [];
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reqs.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  root = mkdtempSync(join(tmpdir(), 'ir-llm-test-'));
  writeFileSync(join(root, 'a.txt'), 'hi\n');
  handle = await startDevServer({
    root,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    llm: { baseUrl: upstreamBase, apiKey: KEY },
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  await new Promise((r) => upstream.close(r));
  rmSync(root, { recursive: true, force: true });
});

const rawPost = (path, headers, body = '{}') =>
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

test('forwards to the pinned upstream with the key injected server-side', async () => {
  const before = reqs.length;
  const res = await fetch(`${base}/llm/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ model: 'llama3', messages: [] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true); // streamed straight back from the upstream

  assert.equal(reqs.length, before + 1);
  const u = reqs[reqs.length - 1];
  assert.equal(u.url, '/v1/chat/completions'); // pinned path
  assert.equal(u.headers['authorization'], `Bearer ${KEY}`); // injected key, NOT the localhost token
  assert.notEqual(u.headers['authorization'], `Bearer ${TOKEN}`);
  assert.match(u.body, /llama3/); // body forwarded verbatim
});

test('R3-224: a caller disconnect mid-stream aborts the upstream request (stop billing)', async () => {
  // A streaming upstream that emits one chunk then STALLS forever — it only ends
  // when its inbound connection is torn down. It records that teardown.
  let upstreamAborted = false;
  const streamer = http.createServer((sreq, sres) => {
    sreq.on('close', () => {
      if (!sres.writableFinished) upstreamAborted = true;
    });
    sres.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sres.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    // deliberately never end → the completion "keeps generating/billing" until aborted
  });
  await new Promise((r) => streamer.listen(0, '127.0.0.1', r));
  const streamerBase = `http://127.0.0.1:${streamer.address().port}`;
  const h = await startDevServer({
    root,
    origin: ORIGIN,
    token: TOKEN,
    port: 0,
    llm: { baseUrl: streamerBase, apiKey: KEY },
  });
  try {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/llm/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    await reader.read(); // pull the first streamed token
    ac.abort(); // the app hit stop → the host aborts its fetch to the proxy
    // Poll (bounded) for the proxy to observe the client close and tear the upstream down.
    for (let i = 0; i < 50 && !upstreamAborted; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(upstreamAborted, true, 'the proxy must abort its upstream provider request on a caller disconnect');
  } finally {
    await h.close();
    await new Promise((r) => streamer.close(r));
  }
});

test('not an open relay: a caller-supplied target is refused, upstream untouched', async () => {
  const before = reqs.length;
  const res = await fetch(`${base}/llm//evil.example/v1/x`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN },
    body: '{}',
  });
  assert.equal(res.status, 403);
  assert.equal(reqs.length, before); // the upstream was never hit
});

test('T25: no token → 403; wrong Origin → 403; rebound Host → 403', async () => {
  const noTok = await fetch(`${base}/llm/v1/x`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: '{}',
  });
  assert.equal(noTok.status, 403);

  const badOrigin = await fetch(`${base}/llm/v1/x`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(badOrigin.status, 403);

  const rebound = await rawPost('/llm/v1/x', {
    Host: 'attacker.example',
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body, /host not allowed/);
});

test('without an llm upstream, POST /llm is method-not-allowed (read-only stance)', async () => {
  const plainRoot = mkdtempSync(join(tmpdir(), 'ir-llm-plain-'));
  const plain = await startDevServer({ root: plainRoot, origin: ORIGIN, token: TOKEN, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${plain.port}/llm/v1/x`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{}',
    });
    assert.equal(res.status, 405);
  } finally {
    await plain.close();
    rmSync(plainRoot, { recursive: true, force: true });
  }
});

// ── The pairing deep link carries the routing flag + optional model override ──
import { buildLlmDeepLink } from '../dist/commands/llm.js';

test('buildLlmDeepLink: carries ir-transport=llm and the endpoint+token (no model)', () => {
  const url = buildLlmDeepLink('https://immediately.run', 7700, 'tok');
  assert.match(url, /#ir-endpoint=http%3A%2F%2F127\.0\.0\.1%3A7700/);
  assert.match(url, /&ir-token=tok/);
  assert.match(url, /&ir-transport=llm/);
  assert.doesNotMatch(url, /ir-llm-model/);
});

test('buildLlmDeepLink: appends ir-llm-model when a model is given', () => {
  const url = buildLlmDeepLink('https://immediately.run', 7700, 'tok', 'openai/gpt-4o-mini');
  assert.match(url, /&ir-transport=llm&ir-llm-model=openai%2Fgpt-4o-mini/);
});
