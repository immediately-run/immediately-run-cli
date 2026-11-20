/*
 * The server's own state directory, `<root>/.git-serve/` (GIT_SERVE_SPEC §9).
 *
 * Directory mode 0700, files 0600. It is not a repository and is never served:
 * its name has no `.git` suffix and a repository name cannot start with a dot.
 *
 * Today it holds one file, `instanceId`: 128 random bits, minted once on first
 * start and never changed. The id is the identity input of a loopback namespace
 * (R-GS-8). It is not a secret; it only keeps two roots from presenting the
 * same app name by accident. Deleting the directory gives the root a new id,
 * and with it a new namespace, new grants and a fresh overlay.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const STATE_DIR_NAME = '.git-serve';
export const INSTANCE_ID_FILE = 'instanceId';
export const INSTANCE_ID_RE = /^[0-9a-f]{32}$/;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const stateDirOf = (root: string): string => join(root, STATE_DIR_NAME);

/** Creates the state directory if absent and returns its path. Modes are re-asserted
 *  on every start, so a directory created by hand with a wider mode is narrowed. */
export const ensureStateDir = (root: string): string => {
  const dir = stateDirOf(root);
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
      throw new Error(`${dir} exists and is not a directory; git-serve keeps its state there.`);
    }
  } else {
    mkdirSync(dir, { mode: DIR_MODE });
  }
  chmodSync(dir, DIR_MODE);
  return dir;
};

/** Reads the root's instance id, minting it on first use. */
export const loadInstanceId = (root: string): string => {
  const file = join(ensureStateDir(root), INSTANCE_ID_FILE);
  if (!existsSync(file)) {
    try {
      // `wx`: if a second start raced this one, keep whichever id landed first.
      writeFileSync(file, randomBytes(16).toString('hex') + '\n', { mode: FILE_MODE, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  chmodSync(file, FILE_MODE);
  const id = readFileSync(file, 'utf8').trim();
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(
      `${file} does not hold an instance id (32 hex characters). Delete it to mint a new one; ` +
        `the repositories under this root then mount under a new namespace.`,
    );
  }
  return id;
};
