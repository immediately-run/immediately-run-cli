// G-GS-11 — pairing codes and connection tokens (GIT_SERVE_SPEC §10.2 R-GS-24;
// roadmap R3-1360). Runs against the compiled dist/.
//
// The server is started through its programmatic entry in the tailnet
// configuration, listening on loopback with an injected `whois`, so no test
// needs a tailnet. The pairing code is minted by the same function the
// `git-serve pair` command calls, and by the built CLI itself in the CLI cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { startGitServe } from '../dist/gitServe/server.js';
import {
  createPairingCode,
  exchangePairingCode,
  normalizeCode,
} from '../dist/gitServe/pairing.js';
import {
  addConnection,
  connectionLookup,
  readConnections,
  revokeConnection,
} from '../dist/gitServe/connections.js';
import { gitServeNamespace } from '../dist/gitServe/namespace.js';
import { parseTailnetIdentity, parseWhois } from '../dist/gitServe/tailscaleWhois.js';
import { GIT_SERVE_PROTOCOL, GIT_SERVE_SERVER } from '../dist/gitServe/protocol.js';
import { runGitServeInit } from '../dist/commands/gitServe.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/tailscale-whois/', import.meta.url));
const identity = parseTailnetIdentity(readFileSync(join(FIXTURES, 'status.json'), 'utf8'));
const sameUser = parseWhois(0, readFileSync(join(FIXTURES, 'same-user.json'), 'utf8'), '');

const HOST = 'serving-node.example-tailnet.ts.net';
const ORIGIN = 'https://local.immediately.run';
const MEDIATOR = 'https://staging-immediately-run-devbridge.web.app';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

