#!/usr/bin/env node
// Records what the local Tailscale daemon reports about a connecting address,
// as test fixtures for git-serve's peer gate (GIT_SERVE_SPEC R-GS-16; roadmap
// R3-1356 and R3-1360). Run it on a machine signed in to a real tailnet.
//
//   node scripts/record-tailscale-whois.mjs record <address of a same-user peer>
//       Runs the probes this machine can run by itself and writes
//       test/fixtures/tailscale-whois/{same-user,self,unknown,status}.json and
//       daemon-down.txt.
//
//   node scripts/record-tailscale-whois.mjs sanitize <role> <address>
//       role: other-user | tagged | same-user | self
//       Runs `tailscale whois --json <address>` and writes the sanitized result
//       to test/fixtures/tailscale-whois/<role>.json. This is how the two
//       probes that need the admin console (another user's device, a tagged
//       node) are recorded once those devices exist.
//
// Sanitizing keeps structure, key names, value types and array lengths, and
// every value that is not an identifier. Identifiers (tailnet name, logins,
// node keys, addresses, ids) become fixed placeholders, the same placeholder
// for the same role every time. The placeholders are written per role, so the
// relations a peer gate reads (a same-user peer has the serving node's user id,
// another user's device a different one, Node.User equals UserProfile.ID, the
// node's own address is Self) are checked on the RAW answer first, by
// checkRelations, and a recording that breaks its role's relation is refused. The script refuses to write a file
// that still holds an address-like or login-like string it did not place.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'tailscale-whois');
const TAILNET = 'example-tailnet.ts.net';
const OWNER = { id: 1000000000000001, login: 'owner@example.com', display: 'Owner Example' };
const USERS = {
  self: OWNER,
  'same-user': OWNER,
  'other-user': { id: 1000000000000002, login: 'other@example.com', display: 'Other Example' },
};
const NODES = {
  self: { id: 2000000000000001, stable: 'nSELF000000CNTRL', label: 'serving-node', v4: '100.64.0.1', v6: 'fd7a:115c:a1e0::1' },
  'same-user': { id: 2000000000000002, stable: 'nPEER000001CNTRL', label: 'second-device', v4: '100.64.0.2', v6: 'fd7a:115c:a1e0::2' },
  'other-user': { id: 2000000000000003, stable: 'nPEER000002CNTRL', label: 'other-users-device', v4: '100.64.0.3', v6: 'fd7a:115c:a1e0::3' },
  tagged: { id: 2000000000000004, stable: 'nPEER000003CNTRL', label: 'tagged-node', v4: '100.64.0.4', v6: 'fd7a:115c:a1e0::4' },
};

const tailscale = (args) => {
  const r = spawnSync('tailscale', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * The relations a peer gate reads, checked on the RAW answer before any value
 * is replaced: the placeholders are written per role, so a recording whose raw
 * fields broke the role's relation would otherwise come out looking right.
 * `self` is `tailscale status --json`'s Self.
 */
export const checkRelations = (raw, role, self) => {
  const d = JSON.parse(raw);
  const n = d.Node;
  const u = d.UserProfile;
  const fail = (what) => {
    throw new Error(`refusing to record ${role}: ${what}`);
  };
  const tags = Array.isArray(n.Tags) ? n.Tags : [];
  if (role === 'tagged') {
    if (tags.length === 0) fail('the node has no Node.Tags');
    return;
  }
  if (tags.length !== 0) fail('the node is tagged');
  if (n.User !== u.ID) fail('Node.User differs from UserProfile.ID');
  if (role === 'other-user') {
    if (u.ID === self.UserID) fail("UserProfile.ID is the serving node's own user");
    return;
  }
  if (u.ID !== self.UserID) fail("UserProfile.ID is not the serving node's own user");
  if (role === 'self' && n.StableID !== self.ID) fail('Node.StableID is not Self.ID');
  if (role === 'same-user' && n.StableID === self.ID) fail('the address is the serving node itself');
};

export const sanitizeWhois = (raw, role) => {
  const node = NODES[role];
  if (!node) throw new Error(`unknown role ${role}`);
  const d = JSON.parse(raw);
  const n = d.Node;
  n.ID = node.id;
  n.StableID = node.stable;
  n.Name = `${node.label}.${TAILNET}.`;
  for (const [key, prefix] of [['Key', 'nodekey:'], ['DiscoKey', 'discokey:'], ['Machine', 'mkey:']]) {
    if (key in n) n[key] = prefix + '0'.repeat(64);
  }
  const addrs = [`${node.v4}/32`, `${node.v6}/128`];
  if (Array.isArray(n.Addresses)) n.Addresses = addrs.slice(0, n.Addresses.length);
  if (Array.isArray(n.AllowedIPs)) n.AllowedIPs = addrs.slice(0, n.AllowedIPs.length);
  // One placeholder endpoint: how many a node advertises says nothing a test reads.
  if (Array.isArray(n.Endpoints)) n.Endpoints = n.Endpoints.length ? ['192.0.2.1:41641'] : [];
  if ('ComputedName' in n) n.ComputedName = node.label;
  if ('ComputedNameWithHost' in n) n.ComputedNameWithHost = node.label;
  if ('StableTailnetID' in n) n.StableTailnetID = 'TEXAMPLE0000CNTRL';
  if (n.Hostinfo && typeof n.Hostinfo === 'object') {
    const h = n.Hostinfo;
    if ('Hostname' in h) h.Hostname = node.label;
    for (const k of Object.keys(h)) {
      if (k === 'OS' || k === 'Hostname') continue;
      if (typeof h[k] === 'string') h[k] = 'redacted';
      else if (Array.isArray(h[k])) h[k] = [];
      else if (h[k] && typeof h[k] === 'object') h[k] = {};
    }
  }
  // Capability maps name the tailnet inside their values: keep Tailscale's own
  // key names, drop the values.
  for (const holder of [n, d]) {
    if (holder.CapMap && typeof holder.CapMap === 'object') {
      holder.CapMap = Object.fromEntries(Object.keys(holder.CapMap).sort().map((k) => [k, null]));
    }
  }
  const u = d.UserProfile;
  if (role === 'tagged') {
    // A tagged node is not a user's device. Whatever the daemon reported for it
    // is the finding, so every field is kept as recorded, tag names included,
    // except strings that name a person or the tailnet.
    for (const holder of [n, u]) {
      for (const [k, v] of Object.entries(holder)) {
        if (typeof v !== 'string') continue;
        if (/@/.test(v) && !v.endsWith('@example.com')) holder[k] = 'redacted@example.com';
      }
    }
    if ('ProfilePicURL' in u) u.ProfilePicURL = '';
  } else {
    const user = USERS[role];
    n.User = user.id;
    u.ID = user.id;
    u.LoginName = user.login;
    u.DisplayName = user.display;
    if ('ProfilePicURL' in u) u.ProfilePicURL = '';
  }
  const out = JSON.stringify(d, null, 2) + '\n';
  const leaks = [...out.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+|[a-z0-9-]+\.ts\.net/g)]
    .map((m) => m[0])
    .filter((m) => !m.includes('example'));
  if (leaks.length) throw new Error(`refusing to write: the result still holds ${leaks.join(', ')}`);
  return out;
};

const write = (name, content) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), content);
  console.log(`wrote test/fixtures/tailscale-whois/${name}`);
};

