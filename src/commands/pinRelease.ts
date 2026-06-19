/*
 * `immediately.run pin-release` — resolve the UI release authoring files in a
 * `releases/` directory into fully-pinned, immutable lock artifacts plus a
 * registry `index.json` (UI_RELEASES_SPEC §5).
 *
 * Two modes:
 *   - write (default): resolve every `repo@ref` to a commit via `git ls-remote`,
 *     write `<name>.lock.json` for each release, and rebuild `index.json`.
 *     Immutable by name — re-pinning an existing name to different content is
 *     refused unless --republish.
 *   - --check (CI): no network, no writes. Verify the committed locks parse and
 *     are SHA-pinned, and that `index.json` exactly matches the locks' digests.
 *     This is what the gh-pages publish workflow runs — so the Pages-write job
 *     needs no GitHub token and can never resolve a moving ref behind review.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { flagValue, type ParsedArgs } from '../args.js';
import {
  buildIndex,
  firstPartyStripWarnings,
  flattenAuthoring,
  parseBindingId,
  resolveLock,
  serializeIndex,
  serializeLock,
  type BuildDefaultRef,
  type ReleaseAuthoring,
  type ReleaseLock,
} from '../release.js';

/** The host's build-default manifest for the §6.1b strip lint (region → repo scope
 *  + first-party-only ceiling). Empty today: the registry's first-party-only set is
 *  empty as of R3-33d, so the lint is vacuous until site-main exports this (or a
 *  capability becomes first-party-only again). Wiring it from the host is a follow-on. */
const HOST_BUILD_DEFAULTS: Record<string, BuildDefaultRef> = {};

export const PIN_RELEASE_USAGE = `Usage: immediately.run pin-release [options]

Resolve UI release authoring files into pinned lock artifacts + a registry index
(UI_RELEASES_SPEC §5). Authoring files are <name>.json in the releases dir; the
outputs are <name>.lock.json (fully commit-pinned) and index.json.

Options:
  --dir <path>     Releases directory (default: ./releases)
  --check          Validate committed locks/index without network or writes (CI)
  --republish      Allow overwriting an existing lock whose content changed
  -h, --help       Show this help`;

const COMMIT_RE = /^[0-9a-f]{40}$/i;

const isAuthoringFile = (f: string): boolean =>
  f.endsWith('.json') && !f.endsWith('.lock.json') && f !== 'index.json';

