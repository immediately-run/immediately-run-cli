// G-GS-7 — the tailnet peer-identity gate fails closed (GIT_SERVE_SPEC R-GS-16;
// roadmap R3-1360). Runs against the compiled dist/.
//
// The daemon's answers are the recordings in test/fixtures/tailscale-whois/,
// made on a live tailnet by scripts/record-tailscale-whois.mjs (R3-1356). Two
// recordings need the tailnet's admin console and do not exist yet: another
// user's device and a tagged node. The cases that read them are SKIPPED BY NAME
// until the files are recorded; they are not passing. Cases marked "derived"
// edit one field of a real recording to exercise a branch of the gate. They show
// what the gate does with such an answer, not that the daemon gives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { checkPeer, normalizeAddress } from '../dist/gitServe/peerGate.js';
import {
  parseTailnetIdentity,
  parseWhois,
  resolveAllowLogins,
  tailscaleWhois,
} from '../dist/gitServe/tailscaleWhois.js';
import { startGitServe } from '../dist/gitServe/server.js';
import { addConnection } from '../dist/gitServe/connections.js';
import { runGitServeInit } from '../dist/commands/gitServe.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/tailscale-whois/', import.meta.url));
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const has = (name) => existsSync(join(FIXTURES, name));

/** A recorded successful `tailscale whois --json`: exit 0, the file on stdout. */
const recorded = (name) => parseWhois(0, fixture(name), '');

const identity = parseTailnetIdentity(fixture('status.json'));
const PEER_ADDRESS = '100.64.0.2'; // the same-user fixture's placeholder address
const config = (whois, allowUserIds = new Set()) => ({ self: identity.self, allowUserIds, whois });
const answering = (answer) => async () => answer;

const NEEDS_OPERATOR =
  'not recorded yet: needs the tailnet admin console (R3-1356); run ' +
  'scripts/record-tailscale-whois.mjs sanitize';

// --- the recordings, read by the production parser ---------------------------

test('recorded: the serving node is read from `tailscale status --json`', () => {
  assert.equal(identity.tagged, false);
  assert.equal(typeof identity.self.userId, 'number');
  assert.equal(typeof identity.self.stableId, 'string');
  assert.ok(identity.self.addresses.length >= 1);
  assert.equal(identity.usersByLogin.get('owner@example.com'), identity.self.userId);
});

test('recorded: a same-user peer carries the serving node\'s user id in UserProfile.ID and Node.User', () => {
  const answer = recorded('same-user.json');
  assert.equal(answer.kind, 'peer');
  assert.equal(answer.peer.profileUserId, identity.self.userId);
  assert.equal(answer.peer.nodeUserId, identity.self.userId);
  assert.deepEqual(answer.peer.tags, []);
  assert.notEqual(answer.peer.nodeStableId, identity.self.stableId);
});

test('recorded: whois on the node\'s own address answers with the node itself', () => {
  const answer = recorded('self.json');
  assert.equal(answer.kind, 'peer');
  assert.equal(answer.peer.nodeStableId, identity.self.stableId);
});

test('recorded: an unknown address and an unreachable daemon are told apart', () => {
  const unknown = JSON.parse(fixture('unknown.json'));
  assert.deepEqual(parseWhois(unknown.exitCode, unknown.stdout, unknown.stderr), { kind: 'unknown' });
  const down = fixture('daemon-down.txt');
  const exitCode = Number(/^exit code: (\d+)$/m.exec(down)[1]);
  const stderr = /^stderr: (.*)$/m.exec(down)[1];
  assert.notEqual(exitCode, 0);
  assert.equal(parseWhois(exitCode, '', stderr).kind, 'down');
});

// --- G-GS-7: the verdicts ----------------------------------------------------

test('G-GS-7: a device of the same user passes', async () => {
  const verdict = await checkPeer(PEER_ADDRESS, config(answering(recorded('same-user.json'))));
  assert.deepEqual(verdict, { ok: true, userId: identity.self.userId, login: 'owner@example.com' });
});