let tmp;
const freshRoot = (name) => {
  const root = join(tmp, name);
  runGitServeInit(root, 'notes');
  return root;
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ir-git-serve-pair-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Start the tailnet configuration on loopback. `clock.t` is the server's time. */
const start = async (root, clock = { t: Date.now() }, whois = async () => sameUser) => {
  const logs = [];
  const handle = await startGitServe({
    root,
    origin: ORIGIN,
    port: 0,
    now: () => clock.t,
    log: (line) => logs.push(line),
    tailnet: {
      host: HOST,
      address: '127.0.0.1',
      peerGate: { self: identity.self, allowUserIds: new Set(), whois },
    },
  });
  const request = (path, { method = 'GET', bearer, headers = {}, localAddress } = {}) =>
    new Promise((resolvePromise, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path,
          method,
          ...(localAddress ? { localAddress } : {}),
          headers: {
            Host: `${HOST}:${handle.port}`,
            Origin: MEDIATOR,
            ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try {
              body = JSON.parse(text);
            } catch {
              /* not JSON */
            }
            resolvePromise({ status: res.statusCode, headers: res.headers, text, body });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  const pair = (code, extra) => request('/pair', { method: 'POST', bearer: code, ...extra });
  return { handle, logs, request, pair, clock };
};

test('G-GS-11: a code is exchanged once for a token, and the token then reads', async () => {
  const root = freshRoot('once');
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'read', s.clock.t);
    assert.match(code, CODE_RE);
    const res = await s.pair(code);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['connectionId', 'namespace', 'protocol', 'scope', 'server', 'token']);
    assert.equal(res.body.server, GIT_SERVE_SERVER);
    assert.equal(res.body.protocol, GIT_SERVE_PROTOCOL);
    assert.equal(res.body.scope, 'read');
    assert.ok(Buffer.from(res.body.token, 'base64url').length >= 32, 'a token of at least 256 bits');
    // The namespace is the tailnet one, over the lowercase origin with its port.
    assert.equal(res.body.namespace, gitServeNamespace({ kind: 'tailnet', origin: `https://${HOST}:${s.handle.port}` }));
    assert.equal(res.body.namespace, s.handle.namespace);
    assert.match(res.body.namespace, /^serving-node-[0-9a-f]{20}$/);
    // The token reads.
    const meta = await s.request('/meta', { bearer: res.body.token });
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.repos, ['notes']);
    // Success killed the code: the same code again fails, and so does the code as a token.
    assert.equal((await s.pair(code)).status, 401);
    assert.equal((await s.pair(code)).body.reason, 'code');
    assert.equal((await s.request('/meta', { bearer: normalizeCode(code) })).status, 401);
    assert.equal(existsSync(join(root, '.git-serve', 'pairing.json')), false);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: the code is accepted as typed — lower case, with or without the dash', async () => {
  for (const typed of [(c) => c.toLowerCase(), (c) => c.replace('-', ''), (c) => c]) {
    const root = freshRoot(`typed-${Math.random().toString(36).slice(2)}`);
    const s = await start(root);
    try {
      const { code } = createPairingCode(root, 'read', s.clock.t);
      assert.equal((await s.pair(typed(code))).status, 200);
    } finally {
      await s.handle.close();
    }
  }
});

test('G-GS-11: the fifth failure kills the code, though the failures come from different addresses', async (t) => {
  const root = freshRoot('five');
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'read', s.clock.t);
    const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    // Two source addresses where the platform has them (Linux routes all of 127/8).
    const sources = process.platform === 'linux' ? ['127.0.0.1', '127.0.0.2', '127.0.0.3'] : [undefined];
    if (sources.length === 1) t.diagnostic('one loopback address on this platform: the count is still global, by the file');
    // Five, as R-GS-24 states it; the literal is the spec's, not read from the code.
    for (let i = 0; i < 5; i++) {
      const res = await s.pair(wrong, { localAddress: sources[i % sources.length] });
      assert.equal(res.status, 401, `failure ${i + 1}`);
    }
    if (sources.length > 1) {
      const seen = new Set(s.logs.filter((l) => l.includes('(code)')).map((l) => l.split(' from ')[1]));
      assert.ok(seen.size >= 2, `the failures came from ${[...seen].join(', ')}`);
    }
    // The right code is now dead.
    assert.equal((await s.pair(code)).status, 401);
    assert.equal(readConnections(root).length, 0);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: four failures leave the code alive; the count is kept across them', async () => {
  const root = freshRoot('four');
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'write', s.clock.t);
    for (let i = 0; i < 4; i++) assert.equal((await s.pair('ZZZZ-ZZZZ')).status, 401);
    assert.equal(JSON.parse(readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8')).failures, 4);
    const res = await s.pair(code);
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'write', 'the scope is the one `pair` was given');
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: a request the peer gate refuses never reaches the code — no failure is counted against it', async () => {
  const root = freshRoot('gate-first');
  const failures = () => JSON.parse(readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8')).failures;
  // A peer the daemon does not know.
  const refused = await start(root, undefined, async () => ({ kind: 'unknown' }));
  let code;
  try {
    ({ code } = createPairingCode(root, 'read', refused.clock.t));
    // More wrong guesses than the code survives, and the right code too.
    for (const presented of ['ZZZZ-ZZZZ', 'YYYY-YYYY', 'XXXX-XXXX', 'WWWW-WWWW', 'VVVV-VVVV', 'TTTT-TTTT', code]) {
      const res = await refused.pair(presented);
      assert.equal(res.status, 403, presented === code ? 'the right code' : presented);
      assert.equal(res.body.reason, 'unknown-peer');
      assert.equal(res.body.token, undefined);
    }
    assert.equal(failures(), 0, 'the count is unchanged');
    assert.equal(readConnections(root).length, 0);
  } finally {
    await refused.handle.close();
  }
  // The code is alive and unspent: an admitted peer exchanges it.
  const s = await start(root, refused.clock);
  try {
    assert.equal((await s.pair(code)).status, 200);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: a code older than ten minutes fails', async () => {
  const root = freshRoot('old');
  const clock = { t: 1_800_000_000_000 };
  const s = await start(root, clock);
  try {
    const { code, expiresAt } = createPairingCode(root, 'read', clock.t);
    const TEN_MINUTES = 10 * 60 * 1000; // R-GS-24's number, not read from the code
    assert.equal(expiresAt, clock.t + TEN_MINUTES);
    clock.t += TEN_MINUTES; // exactly ten minutes later: dead
    assert.equal((await s.pair(code)).status, 401);
    assert.equal(existsSync(join(root, '.git-serve', 'pairing.json')), false, 'an expired code is removed');
    // One millisecond before the limit it would have worked.
    const again = createPairingCode(root, 'read', clock.t);
    clock.t += TEN_MINUTES - 1;
    assert.equal((await s.pair(again.code)).status, 200);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: minting a new code kills the old one', async () => {
  const root = freshRoot('remint');
  const s = await start(root);
  try {
    const first = createPairingCode(root, 'read', s.clock.t);
    const second = createPairingCode(root, 'read', s.clock.t);
    assert.notEqual(first.code, second.code);
    assert.equal((await s.pair(first.code)).status, 401);
    assert.equal((await s.pair(second.code)).status, 200);
  } finally {
    await s.handle.close();
  }
});

test('G-GS-11: a revoked token fails on its next request', async () => {
  const root = freshRoot('revoke');
  const s = await start(root);
  try {
    const a = (await s.pair(createPairingCode(root, 'read', s.clock.t).code)).body;
    const b = (await s.pair(createPairingCode(root, 'read', s.clock.t).code)).body;
    assert.equal((await s.request('/meta', { bearer: a.token })).status, 200);
    assert.equal((await s.request('/meta', { bearer: b.token })).status, 200);
    // Revocation is what `git-serve connections --revoke` does, from another process.
    execFileSync(process.execPath, [CLI_ENTRY, 'git-serve', 'connections', root, '--revoke', a.connectionId], { stdio: 'pipe' });
    const refused = await s.request('/meta', { bearer: a.token });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.reason, 'token');
    assert.equal((await s.request('/meta', { bearer: b.token })).status, 200, 'the other connection is untouched');
  } finally {
    await s.handle.close();
  }
});

test('R-GS-24: the token is stored hashed, the state files are 0600, and nothing prints a credential', async () => {
  const root = freshRoot('hashed');
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'read', s.clock.t);
    const pairingOnDisk = readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8');
    assert.ok(!pairingOnDisk.includes(normalizeCode(code)), 'the code is stored as a hash');
    const res = await s.pair(code);
    await s.request('/meta', { bearer: res.body.token });
    await s.request('/meta', { bearer: 'wrong-token' });
    const stateDir = join(root, '.git-serve');
    for (const name of readdirSync(stateDir)) {
      const content = readFileSync(join(stateDir, name), 'utf8');
      assert.ok(!content.includes(res.body.token), `${name} must not hold the token`);
      assert.equal(statSync(join(stateDir, name)).mode & 0o777, 0o600, name);
    }
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    const stored = readConnections(root);
    assert.deepEqual(Object.keys(stored[0]).sort(), ['createdAt', 'id', 'scope', 'tokenHash']);
    for (const line of s.logs) {
      assert.ok(!line.includes(res.body.token) && !line.includes(normalizeCode(code)) && !line.includes('wrong-token'), line);
    }
  } finally {
    await s.handle.close();
  }
});

