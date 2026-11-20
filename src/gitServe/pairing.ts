/*
 * The pairing-code exchange (GIT_SERVE_SPEC §10.2, R-GS-24).
 *
 * `git-serve pair <root>` runs as a second process beside the server. It mints
 * a code and writes `<root>/.git-serve/pairing.json` (0600) holding the code's
 * SHA-256, the scope the code grants, its expiry and a failure counter. The
 * server reads that file on each `POST /pair` and rewrites it by rename.
 *
 * One file means one live code: minting a new one replaces the old.
 *
 * The code dies at the first of:
 *   - one successful exchange;
 *   - the fifth failed attempt, counted in the file, so across every caller;
 *   - ten minutes.
 *
 * The code is 40 random bits, shown as two groups of four base32 characters.
 * It is short because a person types it, and it is safe to be short because a
 * guesser gets five tries in total and must already be one of the user's own
 * devices to reach the route (the peer gate runs first).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  addConnectionLocked,
  hashSecret,
  isScope,
  withStateLock,
  writeStateFile,
  type ConnectionRecord,
  type ConnectionScope,
} from './connections.js';
import { stateDirOf } from './state.js';

export const PAIRING_FILE = 'pairing.json';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_FAILURES = 5;

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped has no
 *  look-alike pair. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 8; // 8 × 5 bits = 40 bits

interface PairingRecord {
  codeHash: string;
  scope: ConnectionScope;
  /** Epoch milliseconds. */
  expiresAt: number;
  failures: number;
}

const isPairingRecord = (v: unknown): v is PairingRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.codeHash === 'string' &&
    /^[0-9a-f]{64}$/.test(r.codeHash) &&
    isScope(r.scope) &&
    typeof r.expiresAt === 'number' &&
    Number.isInteger(r.failures) &&
    (r.failures as number) >= 0
  );
};

const pairingFile = (root: string): string => join(stateDirOf(root), PAIRING_FILE);

/** The canonical form of a typed code: uppercase, no dash or space. */
export const normalizeCode = (typed: string): string => typed.replace(/[\s-]/g, '').toUpperCase();

/** `ABCDEFGH` → `ABCD-EFGH`, the form shown to the person. */
export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const mintCode = (): string => {
  // 5 random bytes are exactly 40 bits; each 5-bit group picks one character.
  const bits = BigInt('0x' + randomBytes(5).toString('hex'));
  let out = '';
  for (let i = CODE_CHARS - 1; i >= 0; i--) {
    out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
};

/** Mints the root's one live code, replacing any earlier one. Returns the code
 *  in its shown form; it is stored only as a hash. */
export const createPairingCode = (
  root: string,
  scope: ConnectionScope,
  now: number = Date.now(),
): { code: string; expiresAt: number } => {
  const code = mintCode();
  const record: PairingRecord = {
    codeHash: hashSecret(code).toString('hex'),
    scope,
    expiresAt: now + PAIRING_TTL_MS,
    failures: 0,
  };
  withStateLock(root, () => writeStateFile(root, PAIRING_FILE, JSON.stringify(record) + '\n'));
  return { code: formatCode(code), expiresAt: record.expiresAt };
};

const readPairing = (root: string): PairingRecord | null => {
  const file = pairingFile(root);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isPairingRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const killCode = (root: string): void => rmSync(pairingFile(root), { force: true });

export type PairingResult =
  | { ok: true; record: ConnectionRecord; token: string }
  /** One reason for every failure: a caller cannot tell a wrong code from a dead
   *  one, an expired one, or none having been minted. */
  | { ok: false };

/**
 * Exchanges a presented code for a connection. It holds the state lock from the
 * first read to the last write, so neither two requests in the server nor a
 * `pair` or `connections --revoke` in another process can interleave with it:
 * a code is spent once, a failure is counted once, and a code minted meanwhile
 * is neither spent nor deleted by an exchange of the old one.
 */
export const exchangePairingCode = (
  root: string,
  presented: string,
  now: number = Date.now(),
): PairingResult => withStateLock(root, () => exchangeLocked(root, presented, now));

const exchangeLocked = (root: string, presented: string, now: number): PairingResult => {
  const record = readPairing(root);
  if (record === null) {
    // No code, or a file this code cannot read: remove it so it cannot linger.
    killCode(root);
    return { ok: false };
  }
  if (now >= record.expiresAt || record.failures >= MAX_PAIRING_FAILURES) {
    killCode(root);
    return { ok: false };
  }
  const matches = timingSafeEqual(
    hashSecret(normalizeCode(presented)),
    Buffer.from(record.codeHash, 'hex'),
  );
  if (!matches) {
    const failures = record.failures + 1;
    if (failures >= MAX_PAIRING_FAILURES) killCode(root);
    else writeStateFile(root, PAIRING_FILE, JSON.stringify({ ...record, failures }) + '\n');
    return { ok: false };
  }
  // The code is spent before the token exists, so a crash between the two
  // leaves no code and no connection, never a reusable code.
  killCode(root);
  const made = addConnectionLocked(root, record.scope, new Date(now));
  return { ok: true, record: made.record, token: made.token };
};