const whoisRaw = (address) => {
  const r = tailscale(['whois', '--json', address]);
  if (r.code !== 0) throw new Error(`tailscale whois --json ${address} failed: ${r.stderr.trim()}`);
  return r.stdout;
};

const statusSelf = () =>
  JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })).Self;

/** Records one role: the raw relations are checked first, then sanitized. */
const recordRole = (role, address, self) => {
  const raw = whoisRaw(address);
  checkRelations(raw, role, self);
  write(`${role}.json`, sanitizeWhois(raw, role));
};

const record = (peerAddress) => {
  const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
  const self = status.Self;
  const selfAddress = self.TailscaleIPs.find((ip) => ip.startsWith('100.'));
  recordRole('same-user', peerAddress, self);
  recordRole('self', selfAddress, self);

  // An address the daemon does not know. The CLI prints no JSON for it, so the
  // fixture records what it did print.
  const unknown = tailscale(['whois', '--json', '100.127.255.254']);
  write(
    'unknown.json',
    JSON.stringify(
      {
        command: 'tailscale whois --json <an unused 100.x address>',
        exitCode: unknown.code,
        stdout: unknown.stdout,
        stderr: unknown.stderr,
      },
      null,
      2,
    ) + '\n',
  );

  // The daemon not answering: the same command against a socket path with no
  // daemon behind it. tailscaled itself is left running.
  const socket = join(OUT, 'no-daemon.sock');
  const down = tailscale([`--socket=${socket}`, 'whois', '--json', peerAddress]);
  write(
    'daemon-down.txt',
    `exit code: ${down.code}\nstderr: ${down.stderr.split(socket).join('<socket path with no daemon>').trim()}\n`,
  );

  // The serving node as `tailscale status --json` reports it: only the fields
  // git-serve reads, with the placeholder ids the whois fixtures use. The
  // assertions hold the placeholders to the shape that was actually reported.
  if (typeof self.ID !== 'string' || typeof self.UserID !== 'number') {
    throw new Error('status: Self.ID is not a string or Self.UserID is not a number');
  }
  const ownProfile = status.User?.[String(self.UserID)];
  if (!ownProfile || !['ID', 'LoginName', 'DisplayName'].every((k) => k in ownProfile)) {
    throw new Error('status: User has no ID/LoginName/DisplayName entry for Self.UserID');
  }
  write(
    'status.json',
    JSON.stringify(
      {
        Self: {
          ID: NODES.self.stable,
          UserID: OWNER.id,
          DNSName: `${NODES.self.label}.${TAILNET}.`,
          TailscaleIPs: [NODES.self.v4, NODES.self.v6].slice(0, self.TailscaleIPs.length),
          ...('Tags' in self ? { Tags: self.Tags } : {}),
        },
        User: {
          [String(OWNER.id)]: { ID: OWNER.id, LoginName: OWNER.login, DisplayName: OWNER.display },
        },
      },
      null,
      2,
    ) + '\n',
  );
};

const [command, a, b] = process.argv.slice(2);
if (command === 'record' && a) {
  record(a);
} else if (command === 'sanitize' && a && b) {
  recordRole(a, b, statusSelf());
} else if (command !== undefined) {
  console.error('Usage: record-tailscale-whois.mjs record <same-user peer address>');
  console.error('       record-tailscale-whois.mjs sanitize <other-user|tagged|same-user|self> <address>');
  process.exit(1);
}
