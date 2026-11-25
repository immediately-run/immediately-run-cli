/*
 * Durable, revocable connection tokens (GIT_SERVE_SPEC §10.2, R-GS-24).
 *
 * A standing server on a tailnet cannot use a per-start token. Each browser
 * that pairs gets its own token of 256 random bits. The server keeps only a
 * SHA-256 of it, in `<root>/.git-serve/connections.json` (0600), with the
 * connection's id, scope and creation time. A stolen state directory therefore
 * holds no usable credential.
 *
 * Revocation is immediate. `git-serve connections --revoke` is a second
 * process that rewrites the file; the server looks at the file on every
 * request and reads it again whenever it changed, so a revoked token fails at
 * its next request (threat_model P3: policy is read at use time).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { ensureStateDir, stateDirOf } from './state.js';

export type ConnectionScope = 'read' | 'write';

export interface ConnectionRecord {
  id: string;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  tokenHash: string;
  scope: ConnectionScope;
  /** ISO 8601. */
  createdAt: string;
}

export const CONNECTIONS_FILE = 'connections.json';
const FILE_MODE = 0o600;

export const isScope = (v: unknown): v is ConnectionScope => v === 'read' || v === 'write';

export const hashSecret = (secret: string): Buffer =>
  createHash('sha256').update(secret, 'utf8').digest();

const isConnectionRecord = (v: unknown): v is ConnectionRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(r.tokenHash) &&
    isScope(r.scope) &&
    typeof r.createdAt === 'string'
  );
};

/** Replaces a state file in one step, so a reader sees the old file or the new
 *  one and never a half-written one. */
export const writeStateFile = (root: string, name: string, content: string): void => {
  const dir = ensureStateDir(root);
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, content, { mode: FILE_MODE, flag: 'wx' });
  renameSync(tmp, join(dir, name));
};