test('G-GS-7: the node\'s own address is refused, and the daemon is not even asked', async () => {
  let asked = 0;
  const whois = async () => {
    asked++;
    return recorded('same-user.json'); // even an answer that would pass
  };
  for (const own of identity.self.addresses) {
    assert.deepEqual(await checkPeer(own, config(whois)), { ok: false, reason: 'self' });
  }
  assert.deepEqual(await checkPeer(`::ffff:${identity.self.addresses[0]}`, config(whois)), { ok: false, reason: 'self' });
  assert.equal(asked, 0);
});

test('G-GS-7: a peer the daemon identifies as the serving node is refused (a proxy on another address)', async () => {
  const verdict = await checkPeer('100.64.0.99', config(answering(recorded('self.json'))));
  assert.deepEqual(verdict, { ok: false, reason: 'self' });
});

test('G-GS-7: an address the daemon does not know is refused', async () => {
  const unknown = JSON.parse(fixture('unknown.json'));
  const whois = answering(parseWhois(unknown.exitCode, unknown.stdout, unknown.stderr));
  assert.deepEqual(await checkPeer('100.127.255.254', config(whois)), { ok: false, reason: 'unknown-peer' });
});

test('G-GS-7: a daemon that does not answer is refused — the gate fails closed', async () => {
  const down = fixture('daemon-down.txt');
  const whois = answering(parseWhois(1, '', /^stderr: (.*)$/m.exec(down)[1]));
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(whois)), { ok: false, reason: 'daemon' });
  // A lookup that throws, and answers the parser cannot read, are the same refusal.
  const throwing = async () => {
    throw new Error('spawn failed');
  };
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(throwing)), { ok: false, reason: 'daemon' });
  for (const stdout of ['', 'not json', '{}', '{"Node":{},"UserProfile":{}}', '[]', 'null']) {
    assert.deepEqual(
      await checkPeer(PEER_ADDRESS, config(answering(parseWhois(0, stdout, '')))),
      { ok: false, reason: 'daemon' },
      JSON.stringify(stdout),
    );
  }
  // An answer of a kind this code does not know is refused too.
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(answering({ kind: 'future' }))), { ok: false, reason: 'daemon' });
});

test('G-GS-7: a connection with no remote address is refused', async () => {
  const whois = answering(recorded('same-user.json'));
  assert.deepEqual(await checkPeer(undefined, config(whois)), { ok: false, reason: 'no-address' });
  assert.deepEqual(await checkPeer('', config(whois)), { ok: false, reason: 'no-address' });
});

test('G-GS-7 (recorded): another user\'s device is refused; allow-listed, it passes', { skip: has('other-user.json') ? false : NEEDS_OPERATOR }, async () => {
  const answer = recorded('other-user.json');
  assert.equal(answer.kind, 'peer');
  assert.notEqual(answer.peer.profileUserId, identity.self.userId);
  assert.deepEqual(await checkPeer('100.64.0.3', config(answering(answer))), { ok: false, reason: 'other-user' });
  const allowed = await checkPeer('100.64.0.3', config(answering(answer), new Set([answer.peer.profileUserId])));
  assert.equal(allowed.ok, true);
});

test('G-GS-7 (recorded): a tagged node is refused, even when its creator is allow-listed', { skip: has('tagged.json') ? false : NEEDS_OPERATOR }, async () => {
  const answer = recorded('tagged.json');
  assert.equal(answer.kind, 'peer', 'the parser must be able to read what the daemon says about a tagged node');
  const everyId = new Set([answer.peer.profileUserId, answer.peer.nodeUserId]);
  const verdict = await checkPeer('100.64.0.4', config(answering(answer), everyId));
  assert.deepEqual(verdict, { ok: false, reason: 'tagged-peer' });
});

// --- derived cases: one field of a real recording changed --------------------

const derive = (edit) => {
  const body = JSON.parse(fixture('same-user.json'));
  edit(body);
  return parseWhois(0, JSON.stringify(body), '');
};

test('derived: a peer whose user id differs is refused; allow-listed by id, it passes', async () => {
  const other = derive((b) => {
    b.Node.User = 1000000000000002;
    b.UserProfile.ID = 1000000000000002;
    b.UserProfile.LoginName = 'other@example.com';
  });
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(answering(other))), { ok: false, reason: 'other-user' });
  const allowed = await checkPeer(PEER_ADDRESS, config(answering(other), new Set([1000000000000002])));
  assert.deepEqual(allowed, { ok: true, userId: 1000000000000002, login: 'other@example.com' });
});

