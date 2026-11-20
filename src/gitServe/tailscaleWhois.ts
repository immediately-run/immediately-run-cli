/*
 * What git-serve asks the local Tailscale daemon, and how it reads the answers
 * (GIT_SERVE_SPEC R-GS-16).
 *
 * The daemon is asked through the `tailscale` CLI, which needs no privilege
 * beyond the user's own on every platform the CLI already supports:
 *
 *   tailscale whois --json <address>     who owns a connecting address
 *   tailscale status --json              the serving node itself, and the
 *                                        tailnet's users (for --allow-login)
 *
 * The parsers are pure and are tested over output recorded on a live tailnet
 * (test/fixtures/tailscale-whois/). The field names below are the ones those
 * recordings carry. Anything the parsers do not recognize is reported as the
 * daemon not answering, which the peer gate refuses.
 */

import { execFile } from 'node:child_process';

import type { PeerRecord, ServingNode, Whois, WhoisAnswer } from './peerGate.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stable id is a positive safe integer; anything else is not an id. */
const asId = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;

/** Reads one `tailscale whois --json` result: its exit code and both streams. */
export const parseWhois = (exitCode: number, stdout: string, stderr: string): WhoisAnswer => {
  if (exitCode !== 0) {
    // The daemon answered, and the address is no peer of this node.
    if (/\bpeer not found\b/i.test(stderr)) return { kind: 'unknown' };
    return { kind: 'down', detail: stderr.trim().slice(0, 200) || `exit ${exitCode}` };
  }
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return { kind: 'down', detail: 'whois did not print JSON' };
  }
  if (!isRecord(body) || !isRecord(body.Node) || !isRecord(body.UserProfile)) {
    return { kind: 'down', detail: 'whois answer has no Node or UserProfile' };
  }
  const node = body.Node;
  const profile = body.UserProfile;
  const nodeUserId = asId(node.User);
  const profileUserId = asId(profile.ID);
  const tags = node.Tags === undefined || node.Tags === null ? [] : node.Tags;
  if (
    typeof node.StableID !== 'string' ||
    node.StableID === '' ||
    nodeUserId === null ||
    profileUserId === null ||
    !Array.isArray(tags) ||
    !tags.every((t) => typeof t === 'string')
  ) {
    return { kind: 'down', detail: 'whois answer is missing an identity field' };
  }
  const peer: PeerRecord = {
    nodeStableId: node.StableID,
    nodeUserId,
    profileUserId,
    login: typeof profile.LoginName === 'string' ? profile.LoginName : '',
    tags: tags as string[],
  };
  return { kind: 'peer', peer };
};

export interface TailnetIdentity {
  self: ServingNode;
  /** True when the serving node carries tags (it then has no user of its own). */
  tagged: boolean;
  /** Login → stable user id, for every user this node knows on the tailnet. */
  usersByLogin: ReadonlyMap<string, number>;
}

/** Reads `tailscale status --json` for the serving node's identity. Throws with
 *  a message for the operator when the daemon's answer cannot be used. */
export const parseTailnetIdentity = (statusJson: string): TailnetIdentity => {
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    throw new Error('`tailscale status --json` did not return JSON — is Tailscale running?');
  }
  if (!isRecord(status) || !isRecord(status.Self)) {
    throw new Error('`tailscale status --json` reported no Self node — is tailscaled signed in?');
  }
  const self = status.Self;
  if (typeof self.ID !== 'string' || self.ID === '') {
    throw new Error('`tailscale status --json` reported no stable id for this node.');
  }
  const addresses = Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
    : [];
  if (addresses.length === 0) throw new Error('This tailnet node has no tailnet address.');
  const tags = Array.isArray(self.Tags) ? self.Tags : [];
  const tagged = tags.length > 0;
  const userId = asId(self.UserID);
  if (!tagged && userId === null) {
    throw new Error('`tailscale status --json` reported no user id for this node.');
  }
  const usersByLogin = new Map<string, number>();
  if (isRecord(status.User)) {
    for (const entry of Object.values(status.User)) {
      if (!isRecord(entry)) continue;
      const id = asId(entry.ID);
      if (id !== null && typeof entry.LoginName === 'string' && entry.LoginName !== '') {
        usersByLogin.set(entry.LoginName.toLowerCase(), id);
      }
    }
  }
  return {
    self: { stableId: self.ID, userId: tagged ? null : userId, addresses },
    tagged,
    usersByLogin,
  };
};

/**
 * Resolves `--allow-login` values to stable user ids, once, at start. A login
 * the daemon does not know is a start-up error: silently serving nobody for a
 * mistyped login would look like a working gate. A tagged serving node needs at
 * least one login, because it has no user of its own to serve.
 */
export const resolveAllowLogins = (
  identity: TailnetIdentity,
  logins: readonly string[],
): Set<number> => {
  if (identity.tagged && logins.length === 0) {
    throw new Error(
      'This node is tagged, so it has no user of its own to serve. Start git-serve with ' +
        'at least one --allow-login <login>.',
    );
  }
  const ids = new Set<number>();
  for (const login of logins) {
    const id = identity.usersByLogin.get(login.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `--allow-login ${login}: the Tailscale daemon knows no user with that login. ` +
          `Known logins: ${[...identity.usersByLogin.keys()].sort().join(', ') || '(none)'}.`,
      );
    }
    ids.add(id);
  }
  return ids;
};

const run = (
  bin: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(bin, [...args], { encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
      const code =
        error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : -1;
      resolve({ code, stdout, stderr });
    });
  });

/** The production `whois`: one `tailscale whois --json` per call, never cached,
 *  so a device removed from the tailnet stops being served at its next request. */
export const tailscaleWhois =
  (bin: string): Whois =>
  async (address) => {
    const result = await run(bin, ['whois', '--json', address]);
    return parseWhois(result.code, result.stdout, result.stderr);
  };

export const readTailnetIdentity = async (bin: string): Promise<TailnetIdentity> => {
  const result = await run(bin, ['status', '--json']);
  if (result.code !== 0) {
    throw new Error(
      `\`tailscale status --json\` failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return parseTailnetIdentity(result.stdout);
};