const LOCK_FILE = '.lock';
const LOCK_WAIT_MS = 5000;
/** A lock in the old format (no holder pid) is stale after this long. */
const LOCK_STALE_MS = 30_000;
/** A live holder never holds the lock this long; past it, a reused pid is assumed. */
const LOCK_ABANDONED_MS = 10 * 60_000;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A lock file's content, or null when it is gone or unreadable. */
const readLock = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Whether a lock was left by a holder that can no longer release it. A lock
 * holds `<pid> <nonce>`; it is stale when that process is gone (the state
 * directory is local, so the pid is this machine's). Age alone never makes a
 * live holder's lock stale: a slow holder could release it and another take it
 * between the judgement and the removal (cli#63 review, round 2).
 */
const isStale = (content: string, mtimeMs: number): boolean => {
  const age = Date.now() - mtimeMs;
  const m = /^(\d+) [0-9a-f]+$/.exec(content);
  if (m === null) return age > LOCK_STALE_MS; // the old format, or a half-written lock
  return !processAlive(Number(m[1])) || age > LOCK_ABANDONED_MS;
};

/** Creates `path` exclusively with this holder's line; the line, or null if taken. */
const createLock = (path: string): string | null => {
  const line = `${process.pid} ${randomBytes(16).toString('hex')}`;
  let fd: number;
  try {
    fd = openSync(path, 'wx', FILE_MODE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return line;
};

/** Releases a lock only if it still holds this holder's line. */
const unlock = (path: string, held: string): void => {
  if (readLock(path) === held) rmSync(path, { force: true });
};

/** Whether `path` exists and is stale. */
const staleAt = (path: string): boolean => {
  const content = readLock(path);
  if (content === null) return false;
  try {
    return isStale(content, statSync(path).mtimeMs);
  } catch {
    return false;
  }
};

/**
 * Removes a stale lock. Only the holder of `<lock>.takeover` may, and it judges
 * the lock again while holding it. While the stale lock exists no one can create
 * a fresh one, and its dead holder cannot remove it, so what is judged stale is
 * what is removed. Returns true when this waiter held the takeover, whether or
 * not it removed anything.
 *
 * Residual, accepted: a takeover lock whose holder DIED is removed by judging
 * and then removing, with no guard, so another waiter's live takeover lock
 * could be removed in between. That needs a process killed inside the
 * takeover section (a few microseconds), and then a second takeover racing
 * through the same gap; the result would be two holders of the state lock.
 */
const takeOver = (lock: string): boolean => {
  const takeover = `${lock}.takeover`;
  const mine = createLock(takeover);
  if (mine === null) {
    if (staleAt(takeover)) rmSync(takeover, { force: true });
    return false;
  }
  try {
    if (staleAt(lock)) rmSync(lock, { force: true });
  } finally {
    unlock(takeover, mine);
  }
  return true;
};

/** One attempt at the lock: the holder's line when taken, else whether to wait. */
const tryLock = (lock: string): { held: string } | 'retry' | 'wait' => {
  const held = createLock(lock);
  if (held !== null) return { held };
  if (!staleAt(lock)) return 'wait';
  return takeOver(lock) ? 'retry' : 'wait';
};

const busy = (lock: string): Error =>
  new Error(`${lock} is held by another git-serve process; try again.`);

/**
 * Runs `fn` holding the state directory's lock. The server, `git-serve pair`
 * and `git-serve connections` are separate processes that each read a state
 * file, change it and write it back; without a lock the last writer wins, and a
 * pairing racing a revocation could write the revoked connection back.
 * Not re-entrant: a function that holds the lock calls the unlocked forms.
 * The two CLI commands use this blocking form; the server uses
 * `withStateLockAsync`, so a held lock never stalls its other requests.
 */
export const withStateLock = <T>(root: string, fn: () => T): T => {
  const lock = join(ensureStateDir(root), LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const got = tryLock(lock);
    if (typeof got === 'object') {
      try {
        return fn();
      } finally {
        unlock(lock, got.held);
      }
    }
    if (got === 'wait') {
      if (Date.now() > deadline) throw busy(lock);
      sleepSync(10);
    }
  }
};

/** `withStateLock` for the server: it waits without blocking the event loop. */
export const withStateLockAsync = async <T>(root: string, fn: () => T): Promise<T> => {
  const lock = join(ensureStateDir(root), LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const got = tryLock(lock);
    if (typeof got === 'object') {
      try {
        return fn();
      } finally {
        unlock(lock, got.held);
      }
    }
    if (got === 'wait') {
      if (Date.now() > deadline) throw busy(lock);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
};

/** The stored connections. A missing file is no connections; a file that cannot
 *  be read as a list of records is an error, never an empty list. */
export const readConnections = (root: string): ConnectionRecord[] => {
  const file = join(stateDirOf(root), CONNECTIONS_FILE);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const list = (parsed as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list) || !list.every(isConnectionRecord)) {
    throw new Error(`${file} is not a git-serve connections file`);
  }
  return list;
};

const writeConnections = (root: string, list: readonly ConnectionRecord[]): void =>
  writeStateFile(root, CONNECTIONS_FILE, JSON.stringify({ connections: list }, null, 2) + '\n');

/** Mints a connection. The caller holds the state lock. */
export const addConnectionLocked = (
  root: string,
  scope: ConnectionScope,
  now: Date = new Date(),
): { record: ConnectionRecord; token: string } => {
  const token = randomBytes(32).toString('base64url');
  const record: ConnectionRecord = {
    id: randomBytes(8).toString('hex'),
    tokenHash: hashSecret(token).toString('hex'),
    scope,
    createdAt: now.toISOString(),
  };
  writeConnections(root, [...readConnections(root), record]);
  return { record, token };
};

/** Mints a connection. The token is returned once and exists nowhere on disk. */
export const addConnection = (
  root: string,
  scope: ConnectionScope,
  now: Date = new Date(),
): { record: ConnectionRecord; token: string } =>
  withStateLock(root, () => addConnectionLocked(root, scope, now));

/** Removes a connection. Returns false when no connection has that id. */
export const revokeConnection = (root: string, id: string): boolean =>
  withStateLock(root, () => {
    const list = readConnections(root);
    const kept = list.filter((c) => c.id !== id);
    if (kept.length === list.length) return false;
    writeConnections(root, kept);
    return true;
  });

export interface ConnectionLookup {
  /** The connection a presented token belongs to, or null. */
  find(token: string): ConnectionRecord | null;
}

/**
 * The server's view of the file. It stats the file on every lookup and reads it
 * again when the inode, the size or the modification time changed (a rewrite is
 * a rename, so the inode always changes). If the file cannot be read, every
 * lookup fails: an unreadable list authorizes nobody.
 */
export const connectionLookup = (root: string): ConnectionLookup => {
  const file = join(stateDirOf(root), CONNECTIONS_FILE);
  let stamp = '';
  let records: ConnectionRecord[] = [];
  const refresh = (): void => {
    let next: string;
    try {
      const st = statSync(file, { bigint: true });
      next = `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch {
      next = 'absent';
    }
    if (next === stamp) return;
    try {
      records = next === 'absent' ? [] : readConnections(root);
      stamp = next;
    } catch {
      records = [];
      stamp = ''; // read again next time
    }
  };
  return {
    find: (token) => {
      refresh();
      const presented = hashSecret(token);
      let match: ConnectionRecord | null = null;
      // Every record is compared, so the time taken does not say which matched.
      for (const record of records) {
        if (timingSafeEqual(presented, Buffer.from(record.tokenHash, 'hex'))) match = record;
      }
      return match;
    },
  };
};