test('derived: the comparison is the id, never the login or display string', async () => {
  // Same strings as the owner, another id: refused.
  const impostor = derive((b) => {
    b.Node.User = 1000000000000009;
    b.UserProfile.ID = 1000000000000009;
  });
  assert.equal(impostor.peer.login, 'owner@example.com');
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(answering(impostor))), { ok: false, reason: 'other-user' });
  // The owner's id under a renamed login: served.
  const renamed = derive((b) => {
    b.UserProfile.LoginName = 'renamed@example.com';
    b.UserProfile.DisplayName = 'Renamed';
  });
  assert.equal((await checkPeer(PEER_ADDRESS, config(answering(renamed)))).ok, true);
});

test('derived: a node that carries tags is refused whatever its user fields say', async () => {
  const tagged = derive((b) => {
    b.Node.Tags = ['tag:server'];
  });
  // Its user fields still name the owner, and the owner is allow-listed as well.
  assert.deepEqual(
    await checkPeer(PEER_ADDRESS, config(answering(tagged), new Set([identity.self.userId]))),
    { ok: false, reason: 'tagged-peer' },
  );
});

test('derived: Node.User and UserProfile.ID must agree — a profile that names another id is refused', async () => {
  const split = derive((b) => {
    b.UserProfile.ID = 1000000000000007; // e.g. a shared profile for non-user nodes
  });
  assert.deepEqual(
    await checkPeer(PEER_ADDRESS, config(answering(split), new Set([1000000000000007]))),
    { ok: false, reason: 'other-user' },
  );
  const split2 = derive((b) => {
    b.Node.User = 1000000000000007;
  });
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(answering(split2))), { ok: false, reason: 'other-user' });
});

test('derived: ids must be numbers — a string that spells the owner\'s id is not the owner', async () => {
  const stringly = derive((b) => {
    b.Node.User = String(b.Node.User);
    b.UserProfile.ID = String(b.UserProfile.ID);
  });
  assert.deepEqual(await checkPeer(PEER_ADDRESS, config(answering(stringly))), { ok: false, reason: 'daemon' });
});

// --- the serving node and --allow-login --------------------------------------

test('G-GS-7: a tagged serving node with no --allow-login refuses to start', () => {
  const status = JSON.parse(fixture('status.json'));
  status.Self.Tags = ['tag:server']; // derived
  const tagged = parseTailnetIdentity(JSON.stringify(status));
  assert.equal(tagged.tagged, true);
  assert.equal(tagged.self.userId, null, 'a tagged node has no user to compare with');
  assert.throws(() => resolveAllowLogins(tagged, []), /tagged/);
  // With a login it starts, and then ONLY that user is served — not the node's creator.
  const ids = resolveAllowLogins(tagged, ['owner@example.com']);
  assert.deepEqual([...ids], [1000000000000001]);
});

test('a tagged serving node serves nobody by its own (absent) user', async () => {
  const status = JSON.parse(fixture('status.json'));
  status.Self.Tags = ['tag:server'];
  const tagged = parseTailnetIdentity(JSON.stringify(status));
  const gate = { self: tagged.self, allowUserIds: new Set(), whois: answering(recorded('same-user.json')) };
  assert.deepEqual(await checkPeer(PEER_ADDRESS, gate), { ok: false, reason: 'other-user' });
});

test('--allow-login resolves to stable ids once; a login that names nobody is a start-up error', () => {
  assert.deepEqual([...resolveAllowLogins(identity, ['OWNER@example.com'])], [identity.self.userId]);
  assert.deepEqual([...resolveAllowLogins(identity, [])], []);
  assert.throws(() => resolveAllowLogins(identity, ['nobody@example.com']), /knows no user/);
});

test('parseTailnetIdentity refuses a status it cannot use', () => {
  for (const bad of ['', 'x', '{}', '{"Self":{}}', '{"Self":{"ID":"n"}}', '{"Self":{"ID":"n","TailscaleIPs":["100.64.0.1"]}}']) {
    assert.throws(() => parseTailnetIdentity(bad), JSON.stringify(bad));
  }
});

