#!/usr/bin/env node
/*
 * If this version is ALREADY on npm, what we would publish must declare the same
 * install surface as what IS published.
 *
 * `ci.yml`'s publish step skips when `package.json`'s version already exists, and
 * says so with a `::notice::` — not a failure. That skip is correct (a re-run of
 * an old commit must not try to republish) and it is also how `main` and the
 * published package drifted apart for weeks without a single red build in a
 * consumer repo (grove): an SDK pin moved from `^0.52.0` to `^0.65.0` on `main`,
 * the version was never bumped, so the published package kept declaring the old
 * pin. Every consumer installing it got the OLD pin, npm nested a second copy,
 * and R3-556 — which composes that package — was blocked by it with nothing
 * anywhere reporting a problem.
 *
 * The invariant this restores: a skip is benign only when it is a NO-OP. Same
 * version, different declarations, means the version number is a lie and the fix
 * is to bump it.
 *
 * ## The payload half — closed here by R3-756, after the determinism proof
 *
 * grove's copy of this script (`immediately-run/grove`,
 * `scripts/check-published-parity.mjs`) compares the per-entry packed payload
 * (R3-751), closing the second half of the hole: a change under an
 * already-published version with an unchanged manifest still passed this
 * comparison and let the publish step skip silently. This script now does the
 * same — the port R3-756 owns. It could not be copied blind: the CLI publishes
 * built `dist`, so a payload compare is only sound if the build is reproducible
 * (same input tree, same output bytes), and that is PROVEN first by
 * `scripts/check-build-reproducible.mjs` (two builds of one tree,
 * byte-identical), which runs beside this check in `verify`. The payload compare
 * needs a built `dist/`: without one it is the cannot-answer case (exit 2;
 * `--offline-ok` downgrades it like an unreadable registry — a line says the
 * comparison never ran), never a pass that looks like parity.
 *
 * ## The four copies, and which are closed
 *
 * This check exists in four repos over the same hole; this header is the
 * hand-off ledger so none of them can read as org-wide closure:
 *   - `immediately-run/grove` — closed by R3-751;
 *   - `immediately-run-sdk` (root) — closed by R3-755 (with its own
 *     determinism proof, `check-build-reproducible.mjs`);
 *   - `immediately-run-cli` (this script) — closed by R3-756;
 *   - `immediately-run-sdk/safe-content` — closed by R3-756, in the SDK repo.
 *
 * ## What is compared, and what cannot be
 *
 * The dependency blocks, plus `main` and `exports`: the parts of the manifest a
 * consumer's install and resolution actually read, so a difference there changes
 * what is on a consumer's disk or which file they get when they import.
 * `devDependencies` is excluded because it is never on a consumer's disk.
 * `files` is excluded from the MANIFEST comparison because npm does not keep it
 * in the packument — but the payload itself is compared since R3-756: per-entry
 * content digests of `npm pack` on both sides, `package.json` included, when the
 * version is already published and the manifest is at parity. Tarball bytes are
 * never compared — gzip framing, mtimes, uid/gid and mode differ on every pack
 * of identical content; the file contents are exact.
 *
 * ## Where it runs, and why in more than one place
 *
 * `verify`/`test` (through `check:published`, after `npm run build` — the test
 * chain builds first, so the payload half compares real bytes), and the release
 * job's already-published branch runs it strictly (no `--offline-ok`): a drift
 * there means the release about to be skipped would silently no-op. A version
 * not yet published is the ordinary state everywhere — exit 0, nothing to
 * compare.
 *
 * Usage: node scripts/check-published-parity.mjs [--self-test] [--offline-ok]
 * Exit:  0 parity (manifest and, when a built dist exists, payload), or this
 *        version is not published yet (nothing to compare)
 *        1 drift — same version, different manifest declarations or a different
 *        packed payload
 *        2 cannot answer (registry unreadable, offline, malformed reply; or the
 *        payload comparison could not run — no built dist)
 *          …unless --offline-ok, which downgrades ONLY that case to 0.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digestDrift, treeDigests } from './lib/treeCompare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The dependency blocks a consumer's install resolves against. */