test('§10.1 on a tailnet: /pair is POST, needs the Origin, answers preflight without a code', async () => {
  const root = freshRoot('pair-guards');
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'read', s.clock.t);
    assert.equal((await s.request('/pair', { method: 'GET', bearer: code })).status, 405);
    assert.equal((await s.request('/pair', { method: 'POST', bearer: code, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.request(`/pair?token=${normalizeCode(code)}`, { method: 'POST' })).status, 401);
    const preflight = await s.request('/pair', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-methods'], 'POST');
    // None of those spent the code or counted as a failure.
    assert.equal(JSON.parse(readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8')).failures, 0);
    assert.equal((await s.pair(code)).status, 200);
  } finally {
    await s.handle.close();
  }
});

test('R-GS-17: on loopback there are no connections — /pair does not exist', async () => {
  const root = freshRoot('loopback');
  createPairingCode(root, 'read');
  const handle = await startGitServe({ root, origin: ORIGIN, token: 'session', port: 0, log: () => {} });
  try {
    const res = await new Promise((resolvePromise, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path: '/pair', method: 'POST', headers: { Origin: MEDIATOR, Authorization: 'Bearer session' } },
        (r) => r.resume().on('end', () => resolvePromise(r.statusCode)),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res, 404);
  } finally {
    await handle.close();
  }
});

// --- the stores, without a server -------------------------------------------

test('unit: exchangePairingCode — no code, a dead code and a wrong code are one answer', () => {
  const root = freshRoot('unit');
  assert.deepEqual(exchangePairingCode(root, 'AAAA-AAAA'), { ok: false });
  const { code } = createPairingCode(root, 'read', 1000);
  assert.deepEqual(exchangePairingCode(root, 'AAAA-AAA0', 1000), { ok: false });
  const made = exchangePairingCode(root, code, 1000);
  assert.equal(made.ok, true);
  assert.equal(made.record.createdAt, new Date(1000).toISOString());
  assert.deepEqual(exchangePairingCode(root, code, 1000), { ok: false });
});

test('unit: a new code starts with a clean count and replaces the old one', () => {
  const root = freshRoot('race');
  const first = createPairingCode(root, 'read', 1000);
  // Three failures recorded against the first code.
  for (let i = 0; i < 3; i++) exchangePairingCode(root, 'ZZZZ-ZZZZ', 1000);
  const second = createPairingCode(root, 'read', 1000);
  assert.equal(JSON.parse(readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8')).failures, 0, 'a new code starts at zero');
  assert.equal(exchangePairingCode(root, first.code, 1000).ok, false);
  assert.equal(exchangePairingCode(root, second.code, 1000).ok, true);
});

test('unit: connectionLookup sees a rewrite at once, and an unreadable file authorizes nobody', () => {
  const root = freshRoot('lookup');
  const lookup = connectionLookup(root);
  assert.equal(lookup.find('anything'), null);
  const a = addConnection(root, 'read');
  const b = addConnection(root, 'write');
  assert.equal(lookup.find(a.token).id, a.record.id);
  assert.equal(lookup.find(b.token).scope, 'write');
  assert.equal(revokeConnection(root, a.record.id), true);
  assert.equal(lookup.find(a.token), null);
  assert.equal(lookup.find(b.token).id, b.record.id);
  assert.equal(revokeConnection(root, 'no-such-id'), false);
  // The stored hash is not a credential.
  assert.equal(lookup.find(b.record.tokenHash), null);
  execFileSync('sh', ['-c', `printf 'not json' > "${join(root, '.git-serve', 'connections.json')}"`]);
  assert.equal(lookup.find(b.token), null);
});

test('the state lock: a revocation and a pairing in two processes never undo each other', async () => {
  const root = freshRoot('lock');
  const seeded = Array.from({ length: 40 }, () => addConnection(root, 'read').record.id);
  // Another process revokes the seeded connections, as `connections --revoke` does…
  const child = `
    import { revokeConnection } from ${JSON.stringify(new URL('../dist/gitServe/connections.js', import.meta.url).href)};
    const out = [];
    for (const id of ${JSON.stringify(seeded)}) if (revokeConnection(${JSON.stringify(root)}, id)) out.push(id);
    console.log(JSON.stringify(out));
  `;
  const revoking = new Promise((resolvePromise, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolvePromise(JSON.parse(stdout)),
    );
  });
  // …while this one adds, as the server does on /pair.
  const added = [];
  for (let i = 0; i < 300; i++) {
    added.push(addConnection(root, 'write').record.id);
    if (i % 10 === 0) await new Promise((r) => setImmediate(r));
  }
  const revoked = await revoking;
  assert.equal(revoked.length, seeded.length, 'every revoke found its connection');
  const left = new Set(readConnections(root).map((c) => c.id));
  for (const id of revoked) assert.ok(!left.has(id), `revoked ${id} is back`);
  for (const id of added) assert.ok(left.has(id), `added ${id} was lost`);
  assert.equal(existsSync(join(root, '.git-serve', '.lock')), false, 'the lock is released');
});

const CONNECTIONS_URL = new URL('../dist/gitServe/connections.js', import.meta.url).href;

/** Runs `source` as a module in another node process; resolves with its stdout, parsed. */
const inChild = (source, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', source, ...args], { encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(new Error(`${error.message}\n${stderr}`)) : resolvePromise(JSON.parse(stdout)),
    );
  });

test('the state lock: a lock left by a dead process is taken over', () => {
  const root = freshRoot('stale-lock');
  const lock = join(root, '.git-serve', '.lock');
  addConnection(root, 'read');
  writeFileSync(lock, '');
  utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(addConnection(root, 'read').record.scope, 'read');
  assert.equal(readConnections(root).length, 2);
  assert.deepEqual(readdirSync(join(root, '.git-serve')).filter((n) => n.startsWith('.lock')), [], 'no lock and no takeover file is left');
});

test('the state lock: processes that meet at a dead process\'s lock are never inside together', async () => {
  const root = freshRoot('stale-race');
  const lock = join(root, '.git-serve', '.lock');
  const signals = join(tmp, 'stale-race-signals');
  mkdirSync(signals);
  addConnection(root, 'read'); // makes the state directory
  const CHILDREN = 4;
  // Each child waits (spinning, so that all of them start within microseconds)
  // for the round's signal, then takes the lock the way the commands do. Inside
  // it, it creates one marker file exclusively: if the file is already there,
  // another process is inside at the same time.
  const child = `
    import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
    import { withStateLock } from ${JSON.stringify(CONNECTIONS_URL)};
    const [root, signals, me] = process.argv.slice(1);
    const inside = signals + '/inside';
    const report = { rounds: 0, overlaps: 0, errors: [] };
    for (let round = 0; ; round++) {
      while (!existsSync(signals + '/go-' + round)) {
        if (existsSync(signals + '/stop')) {
          console.log(JSON.stringify(report));
          process.exit(0);
        }
      }
      try {
        withStateLock(root, () => {
          try {
            closeSync(openSync(inside, 'wx'));
          } catch {
            report.overlaps++;
            return;
          }
          const until = performance.now() + 1;
          while (performance.now() < until);
          rmSync(inside);
        });
      } catch (e) {
        report.errors.push(String(e));
      }
      report.rounds++;
      writeFileSync(signals + '/done-' + round + '-' + me, '');
    }
  `;
  const children = Array.from({ length: CHILDREN }, (_, i) => inChild(child, [root, signals, String(i)]));
  const long = new Date(Date.now() - 60_000);
  const deadline = Date.now() + 5000;
  let rounds = 0;
  try {
    for (; rounds < 400 && Date.now() < deadline; rounds++) {
      // The lock of a process that died a minute ago; then everyone goes.
      writeFileSync(lock, '');
      utimesSync(lock, long, long);
      writeFileSync(join(signals, `go-${rounds}`), '');
      const finished = () => Array.from({ length: CHILDREN }, (_, i) => existsSync(join(signals, `done-${rounds}-${i}`))).every(Boolean);
      while (!finished()) {
        assert.ok(Date.now() < deadline + 20_000, `round ${rounds} did not finish`);
        await new Promise((r) => setImmediate(r));
      }
    }
  } finally {
    writeFileSync(join(signals, 'stop'), '');
  }
  const reports = await Promise.all(children);
  assert.ok(rounds >= 40, `only ${rounds} rounds ran`);
  for (const [i, report] of reports.entries()) {
    assert.deepEqual(report.errors, [], `child ${i}`);
    assert.equal(report.rounds, rounds, `child ${i} took the lock in every round`);
  }
  assert.equal(reports.reduce((n, r) => n + r.overlaps, 0), 0, `two processes were inside together (in ${rounds} rounds)`);
  assert.deepEqual(readdirSync(join(root, '.git-serve')).filter((n) => n.startsWith('.lock')), [], 'no lock and no takeover file is left');
});

test('the state lock: a live lock is waited for by the commands', async () => {
  const root = freshRoot('live-lock');
  const lock = join(root, '.git-serve', '.lock');
  // Another process holds the lock for 600 ms and reports when it let go.
  const holder = inChild(
    `
    import { withStateLock } from ${JSON.stringify(CONNECTIONS_URL)};
    withStateLock(process.argv[1], () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      console.log(JSON.stringify({ releasedAt: Date.now() }));
    });
  `,
    [root],
  );
  const appeared = Date.now() + 10_000;
  while (!existsSync(lock)) {
    assert.ok(Date.now() < appeared, 'the holder never took the lock');
    await new Promise((r) => setTimeout(r, 2));
  }
  // `git-serve pair` in a third process. No server is running in this test, so
  // waiting for the command synchronously stops nothing.
  const printed = cli(['git-serve', 'pair', root]);
  const finishedAt = Date.now();
  assert.equal(printed.code, 0, printed.out);
  const { releasedAt } = await holder;
  assert.ok(finishedAt >= releasedAt, `pair finished ${releasedAt - finishedAt} ms before the lock was released`);
  // What it wrote is whole: the printed code is the live one.
  const code = /Pairing code: (\S+)/.exec(printed.out)[1];
  assert.equal(exchangePairingCode(root, code).ok, true);
  assert.equal(existsSync(lock), false);
});

test('the state lock: the server never waits for it — /pair answers 503 busy at once, other requests are served, and no failure is counted', async () => {
  const root = freshRoot('busy');
  const lock = join(root, '.git-serve', '.lock');
  const failures = () => JSON.parse(readFileSync(join(root, '.git-serve', 'pairing.json'), 'utf8')).failures;
  const timed = async (pending) => {
    const started = Date.now();
    const res = await pending;
    return { res, ms: Date.now() - started };
  };
  const s = await start(root);
  try {
    const { code } = createPairingCode(root, 'read', s.clock.t);
    const { token } = addConnection(root, 'read');
    assert.equal((await s.pair('ZZZZ-ZZZZ')).status, 401);
    assert.equal(failures(), 1);
    // Another process holds the lock, as of now.
    writeFileSync(lock, '');
    const [busy, read] = await Promise.all([
      timed(s.pair('ZZZZ-ZZZZ')),
      timed(s.request('/meta', { bearer: token })),
    ]);
    assert.equal(busy.res.status, 503, busy.res.text);
    assert.equal(busy.res.body.reason, 'busy');
    assert.equal(busy.res.body.server, GIT_SERVE_SERVER);
    assert.equal(busy.res.headers['retry-after'], '1');
    assert.ok(busy.ms < 1000, `/pair took ${busy.ms} ms`);
    assert.equal(read.res.status, 200);
    assert.ok(read.ms < 1000, `a read beside it took ${read.ms} ms`);
    // The right code is answered the same way, and is not spent by it.
    assert.equal((await s.pair(code)).status, 503);
    assert.equal(failures(), 1, 'a busy answer counts no failure');
    assert.equal(readConnections(root).length, 1);
    assert.equal(existsSync(lock), true, 'the server did not remove a lock it does not hold');
    // Released: the same code pairs.
    rmSync(lock);
    assert.equal((await s.pair(code)).status, 200);
  } finally {
    rmSync(lock, { force: true });
    await s.handle.close();
  }
});

// --- the commands ------------------------------------------------------------

const cli = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test('cli: `git-serve pair` prints a code the server accepts; `connections` lists and revokes', async () => {
  const root = freshRoot('cli');
  const s = await start(root);
  try {
    const printed = cli(['git-serve', 'pair', root, '--scope', 'write']);
    assert.equal(printed.code, 0);
    const code = /Pairing code: (\S+)/.exec(printed.out)[1];
    assert.match(code, CODE_RE);
    const res = await s.pair(code);
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'write');
    const listed = cli(['git-serve', 'connections', root]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, new RegExp(`^${res.body.connectionId}\\s+write\\s+connected `, 'm'));
    assert.ok(!listed.out.includes(res.body.token));
    assert.ok(!listed.out.includes(readConnections(root)[0].tokenHash), 'the listing prints no hash either');
    assert.equal(cli(['git-serve', 'connections', root, '--revoke', res.body.connectionId]).code, 0);
    assert.equal((await s.request('/meta', { bearer: res.body.token })).status, 401);
    assert.match(cli(['git-serve', 'connections', root]).out, /No connections/);
    assert.equal(cli(['git-serve', 'connections', root, '--revoke', 'nope']).code, 1);
    assert.equal(cli(['git-serve', 'pair', root, '--scope', 'admin']).code, 1);
  } finally {
    await s.handle.close();
  }
});

test('cli: --allow-login without --bind tailscale is refused', () => {
  const root = freshRoot('flags');
  const res = cli(['git-serve', root, '--allow-login', 'someone@example.com']);
  assert.equal(res.code, 1);
  assert.match(res.out, /--bind tailscale/);
});
