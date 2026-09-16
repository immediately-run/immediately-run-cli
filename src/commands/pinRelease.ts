/*
 * `immediately.run pin-release` — resolve the UI release authoring files in a
 * registry directory into fully-pinned, immutable lock artifacts plus a
 * registry `index.json` (UI_RELEASES_SPEC §5).
 *
 * Modes:
 *   - write (default): resolve every `repo@ref` to a commit via `git ls-remote`,
 *     write `<name>.lock.json` for each release, bake the registry zips for
 *     every pin (§5 step 5a, `--no-bake` to skip), and rebuild `index.json`
 *     from ALL committed locks — including names whose authoring is gone (the
 *     dated channel targets, §4.4: their locks are the history the channels
 *     repoint away from, and a rebuild that dropped them would strand every
 *     older target). Immutable by name — re-pinning an existing name to
 *     different content is refused unless --republish.
 *   - --check (CI): no network, no writes. Verify the committed locks parse and
 *     are SHA-pinned, that `index.json` exactly matches the locks' digests,
 *     that the channel map is sound (§4.4: every target published, no dual
 *     names), and that the base lock covers every region the committed derived
 *     map names (§3.1 anti-drift). This is what the gh-pages publish workflow
 *     runs — so the Pages-write job needs no GitHub token and can never resolve
 *     a moving ref behind review.
 *
 * Channel publishing (§4.4 / §5 steps 5a+7a):
 *   - `--dated <id>` writes the authoring release `<id>` under a DATED
 *     immutable name (`<id>-<YYYY-MM-DD>-<sha8>`, deterministic) instead of the
 *     plain `<id>` — the scheduled `testing` workflow's shape: same composition
 *     + same day reuses the existing lock; a move or a new day publishes a new
 *     name and abandons the old target.
 *   - `--channel <name>=<release>[,<name2>=<release2>...]` repoints the index's
 *     channel map — the ONLY mutable write this flow performs. The map is read
 *     from the committed `index.json`, updated, validated, and rebuilt in.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { flagValue, type ParsedArgs } from '../args.js';
import {
  buildIndex,
  datedLockName,
  firstPartyStripWarnings,
  flattenAuthoring,
  parseBindingId,
  resolveLock,
  serializeIndex,
  serializeLock,
  substituteDatedTargets,
  validateChannels,
  type BuildDefaultRef,
  type ReleaseAuthoring,
  type ReleaseIndex,
  type ReleaseLock,
} from '../release.js';
import { bakeSet, ensureZip } from './releaseBake.js';

/** The host's build-default manifest for the §6.1b strip lint (region → repo scope
 *  + first-party-only ceiling). Empty today: the registry's first-party-only set is
 *  empty as of R3-33d, so the lint is vacuous until site-main exports this (or a
 *  capability becomes first-party-only again). Wiring it from the host is a follow-on. */
const HOST_BUILD_DEFAULTS: Record<string, BuildDefaultRef> = {};

/** The derived base map committed by site-main's export (§3.1 anti-drift) —
 *  `{"<region>": "provider:ns/repo@ref"}`. The committed file IS the check's
 *  input; regenerating it is site-main's `export:release-base` run. */
const DERIVED_MAP_FILE = 'defaults-map.json';

/** The release whose lock the coverage assertion guards (§3.1: a collection
 *  release SHOULD cover every build-default region; the derived map records
 *  what the export produced). */
const BASE_RELEASE_ID = 'base';