const BLOCKS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
/** Non-block fields that decide WHICH FILE a consumer's import lands on. */
const FIELDS = ['main', 'exports'];

/** Stable stringify, so key ORDER is not reported as a difference. */
const stable = (v) => {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(',')}}`;
};

/**
 * Compare two manifests' install surface.
 *
 * Returns the differences as `{ block, name, published, local }` rows — empty
 * means parity. A missing block on either side is the empty object, never a
 * reason to skip the comparison: dropping `peerDependencies` wholesale is
 * exactly the kind of change that must not ride an unbumped version.
 */
export function dependencyDrift(published, local) {
  const rows = [];
  for (const block of BLOCKS) {
    const p = published?.[block] ?? {};
    const l = local?.[block] ?? {};
    for (const name of [...new Set([...Object.keys(p), ...Object.keys(l)])].sort()) {
      if (p[name] !== l[name]) {
        rows.push({ block, name, published: p[name] ?? '(absent)', local: l[name] ?? '(absent)' });
      }
    }
  }
  for (const field of FIELDS) {
    const p = stable(published?.[field]);
    const l = stable(local?.[field]);
    if (p !== l) rows.push({ block: '(root)', name: field, published: p ?? '(absent)', local: l ?? '(absent)' });
  }
  return rows;
}

/**
 * What the registry's answer MEANS — pure, so every branch is testable without a
 * network. `npm view <spec> … --json` has three shapes worth telling apart, and
 * the first two both exit non-zero, which is why the exit code alone is not the
 * answer:
 *
 *  - **absent** — the version is not published. npm prints `{"error":{"code":"E404"}}`
 *    to STDOUT and exits non-zero. There is nothing to compare, and on a pull
 *    request this is the ordinary state, so it is a pass.
 *  - **unreadable** — no network, a private-registry auth failure, a malformed
 *    reply. Never a pass on its own: the publish job only reaches this once
 *    `npm view` has already said the version EXISTS, so failing to read it there
 *    is a real problem.
 *  - **published** — a JSON object of the requested fields. EMPTY stdout is this
 *    case too, and means a manifest declaring none of them.
 */
export function classifyRegistryReply({ stdout, failed }) {
  const text = (stdout ?? '').trim();
  if (text === '') return failed ? { kind: 'unreadable', reason: 'empty reply' } : { kind: 'published', manifest: {} };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'reply was not JSON' };
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    return parsed.error.code === 'E404'
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: parsed.error.summary ?? parsed.error.code ?? 'registry error' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'reply was not an object' };
  }
  return { kind: 'published', manifest: parsed };
}

/**
 * Compare two packed payloads, per entry — the port of grove's R3-751 gate
 * (R3-756). Takes two `Map<string, string>` of package-relative path → content
 * digest, as `entryDigests` returns. Returns the differences as
 * `{ path, published, local }` rows — empty means parity. A path on one side
 * only is a row reading `(absent)` on the other, in both directions: an
 * added-only change must not be silent.
 */
export function payloadDrift(published, local) {
  return digestDrift(published, local).map(({ path, first, second }) => ({ path, published: first, local: second }));
}

/**
 * The impure half, one function: extract one packed tarball into a temp
 * directory this script creates and removes, and return `Map<package-relative
 * path, content digest>`. `tar` extracts with `--strip-components 1` so the
 * archive's `package/` prefix is gone and keys are package-root-relative
 * (`package.json`, `dist/cli.js`, …). Bounded like every other process this
 * script spawns. Shells out to `tar -xzf` as the script shells out to `npm` —
 * no new dependency.
 */
export function entryDigests(tarballPath) {
  const dir = mkdtempSync(join(tmpdir(), 'published-parity-payload-'));
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', dir, '--strip-components', '1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
    return treeDigests(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The one tarball in a directory `npm pack` was pointed at. Thrown as its own
 * error so the "packed nothing" failure has a name the self-test can pin.
 */
export function onlyTarball(dir) {
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack wrote no tarball');
  return tarball;
}

/**
 * Pack one side into a fresh temp directory and return the tarball's path. Both
 * payload sides come from `npm pack` so they are by construction the `files:`
 * payload, and the published side uses the same code path as the local side (npm
 * downloads the registry tarball for a `<name>@<version>` spec). A fresh
 * directory per side, because the published tarball and the local pack have the
 * SAME filename and would collide.
 */
function packTarball(spec, cwd) {
  const dest = mkdtempSync(join(tmpdir(), 'published-parity-pack-'));
  try {
    execFileSync('npm', ['pack', ...spec, '--pack-destination', dest], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 180_000,
    });
    return { dir: dest, tarball: join(dest, onlyTarball(dest)) };
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/**
 * The one cannot-answer shape, shared by every site that cannot run a
 * comparison: a registry read that would not answer, and a payload comparison
 * that could not run. Both mean "parity was NOT checked", both are exit 2, and
 * `--offline-ok` downgrades ONLY this case — never a drift — with a line that
 * says the comparison never ran.
 */
function cannotAnswerExit(subject, reason, offlineOk) {
  console.error(
    offlineOk
      ? `⚠ could not ${subject} (${reason}) — parity was NOT checked. ` +
          `Not failing the build (--offline-ok); the publish job checks this strictly.`
      : `✗ cannot ${subject} (${reason}) — not answering is not a pass.`,
  );
  return offlineOk ? 0 : 2;
}

function selfTest() {
  let ok = 0;
  let total = 0;
  const check = (label, cond) => {
    total += 1;
    if (cond) ok += 1;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const dep = (o) => ({ dependencies: o });

  // ── the comparison ─────────────────────────────────────────────────────────
  check('identical manifests have no drift', dependencyDrift(dep({ a: '1.0.0' }), dep({ a: '1.0.0' })).length === 0);
  // The R3-556 case, verbatim.
  const moved = dependencyDrift(dep({ '@immediately-run/sdk': '^0.52.0' }), dep({ '@immediately-run/sdk': '^0.65.0' }));
  check('a moved pin is drift', moved.length === 1);
  check('…and names both sides', moved[0].published === '^0.52.0' && moved[0].local === '^0.65.0');
  check('an ADDED dependency is drift', dependencyDrift(dep({}), dep({ a: '1.0.0' }))[0]?.local === '1.0.0');
  check('a REMOVED dependency is drift', dependencyDrift(dep({ a: '1.0.0' }), dep({}))[0]?.local === '(absent)');
  check(
    'a peer moved while the dependency stayed is still drift',
    dependencyDrift(
      { dependencies: { a: '1.0.0' }, peerDependencies: { a: '^1.0.0' } },
      { dependencies: { a: '1.0.0' }, peerDependencies: { a: '^2.0.0' } },
    ).length === 1,
  );
  check(
    'dropping peerDependencies entirely is drift, not an excuse to skip',
    dependencyDrift({ peerDependencies: { a: '^1.0.0' } }, {}).length === 1,
  );
  check(
    'devDependencies are not compared — they are not on a consumer disk',
    dependencyDrift({ devDependencies: { a: '1' } }, { devDependencies: { a: '2' } }).length === 0,
  );
  check('order does not matter', dependencyDrift(dep({ a: '1', b: '2' }), dep({ b: '2', a: '1' })).length === 0);
  // `main`/`exports` decide which FILE an import lands on, so they are the same
  // class of change as a moved pin — and an exports map is nested, hence the
  // stable compare.
  check('a moved `main` is drift', dependencyDrift({ main: 'src/a.tsx' }, { main: 'src/b.tsx' }).length === 1);
  check(
    'a changed `exports` subpath is drift',
    dependencyDrift({ exports: { '.': './a.ts' } }, { exports: { '.': './b.ts' } }).length === 1,
  );
  check(
    'an ADDED `exports` subpath is drift',
    dependencyDrift({ exports: { '.': './a.ts' } }, { exports: { '.': './a.ts', './x': './x.ts' } }).length === 1,
  );
  check(
    'the same exports map in a different key order is NOT drift',
    dependencyDrift(
      { exports: { '.': './a.ts', './x': './x.ts' } },
      { exports: { './x': './x.ts', '.': './a.ts' } },
    ).length === 0,
  );

  // ── what the registry's answer means ───────────────────────────────────────
  // The E404 body is the REAL one, captured from
  // `npm view @immediately-run/cli@0.0.0-nonexistent dependencies --json` — not a
  // hand-written approximation of it.
  const e404 = JSON.stringify({
    error: {
      code: 'E404',
      summary: 'No match found for version 0.0.0-nonexistent',
      detail:
        "The requested resource '@immediately-run/cli@0.0.0-nonexistent' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url.",
    },
  });
  check(
    'an E404 body is ABSENT, not unreadable',
    classifyRegistryReply({ stdout: e404, failed: true }).kind === 'absent',
  );
  // The published body is equally real: the SAME argv this script sends (`BLOCKS`
  // + `FIELDS`), against @immediately-run/cli@0.9.0, captured 2026-09-21. This
  // package declares no `main` and no peer deps, so a narrower fixture would not
  // exercise the "absent blocks read as empty, never as an excuse" half of the
  // comparison.
  const real = JSON.stringify({
    dependencies: {
      '@immediately-run/platform-constants': '0.2.0',
      '@immediately-run/transpiler': '0.9.0',
      '@msgpack/msgpack': '^3.1.3',
      'core-js': '3.22.7',
      'react-error-boundary': '^6.1.0',
      'react-refresh': '^0.11.0',
    },
    exports: {
      './package.json': './package.json',
    },
  });
  const pub = classifyRegistryReply({ stdout: real, failed: false });
  check('a real packument reply is PUBLISHED', pub.kind === 'published');
  check(
    'an absent-blocks manifest is published-with-nothing, not unreadable',
    classifyRegistryReply({ stdout: '', failed: false }).kind === 'published',
  );
  check(
    '…which then reads every local block as ADDED',
    dependencyDrift(classifyRegistryReply({ stdout: '', failed: false }).manifest, dep({ a: '1' })).length === 1,
  );
  check(
    'an empty reply that FAILED is unreadable',
    classifyRegistryReply({ stdout: '', failed: true }).kind === 'unreadable',
  );
  check(
    'a non-E404 registry error is unreadable, never absent',
    classifyRegistryReply({
      stdout: JSON.stringify({ error: { code: 'E401', summary: 'auth' } }),
      failed: true,
    }).kind === 'unreadable',
  );
  check(
    'a non-JSON reply is unreadable',
    classifyRegistryReply({ stdout: '<html>502</html>', failed: true }).kind === 'unreadable',
  );
  check(
    'a JSON ARRAY reply is unreadable, not an empty manifest',
    classifyRegistryReply({ stdout: '["0.1.1","0.1.2"]', failed: false }).kind === 'unreadable',
  );

  // ── the payload comparison (R3-756) ────────────────────────────────────────
  const map = (o) => new Map(Object.entries(o));
  check(
    'identical payload Maps have no drift',
    payloadDrift(map({ a: 'h1', b: 'h2' }), map({ b: 'h2', a: 'h1' })).length === 0,
  );
  const changed = payloadDrift(map({ a: 'h1', b: 'h2' }), map({ a: 'h9', b: 'h2' }));
  check(
    'a changed digest is one row naming the path and both digests',
    changed.length === 1 && changed[0].path === 'a' && changed[0].published === 'h1' && changed[0].local === 'h9',
  );
  const added = payloadDrift(map({ a: 'h1' }), map({ a: 'h1', 'dist/new.js': 'h2' }));
  check(
    'an ADDED file is a row, (absent) on the published side',
    added.length === 1 &&
      added[0].path === 'dist/new.js' &&
      added[0].published === '(absent)' &&
      added[0].local === 'h2',
  );
  const removed = payloadDrift(map({ 'dist/old.js': 'h1' }), map({}));
  check(
    'a REMOVED file is a row, (absent) on the local side',
    removed.length === 1 &&
      removed[0].path === 'dist/old.js' &&
      removed[0].published === 'h1' &&
      removed[0].local === '(absent)',
  );

  // The digest walk, pinned against DIRECT hashes of a synthetic tree (a file,
  // and a file one level down): a `fileDigest` that returned a constant, or a
  // `treeDigests` that skipped subdirectories, would leave every real-pack case
  // green — the gate could silently never fire, the exact failure R3-751 closes.
  const synthDir = mkdtempSync(join(tmpdir(), 'published-parity-synth-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'published-parity-empty-'));
  let packed;
  try {
    let threw = null;
    try {
      onlyTarball(emptyDir);
    } catch (e) {
      threw = e;
    }
    check(
      'onlyTarball refuses a directory with no tarball, by name',
      threw instanceof Error && threw.message === 'npm pack wrote no tarball',
    );

    mkdirSync(join(synthDir, 'package', 'dist', 'sub'), { recursive: true });
    writeFileSync(join(synthDir, 'package', 'package.json'), '{"name":"s"}');
    writeFileSync(join(synthDir, 'package', 'dist', 'a.js'), 'alpha');
    writeFileSync(join(synthDir, 'package', 'dist', 'sub', 'b.js'), 'beta');
    execFileSync('tar', ['-czf', join(synthDir, 'synth.tgz'), '-C', synthDir, 'package'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });
    const synth = entryDigests(join(synthDir, 'synth.tgz'));
    const direct = (p) =>
      createHash('sha256')
        .update(readFileSync(join(synthDir, 'package', p)))
        .digest('hex');
    check(
      'entryDigests returns the exact content digests, nested keys included',
      synth.size === 3 &&
        synth.get('package.json') === direct('package.json') &&
        synth.get('dist/a.js') === direct('dist/a.js') &&
        synth.get('dist/sub/b.js') === direct('dist/sub/b.js'),
    );

    // Real producer: pack THIS tree through the production `packTarball` path and
    // pin the digests of the shipped payload against direct hashes — a hand-typed
    // Map would stay green with the digest function deleted, and an inline
    // duplicate of the pack call would stay green with `packTarball` deleted. This
    // repo's payload is the BUILT `dist`, so the case runs only where a build
    // exists (`npm test`/`verify` reach it after `npm run build`; elsewhere it
    // prints an honest SKIP).
    if (existsSync(join(ROOT, 'dist'))) {
      packed = packTarball([], ROOT);
      const real = entryDigests(packed.tarball);
      const directReal = (p) =>
        createHash('sha256')
          .update(readFileSync(join(ROOT, p)))
          .digest('hex');
      check(
        'entryDigests reads a real pack of this BUILD (package.json + built dist, exact digests)',
        real.get('package.json') === directReal('package.json') &&
          real.get('dist/cli.js') === directReal('dist/cli.js'),
      );
      check('…and the identical-tree case has no drift', payloadDrift(real, real).length === 0);
    } else {
      console.log('SKIP  real-payload case — no built dist/ (runs after `npm run build`)');
    }

    // The one downgrade policy, called directly: strict is exit 2 with the honest
    // line, `--offline-ok` is exit 0 and says the comparison never ran. A flipped
    // ternary or a re-pasted message turns these red.
    const seen = [];
    const realError = console.error;
    console.error = (m) => seen.push(m);
    const strictCode = cannotAnswerExit('read X from the registry', 'boom', false);
    const offlineCode = cannotAnswerExit('read X from the registry', 'boom', true);
    console.error = realError;
    check(
      'cannotAnswerExit: strict is 2 and names what did not answer; --offline-ok is 0 and says parity was NOT checked',
      strictCode === 2 &&
        seen[0].includes('read X from the registry') &&
        seen[0].includes('not answering is not a pass') &&
        offlineCode === 0 &&
        seen[1].includes('parity was NOT checked'),
    );
  } finally {
    for (const dir of [synthDir, emptyDir, packed?.dir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${ok}/${total} self-test cases.`);
  return ok === total ? 0 : 1;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

