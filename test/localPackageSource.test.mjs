// R3-567 — deriving the lockset and package content from the runner's own `node_modules`
// instead of from the dependency CDN.
//
// THE CASE THAT MATTERS IS DIFFERENTIAL. `buildLocalPackage` reconstructs a shape produced
// by a service whose source we cannot read, so a test comparing its output to my own
// expectations would only prove it agrees with itself. Instead it is compared against the
// CDN's verbatim `/package/` response for the same package, frozen in `test/fixtures`
// beside that package exactly as npm installs it.
//
// `0.2.1` is the fixture version precisely because the CDN still resolves it — the outage
// this work exists for is that a FRESH version does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode as decodeMsgPack } from '@msgpack/msgpack';

import {
  buildLocalPackage,
  resolveFromInstalledTree,
  resolvePackageDir,
  satisfies,
  cjsEntry,
  encodeLocalPackage,
} from '../dist/localPackageSource.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/omnibox-0.2.1');
const CDN = decodeMsgPack(new Uint8Array(readFileSync(join(here, 'fixtures/omnibox-0.2.1.cdn.msgpack'))));

// A SECOND fixture, because the first cannot discriminate. `omnibox` has one `.` export,
// so seeding the closure from `main` alone looked correct against it — while `react` has
// `./jsx-runtime`, `./jsx-dev-runtime` and `./compiler-runtime`, whose closures a
// main-only seed misses entirely. Review found that with a live diff; this is the case
// that would have found it here.
const REACT = join(here, 'fixtures/react-19.2.6');
const REACT_CDN = decodeMsgPack(new Uint8Array(readFileSync(join(here, 'fixtures/react-19.2.6.cdn.msgpack'))));

const kindOf = (v) => (typeof v === 'number' ? 'size' : 'content');

/** Files the CDN ships with content that we do NOT — the only asymmetry that is unsafe. */
const underInlined = (cdn, local) =>
  Object.keys(cdn.f).filter((p) => kindOf(cdn.f[p]) === 'content' && kindOf(local.f[p]) !== 'content');

// The scanner the CLI actually ships, driven through the real thing rather than a
// convenience regex — this test is what keeps that copy honest against the CDN.
import { scanCjsModule } from '../dist/vendor/cjsScan/scan.js';

const sorted = (a) => [...a].sort();