const readAuthoring = (dir: string): ReleaseAuthoring[] => {
  const files = readdirSync(dir).filter(isAuthoringFile).sort();
  return files.map((f) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      throw new Error(`${f}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const a = parsed as ReleaseAuthoring;
    const expectedId = f.replace(/\.json$/, '');
    if (a.id !== expectedId) {
      throw new Error(`${f}: id "${a.id}" must match filename ("${expectedId}")`);
    }
    if (!a.apps || typeof a.apps !== 'object') {
      throw new Error(`${f}: missing "apps" map`);
    }
    return a;
  });
};

/** Structural validation shared by both modes: extends resolve + every app id parses. */
const validateAuthoring = (authoring: ReleaseAuthoring[]): Map<string, Record<string, string>> => {
  const bases = new Map(authoring.map((a) => [a.id, a]));
  const flattened = new Map<string, Record<string, string>>();
  for (const a of authoring) {
    const flat = flattenAuthoring(a, bases);
    for (const [region, id] of Object.entries(flat)) {
      try {
        parseBindingId(id);
      } catch (err) {
        throw new Error(
          `release "${a.id}" region "${region}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    flattened.set(a.id, flat);
  }
  return flattened;
};

const assertLockValid = (lock: ReleaseLock, name: string): void => {
  if (lock.schemaVersion !== 1) throw new Error(`${name}: bad schemaVersion`);
  if (!lock.apps || typeof lock.apps !== 'object') throw new Error(`${name}: missing apps`);
  for (const [region, e] of Object.entries(lock.apps)) {
    if (!e || typeof e.repo !== 'string') throw new Error(`${name}: region ${region} missing repo`);
    if (typeof e.commit !== 'string' || !COMMIT_RE.test(e.commit)) {
      throw new Error(`${name}: region ${region} is not SHA-pinned`);
    }
    parseBindingId(e.repo);
  }
};

export interface PinReleaseOptions {
  dir: string;
  check?: boolean;
  republish?: boolean;
}

export const runPinRelease = async (args: ParsedArgs): Promise<number> => {
  if (args.flags.help || args.flags.h) {
    console.log(PIN_RELEASE_USAGE);
    return 0;
  }
  const dir = resolve(flagValue(args.flags, 'dir') ?? 'releases');
  const check = args.flags.check === true;
  const republish = args.flags.republish === true;

  const authoring = readAuthoring(dir);
  if (authoring.length === 0) {
    console.error(`pin-release: no authoring files (<name>.json) found in ${dir}`);
    return 1;
  }
  const flattened = validateAuthoring(authoring);

  // §5 step-3a lint (UI_RELEASES_SPEC §6.1b): warn (non-blocking) when a repoint
  // will strip first-party-only caps at resolution. The host build-default manifest
  // is empty today (the registry's first-party-only set is empty as of R3-33d), so
  // this is vacuous until that manifest is exported from site-main / a cap is
  // first-party-only again — but the lint runs in BOTH modes so the warning lands
  // the moment it has something to say.
  for (const w of firstPartyStripWarnings(
    Object.fromEntries(flattened),
    HOST_BUILD_DEFAULTS,
  )) {
    console.warn(
      `pin-release lint: release "${w.release}" region "${w.region}" repoints ` +
        `${w.fromRepo} → ${w.toRepo}; first-party-only caps will be STRIPPED at ` +
        `resolution (§6.1b): ${w.strippedCaps.join(', ')}`,
    );
  }

  if (check) return runCheck(dir, authoring);

  // ---- write mode: resolve refs → commits, write locks, rebuild index ------
  const locks: { id: string; lockText: string; label?: string }[] = [];
  for (const a of authoring) {
    const lock = resolveLock(a, flattened.get(a.id)!);
    const lockText = serializeLock(lock);
    const lockPath = join(dir, `${a.id}.lock.json`);
    let existing: string | undefined;
    try {
      existing = readFileSync(lockPath, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && existing !== lockText && !republish) {
      console.error(
        `pin-release: "${a.id}" would change but is immutable.\n` +
          `  A published release name is frozen (UI_RELEASES_SPEC §3.3). To pin a\n` +
          `  new composition, add a new name; to correct this one, pass --republish.`,
      );
      return 1;
    }
    if (existing !== lockText) writeFileSync(lockPath, lockText);
    locks.push({ id: a.id, lockText, label: a.label });
  }

  const index = buildIndex(locks);
  writeFileSync(join(dir, 'index.json'), serializeIndex(index));

  console.log(`pin-release: wrote ${locks.length} lock(s) + index.json to ${dir}`);
  for (const l of locks) {
    console.log(`  ${l.id.padEnd(20)} ${index.releases[l.id]!.sha256.slice(0, 12)}…`);
  }
  return 0;
};

const runCheck = (dir: string, authoring: ReleaseAuthoring[]): number => {
  const problems: string[] = [];
  const locks: { id: string; lockText: string; label?: string }[] = [];

  for (const a of authoring) {
    const lockPath = join(dir, `${a.id}.lock.json`);
    let lockText: string;
    try {
      lockText = readFileSync(lockPath, 'utf8');
    } catch {
      problems.push(`missing lock for "${a.id}" (run pin-release to generate ${a.id}.lock.json)`);
      continue;
    }
    try {
      assertLockValid(JSON.parse(lockText) as ReleaseLock, `${a.id}.lock.json`);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    locks.push({ id: a.id, lockText, label: a.label });
  }

  // index.json must exactly equal the index rebuilt from the committed locks.
  let committedIndex: string;
  try {
    committedIndex = readFileSync(join(dir, 'index.json'), 'utf8');
  } catch {
    problems.push('missing index.json (run pin-release to generate it)');
    committedIndex = '';
  }
  const expectedIndex = serializeIndex(buildIndex(locks));
  if (committedIndex && committedIndex !== expectedIndex) {
    problems.push('index.json is out of date or has wrong digests (run pin-release to regenerate)');
  }

  if (problems.length) {
    console.error('pin-release --check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`pin-release --check: ${locks.length} release(s) consistent with index.json`);
  return 0;
};