const offlineOk = process.argv.includes('--offline-ok');
const local = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const spec = `${local.name}@${local.version}`;

let stdout = '';
let failed = false;
try {
  stdout = execFileSync('npm', ['view', spec, ...BLOCKS, ...FIELDS, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // The repo's only outbound call. Without a bound, a hung registry read holds
    // the job to its ceiling; a kill lands in the catch below and reads as
    // unreadable.
    timeout: 30_000,
  });
} catch (e) {
  failed = true;
  stdout = typeof e?.stdout === 'string' ? e.stdout : '';
}

const reply = classifyRegistryReply({ stdout, failed });

if (reply.kind === 'absent') {
  console.log(`✓ ${spec} is not published yet — nothing to compare.`);
  process.exit(0);
}

if (reply.kind === 'unreadable') {
  // Under `--offline-ok` this IS a pass — the build is deliberately not failed
  // for a registry that would not answer — and a log that says "not answering is
  // not a pass" beside a zero exit tells a reader the opposite of what happened,
  // and hides that the comparison never ran at all. The one cannot-answer shape
  // lives in `cannotAnswerExit`.
  process.exit(cannotAnswerExit(`read ${spec} from the registry`, reply.reason, offlineOk));
}

const rows = dependencyDrift(reply.manifest, local);
if (rows.length > 0) {
  console.error(
    `::error::${spec} is already published, and this tree declares a DIFFERENT install surface. ` +
      `Publishing would be skipped, so the change would never reach npm — bump the version.`,
  );
  for (const r of rows) {
    console.error(`  ${r.block}.${r.name}: published ${r.published} · here ${r.local}`);
  }
  process.exit(1);
}

