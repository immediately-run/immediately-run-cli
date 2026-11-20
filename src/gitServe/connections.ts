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
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Removes a lock whose holder died. Returns true when the caller should try
 * for the lock again at once, false when it should wait.
 *
 * Two waiters that both saw the dead lock must not each remove "the lock file":
 * the second would remove the lock the first has taken since, and both would be
 * inside. Renaming the lock away has the same flaw, because a rename also acts
 * on whatever file carries the name at that moment. So a takeover first makes a
 * hard link to the lock under one fixed name:
 *
 *   - making the link fails while the name exists, so one process at a time is
 *     taking over;
 *   - the link pins the file it was made from, so the age that is read and the
 *     file that is removed are the same file. A lock taken since is seen to be
 *     new, and is left alone.
 */
const takeOverDeadLock = (lock: string): boolean => {
  const guard = `${lock}.takeover`;
  try {
    linkSync(lock, guard);
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return true; // released meanwhile
    if (errorCode(e) === 'EEXIST') {
      // Another process is taking over; that takes microseconds. A guard this
      // old was left by one that died there. (The link set the file's ctime.)
      try {
        if (Date.now() - statSync(guard).ctimeMs > LOCK_STALE_MS) rmSync(guard, { force: true });
      } catch {
        /* gone already */
      }
    }
    return false;
  }
  try {
    const pinned = statSync(guard, { bigint: true });
    if (Date.now() - Number(pinned.mtimeMs) <= LOCK_STALE_MS) return false; // a live lock
    if (statSync(lock, { bigint: true }).ino === pinned.ino) rmSync(lock);
    return true;
  } catch {
    return true; // the lock went away under us; try for it
  } finally {
    rmSync(guard, { force: true });
  }
};

/** Takes the lock. With `waitMs` 0 it never sleeps: it answers false at once
 *  when the lock is held. Otherwise it waits that long, then answers false. */
const acquireStateLock = (lock: string, waitMs: number): boolean => {
  const deadline = Date.now() + waitMs;
  for (let tries = 1; ; tries++) {
    try {
      closeSync(openSync(lock, 'wx', FILE_MODE));
      return true;
    } catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e;
    }
    // A caller that does not wait still retries, a bounded number of times,
    // after a lock that was released or taken over under it.
    const retryNow = waitMs > 0 || tries < 3;
    let dead: boolean;
    try {
      dead = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      if (retryNow) continue; // released between the open and the stat
      return false;
    }
    if (dead && takeOverDeadLock(lock) && retryNow) continue;
    if (Date.now() >= deadline) return false;
    sleepSync(10);
  }
};

/**
 * Runs `fn` holding the state directory's lock. The server, `git-serve pair`
 * and `git-serve connections` are separate processes that each read a state
 * file, change it and write it back; without a lock the last writer wins, and a
 * pairing racing a revocation could write the revoked connection back.
 * Not re-entrant: a function that holds the lock calls the unlocked forms.
 *
 * This form WAITS for a held lock, sleeping synchronously. It is for the
 * commands (`pair`, `connections`), never for the server's request path.
 */
export const withStateLock = <T>(root: string, fn: () => T): T => {
  const lock = join(ensureStateDir(root), LOCK_FILE);
  if (!acquireStateLock(lock, LOCK_WAIT_MS)) {
    throw new Error(`${lock} is held by another git-serve process; try again.`);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
};

/**
 * The same, for the server: it tries once and never sleeps, because a sleep
 * here would stop every other request the process is serving. `ran: false`
 * means the lock is held and `fn` was not called.
 */
export const tryWithStateLock = <T>(
  root: string,
  fn: () => T,
): { ran: true; value: T } | { ran: false } => {
  const lock = join(ensureStateDir(root), LOCK_FILE);
  if (!acquireStateLock(lock, 0)) return { ran: false };
  try {
    return { ran: true, value: fn() };
  } finally {
    rmSync(lock, { force: true });
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