export const PIN_RELEASE_USAGE = `Usage: immediately.run pin-release [options]

Resolve UI release authoring files into pinned lock artifacts + a registry index
(UI_RELEASES_SPEC §5). Authoring files are <name>.json in the registry dir; the
outputs are <name>.lock.json (fully commit-pinned), zips/<ns>/<repo>/<sha>.zip
(the §3.4 registry-hosted bytes), and index.json.

Options:
  --dir <path>            Registry directory (default: ./releases)
  --check                 Validate committed locks/index/zips-consistency without
                          network or writes (CI): digests, channels, and base-lock
                          coverage vs the committed derived map
  --republish             Allow overwriting an existing lock whose content changed
  --dated <id>            Write the release <id> under a dated immutable name
                          <id>-<YYYY-MM-DD>-<sha8> (§4.4 — the moving channel's
                          fresh target; the plain <id> lock is not written)
  --only <id>             Regenerate ONLY this authoring release's lock; every
                          other committed lock is history (read verbatim, pins
                          frozen) — the channel workflow's shape, so a testing
                          run can never republish base
  --channel a=b[,c=d]     Repoint channel(s) in index.json (§5 7a — the only
                          mutable write; targets must be published releases,
                          or the literal @dated for this run's --dated lock)
  --no-bake               Skip the §5 5a zip bake (authoring iterations; the
                          registry workflow never skips it)
  -h, --help              Show this help`;

const COMMIT_RE = /^[0-9a-f]{40}$/i;

const isAuthoringFile = (f: string): boolean =>
  f.endsWith('.json') && !f.endsWith('.lock.json') && f !== 'index.json' && f !== DERIVED_MAP_FILE;

const isLockFile = (f: string): boolean => f.endsWith('.lock.json');

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

/** Parse `--channel a=b,c=d` (comma-separated pairs; the args parser keeps the
 *  last occurrence of a repeated flag, so multi-channel updates go in one
 *  comma-separated value). Throws naming the malformed fragment. */
const parseChannelFlag = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`--channel: "${pair}" is not <channel>=<release>`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
};

/** The committed channel map, if any — write mode PRESERVES it (a plain
 *  republish of base must not wipe the testing channel) and applies --channel
 *  updates on top. */
const readCommittedChannels = (dir: string): Record<string, string> => {
  try {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as ReleaseIndex;
    return index.channels && typeof index.channels === 'object' ? { ...index.channels } : {};
  } catch {
    return {}; // absent or unreadable → an empty map the --channel updates fill
  }
};

/** Lock files in the dir whose names have no authoring present — the dated
 *  channel targets' immutable history. Read verbatim (label carried from the
 *  lock document itself, so the index rebuild reproduces it exactly); they are
 *  never rebuilt. */
const collectOrphanLocks = (
  dir: string,
  authoringIds: ReadonlySet<string>,
): { id: string; lockText: string; label?: string }[] => {
  const out: { id: string; lockText: string; label?: string }[] = [];
  for (const f of readdirSync(dir).filter(isLockFile).sort()) {
    const id = f.replace(/\.lock\.json$/, '');
    if (authoringIds.has(id)) continue;
    const lockText = readFileSync(join(dir, f), 'utf8');
    const parsed = JSON.parse(lockText) as ReleaseLock;
    assertLockValid(parsed, f);
    out.push({ id, lockText, label: parsed.label });
  }
  return out;
};

/** §3.1 anti-drift coverage (§5 --check): the base lock must cover every
 *  region the committed derived map names. Missing regions are the silent
 *  @main-fallback the map exists to prevent — name every one. Extra lock
 *  regions (hand-widened authoring) are a warning, not a failure. */