test('at most eight `tailscale whois` processes run at once; the rest wait and are all answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-git-serve-whois-'));
  try {
    // A stand-in for the tailscale binary. Each run leaves a file while it is
    // alive, and records how many such files it saw when it started.
    const bin = join(dir, 'tailscale');
    writeFileSync(
      bin,
      '#!/bin/sh\nd="$(dirname "$0")"\nmkdir -p "$d/live"\n: > "$d/live/$$"\nsleep 0.3\n' +
        'ls "$d/live" | wc -l >> "$d/seen"\nrm "$d/live/$$"\necho "peer not found" >&2\nexit 1\n',
    );
    chmodSync(bin, 0o755);
    const whois = tailscaleWhois(bin);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => whois(`100.64.0.${i + 1}`)));
    assert.equal(answers.length, 20);
    for (const answer of answers) assert.deepEqual(answer, { kind: 'unknown' });
    const seen = readFileSync(join(dir, 'seen'), 'utf8').trim().split('\n').map(Number);
    assert.equal(seen.length, 20, 'every lookup ran');
    assert.equal(Math.max(...seen), 8, `the most alive together: ${seen.join(' ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeAddress: an IPv4-mapped address is its IPv4 form', () => {
  assert.equal(normalizeAddress('::ffff:100.64.0.2'), '100.64.0.2');
  assert.equal(normalizeAddress('FD7A:115C:A1E0::2'), 'fd7a:115c:a1e0::2');
});

// --- the gate in the running server ------------------------------------------

const HOST = 'serving-node.example-tailnet.ts.net';
const ORIGIN = 'https://local.immediately.run';

const request = (port, path, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

test('G-GS-7 in the server: a valid token does not stand in for the peer check, on every route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ir-git-serve-peer-'));
  runGitServeInit(root, 'notes');
  const { token } = addConnection(root, 'read');
  // The injected whois decides per test step; the server is started through its
  // programmatic entry on loopback, so no tailnet is needed.
  let answer = recorded('same-user.json');
  const logs = [];
  const handle = await startGitServe({
    root,
    origin: ORIGIN,
    port: 0,
    log: (line) => logs.push(line),
    tailnet: { host: HOST, address: '127.0.0.1', peerGate: config(async () => answer) },
  });
  const headers = { Host: `${HOST}:${handle.port}`, Origin: ORIGIN, Authorization: `Bearer ${token}` };
  try {
    assert.equal((await request(handle.port, '/meta', { headers })).status, 200, 'a same-user peer with its token is served');
    // The peer is right and the token is missing or wrong: 401. The peer never authorizes.
    assert.equal((await request(handle.port, '/meta', { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401);
    const unknown = JSON.parse(fixture('unknown.json'));
    const refusals = [
      ['self', recorded('self.json')],
      ['unknown-peer', parseWhois(unknown.exitCode, unknown.stdout, unknown.stderr)],
      ['daemon', parseWhois(1, '', 'Failed to connect to local Tailscale daemon')],
      ['tagged-peer', derive((b) => { b.Node.Tags = ['tag:x']; })],
      ['other-user', derive((b) => { b.Node.User = 5; b.UserProfile.ID = 5; })],
    ];
    for (const [reason, whoisAnswer] of refusals) {
      answer = whoisAnswer;
      for (const [path, method] of [['/meta', 'GET'], ['/tree?repo=notes&ref=main', 'GET'], ['/blob?repo=notes&sha=' + '0'.repeat(40), 'GET'], ['/pair', 'POST'], ['/meta', 'OPTIONS'], ['/notes.git/info/refs?service=git-upload-pack', 'GET']]) {
        // A git client sends no Origin; with one, the git routes answer `browser` first.
        const sent = path.includes('.git/') ? { Host: headers.Host } : headers;
        const res = await request(handle.port, path, { method, headers: sent });
        assert.equal(res.status, 403, `${reason} ${method} ${path}`);
        assert.equal(JSON.parse(res.body).reason, reason, `${method} ${path}`);
      }
      assert.ok(logs.some((l) => l.includes(`(${reason})`)), `the log names ${reason}`);
    }
    assert.ok(!logs.some((l) => l.includes(token)), 'a credential is never logged');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