// Manifest at parity — the exact hole R3-751 closed in grove and R3-756 closes
// here: a change to the BUILT payload under an already-published version passes
// everything above while every consumer keeps the old bytes. Compare the packed
// payloads, `package.json` included. The payload is the built `dist`, so a
// missing build is the cannot-answer case — never a pass that looks like parity.
//
// No `process.exit` inside the try: it terminates without unwinding, so the
// `finally` that removes the pack directories would never run and every strict
// comparison would leak both. Every path sets `exitCode` and falls through to the
// one exit at the end.
if (!existsSync(join(ROOT, 'dist'))) {
  process.exit(cannotAnswerExit('compare the packed payload', 'no built dist/ — run npm run build first', offlineOk));
}
let publishedPack;
let localPack;
let exitCode = 0;
try {
  publishedPack = packTarball([spec], ROOT);
  localPack = packTarball([], ROOT);
  const payloadRows = payloadDrift(entryDigests(publishedPack.tarball), entryDigests(localPack.tarball));
  if (payloadRows.length === 0) {
    console.log(`✓ ${spec} on npm declares the same install surface and ships the same payload as this tree.`);
  } else {
    console.error(
      `::error::${spec} is already published, and this tree's packed PAYLOAD differs from the published package ` +
        `in ${payloadRows.length} file(s). Publishing would be skipped, so the change would never reach npm — bump the version.`,
    );
    for (const r of payloadRows.slice(0, 20)) {
      const short = (d) => (d === '(absent)' ? d : `${d.slice(0, 12)}…`);
      console.error(`  ${r.path}: published ${short(r.published)} · here ${short(r.local)}`);
    }
    if (payloadRows.length > 20) console.error(`  …and ${payloadRows.length - 20} more.`);
    exitCode = 1;
  }
} catch (e) {
  exitCode = cannotAnswerExit('compare the packed payload', e instanceof Error ? e.message : String(e), offlineOk);
} finally {
  for (const pack of [publishedPack, localPack]) {
    if (pack) rmSync(pack.dir, { recursive: true, force: true });
  }
}
process.exit(exitCode);