const coverageProblems = (dir: string, locks: { id: string; lockText: string }[]): string[] => {
  let map: Record<string, string>;
  try {
    map = JSON.parse(readFileSync(join(dir, DERIVED_MAP_FILE), 'utf8')) as Record<string, string>;
  } catch {
    return [`${DERIVED_MAP_FILE} missing or unreadable — run site-main's export:release-base and commit it`];
  }
  const base = locks.find((l) => l.id === BASE_RELEASE_ID);
  if (!base) return [`no "${BASE_RELEASE_ID}" lock — the coverage assertion needs the base release`];
  const baseRegions = new Set(Object.keys((JSON.parse(base.lockText) as ReleaseLock).apps));
  const missing = Object.keys(map).filter((r) => !baseRegions.has(r));
  if (missing.length) {
    return [`${BASE_RELEASE_ID}.lock.json omits ${missing.length} region(s) the derived map names: ${missing.join(', ')}`];
  }
  const extra = [...baseRegions].filter((r) => !(r in map));
  if (extra.length) {
    console.warn(
      `pin-release lint: ${BASE_RELEASE_ID} covers ${extra.length} region(s) beyond the derived map ` +
        `(hand-widened authoring? ${extra.join(', ')})`,
    );
  }
  return [];
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
  const datedId = flagValue(args.flags, 'dated');
  const onlyId = flagValue(args.flags, 'only');
  const noBake = args.flags['no-bake'] === true;
  const channelRaw = flagValue(args.flags, 'channel');

  let channelUpdates: Record<string, string> = {};
  if (channelRaw !== undefined) {
    try {
      channelUpdates = parseChannelFlag(channelRaw);
    } catch (err) {
      console.error(`pin-release: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    // The self-referencing target: `--channel testing=@dated` points at the
    // lock THIS run publishes under --dated (the workflow cannot know the
    // dated name before resolving). Only meaningful together with --dated.
    if (Object.values(channelUpdates).includes('@dated') && datedId === undefined) {
      console.error('pin-release: --channel <name>=@dated requires --dated (it names this run\'s dated lock)');
      return 1;
    }
  }

  const authoring = readAuthoring(dir);
  if (authoring.length === 0) {
    console.error(`pin-release: no authoring files (<name>.json) found in ${dir}`);
    return 1;
  }
  const flattened = validateAuthoring(authoring);
  if (datedId !== undefined && !flattened.has(datedId)) {
    console.error(`pin-release: --dated "${datedId}" matches no authoring release in ${dir}`);
    return 1;
  }
  if (onlyId !== undefined && !flattened.has(onlyId)) {
    console.error(`pin-release: --only "${onlyId}" matches no authoring release in ${dir}`);
    return 1;
  }
  if (onlyId !== undefined && datedId !== undefined && onlyId !== datedId) {
    console.error(`pin-release: --only "${onlyId}" and --dated "${datedId}" name different releases`);
    return 1;
  }

  // §5 step-3a lint (UI_RELEASES_SPEC §6.1b): warn (non-blocking) when a repoint
  // will strip first-party-only caps at resolution. The host build-default manifest
  // is empty today (the registry's first-party-only set is empty as of R3-33d, so
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

  // ---- write mode: resolve refs → commits, write locks, bake, rebuild index --
  const written: { id: string; lockText: string; label?: string }[] = [];
  let datedName: string | undefined;
  for (const a of authoring) {
    // §4.4 --only: the channel workflow regenerates exactly ONE release; every
    // other authoring's committed lock is HISTORY below (pins frozen — a
    // testing run can never republish base).
    if (onlyId !== undefined && a.id !== onlyId) continue;
    const lock = resolveLock(a, flattened.get(a.id)!);
    const lockText = serializeLock(lock);
    // §4.4 --dated: the authoring id is a TEMPLATE; the release is published
    // under a dated immutable name (deterministic — same composition + day
    // reuses the existing lock).
    const name = datedId === a.id ? datedLockName(a.id, lockText) : a.id;
    const lockPath = join(dir, `${name}.lock.json`);
    let existing: string | undefined;
    try {
      existing = readFileSync(lockPath, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && existing !== lockText && !republish) {
      console.error(
        `pin-release: "${name}" would change but is immutable.\n` +
          `  A published release name is frozen (UI_RELEASES_SPEC §3.3). To pin a\n` +
          `  new composition, add a new name; to correct this one, pass --republish.`,
      );
      return 1;
    }
    if (existing !== lockText) writeFileSync(lockPath, lockText);
    written.push({ id: name, lockText, label: a.label });
    if (datedId === a.id) datedName = name;
  }
  // --channel <name>=@dated: substitute the self-referencing target with the
  // dated name this run just published (validated below like any other).
  if (datedName !== undefined) {
    channelUpdates = substituteDatedTargets(channelUpdates, datedName);
  }

  // Immutable history: locks with no authoring (the dated targets of past
  // channel runs) stay in the index verbatim — dropping them would strand
  // every older channel target (§4.4 abandons, never deletes).
  const orphans = collectOrphanLocks(dir, new Set(written.map((w) => w.id)));

  // §5 7a — the channel map: committed map ⊕ --channel updates, validated
  // against every release the rebuilt index will carry.
  const channels = { ...readCommittedChannels(dir), ...channelUpdates };
  const allNames = new Set([...written, ...orphans].map((l) => l.id));
  try {
    validateChannels(channels, allNames);
  } catch (err) {
    console.error(`pin-release: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // §5 5a — bake the registry zips for EVERY pin the index will carry
  // (deduplicated; existing paths reused, never rebuilt).
  let baked = 0;
  let reused = 0;
  if (!noBake) {
    const allLocks = [
      ...written.map((w) => JSON.parse(w.lockText) as ReleaseLock),
      ...orphans.map((o) => JSON.parse(o.lockText) as ReleaseLock),
    ];
    for (const entry of bakeSet(allLocks)) {
      try {
        const r = await ensureZip(dir, entry);
        r.reused ? reused++ : baked++;
      } catch (err) {
        console.error(`pin-release: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
  }

  const index = buildIndex([...written, ...orphans], channels);
  writeFileSync(join(dir, 'index.json'), serializeIndex(index));

  console.log(`pin-release: wrote ${written.length} lock(s) + index.json to ${dir}`);
  for (const l of written) {
    console.log(`  ${l.id.padEnd(34)} ${index.releases[l.id]!.sha256.slice(0, 12)}…`);
  }
  if (orphans.length) console.log(`pin-release: kept ${orphans.length} historical lock(s) in the index`);
  for (const [c, t] of Object.entries(channels)) console.log(`  channel ${c} → ${t}`);
  if (!noBake) console.log(`pin-release: zips — ${baked} baked, ${reused} reused`);
  return 0;
};

const runCheck = (dir: string, authoring: ReleaseAuthoring[]): number => {
  const problems: string[] = [];
  const locks: { id: string; lockText: string; label?: string }[] = [];

  const authoringIds = new Set(authoring.map((a) => a.id));
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

  // Historical (authoring-less) locks are part of the committed registry: they
  // must parse AND be carried by the index (label included — the rebuild must
  // reproduce the committed entry exactly), or a channel target is stranded.
  for (const o of collectOrphanLocks(dir, authoringIds)) {
    locks.push({ id: o.id, lockText: o.lockText, ...(o.label ? { label: o.label } : {}) });
  }

  // index.json must exactly equal the index rebuilt from ALL committed locks
  // and the committed channel map.
  let committedIndexText: string;
  try {
    committedIndexText = readFileSync(join(dir, 'index.json'), 'utf8');
  } catch {
    problems.push('missing index.json (run pin-release to generate it)');
    committedIndexText = '';
  }
  const committedChannels = readCommittedChannels(dir);
  try {
    validateChannels(committedChannels, new Set(locks.map((l) => l.id)));
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const expectedIndex = serializeIndex(buildIndex(locks, committedChannels));
  if (committedIndexText && committedIndexText !== expectedIndex) {
    problems.push('index.json is out of date or has wrong digests (run pin-release to regenerate)');
  }

  // §3.1 anti-drift: the base lock covers the committed derived map.
  problems.push(...coverageProblems(dir, locks));

  if (problems.length) {
    console.error('pin-release --check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    `pin-release --check: ${locks.length} release(s) consistent with index.json` +
      `${Object.keys(committedChannels).length ? ` + ${Object.keys(committedChannels).length} channel(s)` : ''}` +
      `; base coverage matches ${DERIVED_MAP_FILE}`,
  );
  return 0;
};
