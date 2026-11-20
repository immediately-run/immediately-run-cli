/*
 * The tailnet peer-identity gate (GIT_SERVE_SPEC R-GS-16). It runs on every
 * tailnet request, of both request classes, and it fails closed.
 *
 * The server asks the local Tailscale daemon who owns the connecting address
 * and serves the request only when that device belongs to the serving node's
 * own user, or to a user the operator listed with `--allow-login`. Users are
 * compared by their stable numeric id, never by a login or display string.
 *
 * Refused, each with its own reason:
 *
 *   self          the address is the serving node's own, or the daemon says the
 *                 peer IS the serving node. A local proxy (`tailscale serve`,
 *                 Funnel, any reverse proxy) makes every request arrive from the
 *                 node itself, so this is what keeps that setup closed.
 *   unknown-peer  the daemon does not know the address.
 *   tagged-peer   the peer is a tagged node. A tagged node is not a user's
 *                 device, whoever created it.
 *   other-user    the peer's user is neither the node's own nor allow-listed.
 *   daemon        the daemon did not answer, or answered something this code
 *                 does not understand, or the lookup threw.
 *   no-address    the connection has no remote address to ask about.
 *
 * What the daemon reports was recorded on a live tailnet (roadmap R3-1356; the
 * recordings are test/fixtures/tailscale-whois/). The stable user id is
 * `UserProfile.ID`, which equals `Node.User` for a user-owned device. This gate
 * requires BOTH to equal an allowed id, and refuses any node that carries tags,
 * so it does not depend on which of the two fields a tagged node keeps.
 *
 * Pure over an injected `whois`: no process is started here.
 */

export interface PeerRecord {
  /** `Node.StableID`. */
  nodeStableId: string;
  /** `Node.User`: for a user-owned device, the owner's stable user id. */
  nodeUserId: number;
  /** `UserProfile.ID`. */
  profileUserId: number;
  /** `UserProfile.LoginName`. For logs and REMOTE_USER only; never compared. */
  login: string;
  /** `Node.Tags`, empty when the node has none. */
  tags: readonly string[];
}

export type WhoisAnswer =
  | { kind: 'peer'; peer: PeerRecord }
  /** The daemon answered and does not know the address. */
  | { kind: 'unknown' }
  /** The daemon did not answer, or its answer could not be read. */
  | { kind: 'down'; detail: string };

export type Whois = (address: string) => Promise<WhoisAnswer>;

export interface ServingNode {
  /** `Self.ID` of `tailscale status --json`: the node's stable id. */
  stableId: string;
  /** `Self.UserID`, or null when the serving node is itself tagged (it then has
   *  no user to compare with, and only `--allow-login` users are served). */
  userId: number | null;
  /** The node's own tailnet addresses (`Self.TailscaleIPs`). */
  addresses: readonly string[];
}

export interface PeerGateConfig {
  self: ServingNode;
  /** Stable user ids resolved from `--allow-login` once, at start. */
  allowUserIds: ReadonlySet<number>;
  whois: Whois;
}

export type PeerRefusal =
  | 'self'
  | 'unknown-peer'
  | 'tagged-peer'
  | 'other-user'
  | 'daemon'
  | 'no-address';

export type PeerVerdict =
  | { ok: true; userId: number; login: string }
  | { ok: false; reason: PeerRefusal };

/** `::ffff:100.64.0.2` (an IPv4 peer on a dual-stack socket) is `100.64.0.2`. */
export const normalizeAddress = (address: string): string => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
};

export const checkPeer = async (
  remoteAddress: string | undefined,
  config: PeerGateConfig,
): Promise<PeerVerdict> => {
  if (remoteAddress === undefined || remoteAddress === '') {
    return { ok: false, reason: 'no-address' };
  }
  const address = normalizeAddress(remoteAddress);
  // The node's own address is refused without asking: nothing the daemon could
  // say about it would make a proxied request acceptable.
  if (config.self.addresses.some((own) => normalizeAddress(own) === address)) {
    return { ok: false, reason: 'self' };
  }

  let answer: WhoisAnswer;
  try {
    answer = await config.whois(address);
  } catch {
    return { ok: false, reason: 'daemon' };
  }
  if (answer.kind === 'down') return { ok: false, reason: 'daemon' };
  if (answer.kind === 'unknown') return { ok: false, reason: 'unknown-peer' };
  if (answer.kind !== 'peer') return { ok: false, reason: 'daemon' };

  const peer = answer.peer;
  if (peer.nodeStableId === config.self.stableId) return { ok: false, reason: 'self' };
  if (peer.tags.length > 0) return { ok: false, reason: 'tagged-peer' };

  const allowed = (id: number): boolean =>
    (config.self.userId !== null && id === config.self.userId) || config.allowUserIds.has(id);
  // Both fields must name an allowed user. If they disagree, the node is not
  // simply "a device of that user", and it is refused.
  if (peer.nodeUserId !== peer.profileUserId) return { ok: false, reason: 'other-user' };
  if (!allowed(peer.profileUserId)) return { ok: false, reason: 'other-user' };
  return { ok: true, userId: peer.profileUserId, login: peer.login };
};