// FIRST, because everything below is meaningless without it. `dist` is gitignored in this
// repo and the fixture IS a published package's dist, so `git add` silently committed 4 of
// its 29 files: green locally, red in CI, on a fixture that looked present. The negation in
// .gitignore is the fix; this is the guard that would have named it in one line instead of
// as a confusing assertion failure three tests later.
test('the fixture is intact — a partial checkout fails HERE, by name', () => {
  const missing = Object.keys(CDN.f).filter((rel) => {
    try {
      readFileSync(join(FIXTURE, rel));
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    missing,
    [],
    `test/fixtures/omnibox-0.2.1 is incomplete — ${missing.length} of ${Object.keys(CDN.f).length} files absent. ` +
      'Check .gitignore: this fixture is a package dist.',
  );
});

test('the local build carries exactly the files the CDN carries', () => {
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  assert.deepEqual(sorted(Object.keys(local.f)), sorted(Object.keys(CDN.f)));
});

test('NEVER ships a size where the CDN ships content — the only unsafe direction', () => {
  // THE SAFETY PROPERTY, and it is a superset rather than equality on purpose.
  //
  // A file the CDN ships with content is one the runtime may EVALUATE, and a bundled
  // module is marked precompiled — so recording a size where the CDN records content
  // leaves the bundler with no source. `RegistryFS` then treats the entry as existing and
  // lazily fetches its bytes FROM UNPKG, one blocking round trip per file on every cold
  // boot: one third-party boot dependency silently traded for another, which is the exact
  // opposite of this module's purpose.
  //
  // The converse costs bytes and nothing else, and it is unavoidable: the CDN EVALUATES
  // `process.env.NODE_ENV` and keeps one branch of `require(dev) / require(prod)`, which a
  // static scan cannot do. Asserting equality would mean guessing at a heuristic we cannot
  // read; asserting the superset states exactly the property that matters.
  for (const [name, fixture, cdn] of [
    ['omnibox', FIXTURE, CDN],
    ['react', REACT, REACT_CDN],
  ]) {
    const local = buildLocalPackage(fixture, scanCjsModule);
    assert.deepEqual(underInlined(cdn, local), [], `${name}: these would be fetched from unpkg at boot`);
  }
});

test('the over-inclusion stays bounded — it is bytes, but it is not unbounded', () => {
  // Superset is safe, so this is the number that keeps it honest: if the seed ever widened
  // to "inline everything", the zip would carry a package's ESM build, sourcemaps and
  // typings for nothing, and the 50 MB host cap (ZIP_CACHE_AUTOMATION_SPEC §8) would start
  // to matter.
  const bytes = (m) => Object.values(m.f).reduce((n, v) => n + (typeof v === 'object' ? v.c.length : 0), 0);
  for (const [name, fixture, cdn] of [
    ['omnibox', FIXTURE, CDN],
    ['react', REACT, REACT_CDN],
  ]) {
    const local = buildLocalPackage(fixture, scanCjsModule);
    const ratio = bytes(local) / bytes(cdn);
    assert.ok(ratio < 2.5, `${name}: inlined ${bytes(local)} vs the CDN's ${bytes(cdn)} (${ratio.toFixed(2)}×)`);
  }
});

test('react/jsx-runtime is inlined — the multi-entry case a main-only seed misses', () => {
  // Named explicitly because this is the regression, not a general property: seeding only
  // from `main` shipped `jsx-runtime.js` as a size, and every React app imports it.
  const local = buildLocalPackage(REACT, scanCjsModule);
  assert.equal(kindOf(local.f['jsx-runtime.js']), 'content');
  assert.equal(kindOf(local.f['cjs/react-jsx-runtime.development.js']), 'content');
});

test('…and the same `d` for every file that ships content (order is not semantic)', () => {
  // `d` must be EXACT, and this is the case that says so. The runtime constructs a bundled
  // module with `isCompiled = true`, so `transformModule` short-circuits and never scans
  // it: `file.d` is the ONLY source of that module's dependency graph. Order is compared
  // as a set because the consumer is `file.d.map(dep => addDependency(dep))` — it affects
  // transform scheduling, nothing observable.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  for (const [path, cdnFile] of Object.entries(CDN.f)) {
    if (typeof cdnFile === 'number') continue;
    // A SUPERSET again, for the same reason: the CDN resolves the NODE_ENV branch and we
    // scan statically, so ours also lists `./cjs/x.production.js`. Every dependency the CDN
    // names must be present — a MISSING one is what makes `Evaluation.ts` throw
    // `Dependency "…" not collected`.
    for (const dep of cdnFile.d) {
      assert.ok(local.f[path].d.includes(dep), `${path}: local \`d\` is missing ${dep}`);
    }
  }
});

test('…and the same `t` (already-transpiled) flag for every file BOTH ship with content', () => {
  // Kept as a CDN-SHAPE check, with the reason corrected: review found nothing on the
  // consume side reads `t` at all (`_writePrecompiledModule` passes `isCompiled = true`
  // unconditionally; `grep -rn 'file\.t' sandbox/src` is empty). So this asserts we produce
  // the field the format declares, NOT that the bundler behaves differently because of it —
  // the justification I first wrote was behaviour the consumer does not have.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  const wrong = Object.entries(CDN.f)
    .filter(([p, f]) => typeof f !== 'number' && typeof local.f[p] === 'object')
    .filter(([p, f]) => local.f[p].t !== f.t)
    .map(([p, f]) => `${p}: CDN=${f.t} local=${local.f[p].t}`);
  assert.deepEqual(wrong, []);
});

test('…and the same transient dependency list', () => {
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  assert.deepEqual(sorted(local.m), sorted(CDN.m));
});

test('the bytes decode into something the runtime can actually BOOT', () => {
  // The item asked for this round-trip and the first version of these tests did not have
  // it — which is why review had to find the two blocking defects (a main-only entry seed
  // and a paraphrased scanner) with a live diff instead of a red suite. A test that only
  // checks "it encodes" cannot tell a usable package from an unusable one.
  //
  // `decodeBundledModule` is `decodeMsgPack(bytes) as ICDNModule`
  // (sandbox/src/bundler/module-registry/bundledPackages.ts:58), so decoding here is the
  // same operation; what makes this non-trivial is asserting the SHAPE the bundler then
  // walks — `_writePrecompiledModule` reads `file.c` and maps over `file.d`, and
  // `NodeModule` is constructed from `(f, m)`.
  for (const [name, fixture, entry] of [
    ['omnibox', FIXTURE, 'dist/index.cjs'],
    ['react', REACT, 'index.js'],
  ]) {
    const decoded = decodeMsgPack(encodeLocalPackage(buildLocalPackage(fixture, scanCjsModule)));
    assert.ok(decoded.f && Array.isArray(decoded.m), `${name}: not an { f, m } module`);

    const file = decoded.f[entry];
    assert.equal(typeof file, 'object', `${name}: the entry must carry content, not a size`);
    assert.equal(typeof file.c, 'string');
    assert.ok(file.c.length > 0, `${name}: the entry's content is empty`);
    assert.ok(Array.isArray(file.d), `${name}: the entry has no dependency list to walk`);

    // The property `_writePrecompiledModule` depends on and never checks: every RELATIVE
    // dependency of an inlined file must itself be inlined. A bare specifier is another
    // package (the runtime resolves it separately); a relative one that is size-only is a
    // module the bundler will ask unpkg for, mid-boot.
    const dangling = [];
    for (const [path, f] of Object.entries(decoded.f)) {
      if (typeof f === 'number') continue;
      for (const dep of f.d) {
        if (!dep.startsWith('.')) continue;
        const base = dep.replace(/^\.\//, '');
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const candidates = [base, `${base}.js`, `${base}.cjs`, `${dir}${base}`, `${dir}${base}.js`, `${dir}${base}.cjs`];
        if (!candidates.some((c) => typeof decoded.f[c] === 'object')) dangling.push(`${path} → ${dep}`);
      }
    }
    assert.deepEqual(dangling, [], `${name}: relative deps of inlined files that are not themselves inlined`);
  }
});

test('a package with no `main` falls back to index.js rather than shipping nothing', () => {
  assert.equal(cjsEntry({}), 'index.js');
  assert.equal(cjsEntry({ main: './dist/index.cjs' }), 'dist/index.cjs');
});

test('the entry closure is followed — a required sibling gains content, an unreached file does not', () => {
  // Non-vacuity for the walk itself: `index.cjs` requires `./launch`, so `launch.cjs` must
  // carry content; the ESM build is reachable from nothing and must stay a size.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  assert.equal(typeof local.f['dist/launch.cjs'], 'object', 'a required sibling must ship content');
  assert.equal(typeof local.f['dist/launch.js'], 'number', 'the unreached ESM build must stay size-only');
});

test('a version inside the repo that does NOT satisfy the declared range is rejected', () => {
  // Round 1 asked for two things and I shipped one while reporting both fixed: the walk
  // bound stops a NEIGHBOUR's copy being found; it does nothing about a wrong-version copy
  // inside the repo. The runtime cannot catch that either — the echo it matches on is the
  // range map, which still matches — so it would ship.
  const root = mkdtempSync(join(tmpdir(), 'ir-range-'));
  try {
    const dir = join(root, 'node_modules', 'gap-pkg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gap-pkg', version: '0.0.9' }));
    assert.deepEqual(resolveFromInstalledTree(root, { 'gap-pkg': '^3.0.0' }), []);
    // …and it IS accepted when it satisfies, so the case is not passing by rejecting all.
    assert.deepEqual(resolveFromInstalledTree(root, { 'gap-pkg': '^0.0.9' }), [
      { n: 'gap-pkg', v: '0.0.9', d: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('satisfies() refuses only what it is sure about', () => {
  // The permissive fallback is the load-bearing choice: rejecting wrongly costs a CDN
  // fallback (today's behaviour), accepting wrongly puts a mismatch in the lockset. So an
  // unparseable range must return TRUE and leave the decision to the CDN.
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.3.0', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('9.9.9', '>=1.0.0'), true);
  assert.equal(satisfies('0.0.9', '*'), true);
  assert.equal(satisfies('1.0.0', 'github:owner/repo'), true, 'an unjudgeable range must not be refused');
  assert.equal(satisfies('1.0.0', '1.x || 2.x'), true, 'an unsupported shape defers to the CDN');
});

test('resolveFromInstalledTree never resolves ABOVE the repo root', () => {
  // Review reproduced this: a repo with no node_modules, nested under a directory that has
  // one, resolved a FOREIGN package and shipped it in the lockset — and the runtime applied
  // it, because the echo it matches on is the RANGE map, which still matched.
  const outer = mkdtempSync(join(tmpdir(), 'ir-walkbound-'));
  try {
    const foreign = join(outer, 'node_modules', 'gap-pkg');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'gap-pkg', version: '0.0.9-FOREIGN' }));
    const repo = join(outer, 'repo');
    mkdirSync(repo, { recursive: true });

    assert.equal(resolvePackageDir('gap-pkg', repo, repo), null, 'the walk must stop at the repo root');
    assert.deepEqual(
      resolveFromInstalledTree(repo, { 'gap-pkg': '^3.0.0' }),
      [],
      'a neighbour\'s package must never enter this repo\'s lockset',
    );
    // …and without the bound it WOULD be found, which is what makes the case non-vacuous.
    assert.ok(resolvePackageDir('gap-pkg', repo), 'unbounded, the foreign copy is reachable');
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('resolveFromInstalledTree omits a package the tree does not contain, rather than inventing one', () => {
  // The completeness guard downstream (`assertDependenciesResolved`) is what turns this
  // into a loud failure; silently emitting a made-up version would bake a broken lockset.
  const resolved = resolveFromInstalledTree(join(here, '..'), { 'definitely-not-installed-xyz': '1.0.0' });
  assert.deepEqual(resolved, []);
});
