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
  mergeResolved,
  resolveFromInstalledTree,
  resolvePackageDir,
  satisfies,
  entryPoints,
  encodeLocalPackage,
  RUNTIME_EXTENSIONS,
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
import { transformFile } from '@immediately-run/transpiler';

/** The real transpiler the runtime uses — an ESM file inlined raw breaks the app. */
const build = (dir) => buildLocalPackage(dir, scanCjsModule, transformFile);

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

test('the local build carries exactly the files the CDN carries', async () => {
  const local = await build(FIXTURE);
  assert.deepEqual(sorted(Object.keys(local.f)), sorted(Object.keys(CDN.f)));
});

test('NEVER ships a size where the CDN ships content — the only unsafe direction', async () => {
  // THE SAFETY PROPERTY, and it is a superset rather than equality on purpose.
  //
  // A file the CDN ships with content is one the runtime may EVALUATE, and a bundled
  // module is marked precompiled — so recording a size where the CDN records content
  // leaves the bundler with no source. `RegistryFS` then treats the entry as existing and
  // lazily fetches its bytes FROM UNPKG, one blocking round trip per file on every cold
  // boot: one third-party boot dependency silently traded for another, which is the exact
  // opposite of this module's purpose.
  //
  // The converse costs BYTES ONLY FOR A CJS FILE — see the ESM case below, where it costs
  // the whole app — and it is unavoidable: the CDN EVALUATES
  // `process.env.NODE_ENV` and keeps one branch of `require(dev) / require(prod)`, which a
  // static scan cannot do. Asserting equality would mean guessing at a heuristic we cannot
  // read; asserting the superset states exactly the property that matters.
  for (const [name, fixture, cdn] of [
    ['omnibox', FIXTURE, CDN],
    ['react', REACT, REACT_CDN],
  ]) {
    const local = await build(fixture);
    assert.deepEqual(underInlined(cdn, local), [], `${name}: these would be fetched from unpkg at boot`);
  }
});

test('the over-inclusion stays bounded — and sourcemaps/typings are still excluded', async () => {
  // The bound moved, deliberately, and the reason is the whole round-2 correction: we now
  // inline BOTH builds, because `MAIN_PKG_FIELDS` puts `module` first and the resolver may
  // take either. omnibox is 3.85× the CDN (it is a dual package — two whole builds), react
  // 1.79×. That is the price of not leaving an entry point size-only, which costs a
  // blocking unpkg fetch at boot.
  //
  // 5× is the ceiling because the failure it guards is a seed that widened to "inline
  // everything": what must stay OUT is the non-executable weight — sourcemaps, `.d.ts`,
  // READMEs — which is most of a package's bytes and none of its behaviour. The 50 MB host
  // cap (ZIP_CACHE_AUTOMATION_SPEC §8) is what eventually bites.
  const bytes = (m) => Object.values(m.f).reduce((n, v) => n + (typeof v === 'object' ? v.c.length : 0), 0);
  for (const [name, fixture, cdn] of [
    ['omnibox', FIXTURE, CDN],
    ['react', REACT, REACT_CDN],
  ]) {
    const local = await build(fixture);
    const ratio = bytes(local) / bytes(cdn);
    assert.ok(ratio < 5, `${name}: inlined ${bytes(local)} vs the CDN's ${bytes(cdn)} (${ratio.toFixed(2)}×)`);
    // The specific things that must never be inlined, named rather than implied.
    for (const [path, v] of Object.entries(local.f)) {
      if (/\.(map|d\.ts|d\.cts)$/.test(path) || /^(README|LICENSE)/.test(path)) {
        assert.equal(typeof v, 'number', `${name}: ${path} must stay size-only`);
      }
    }
  }
});

test('NEVER inlines raw ESM — that breaks the app, it does not cost bytes', async () => {
  // THE SAFETY MODEL MY FIRST SUITE GOT WRONG, and the reason review could remove
  // `import`/`module` from the skip list and leave every test green.
  //
  // `_writePrecompiledModule` builds EVERY content-carrying file as
  // `new Module(path, file.c, true, …)` — isCompiled, unconditionally — and nothing reads
  // `file.t`. So an inlined `import …` is handed to the bundler as finished CJS: not a
  // fallback, not a slow path, a broken app at boot. The CDN transpiles before inlining and
  // so does the sandbox's esm.sh fallback; so must this.
  for (const [name, fixture] of [
    ['omnibox', FIXTURE],
    ['react', REACT],
  ]) {
    const local = await build(fixture);
    const raw = Object.entries(local.f)
      .filter(([, v]) => typeof v === 'object')
      .filter(([, v]) => /^\s*(import|export)\s/m.test(v.c))
      .map(([p]) => p);
    assert.deepEqual(raw, [], `${name}: raw ESM inlined behind isCompiled — this app would not boot`);
  }
});

test('an ESM-only package is inlined TRANSPILED, with the deps the transpiler found', async () => {
  // The case a CJS-shaped fixture cannot reach. Built inline rather than frozen because the
  // property is about the transform, not about any one package's bytes.
  const dir = mkdtempSync(join(tmpdir(), 'ir-esm-pkg-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'esm-only', version: '1.0.0', type: 'module', module: './index.mjs' }),
    );
    writeFileSync(join(dir, 'index.mjs'), "import { helper } from './helper.mjs';\nexport const go = helper;\n");
    writeFileSync(join(dir, 'helper.mjs'), "export const helper = 1;\n");

    const local = await build(dir);
    const entry = local.f['index.mjs'];
    assert.equal(typeof entry, 'object', 'the `module` field must be seeded — the resolver prefers it');
    assert.ok(!/^\s*import\s/m.test(entry.c), 'must be transpiled, not shipped raw');
    assert.ok(entry.c.includes('require('), 'must be CJS the bundler can evaluate');
    assert.deepEqual(entry.d, ['./helper.mjs'], 'deps come from the transpiler, not a CJS scan');
    assert.equal(typeof local.f['helper.mjs'], 'object', 'and its closure is followed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an `import`-CONDITION target is inlined too — the resolver prefers ESM', async () => {
  // The case that discriminates, and my first attempt at it did not: the ESM-only fixture
  // above uses the `module` FIELD, so restoring `import`/`module` to SKIP_CONDITIONS left
  // all 19 tests green — the very hole review demonstrated. This reaches an entry ONLY
  // through the `import` condition of the exports map.
  //
  // Inlining it is not belt-and-braces: `MAIN_PKG_FIELDS = ['module','browser','main',…]`
  // means the resolver PREFERS the ESM side, so leaving it size-only is a boot-time unpkg
  // fetch for the entry point itself.
  const dir = mkdtempSync(join(tmpdir(), 'ir-cond-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dual',
        version: '1.0.0',
        exports: { '.': { import: './dist/x.mjs', require: './dist/x.cjs' } },
      }),
    );
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'x.mjs'), "export const x = 1;\n");
    writeFileSync(join(dir, 'dist', 'x.cjs'), 'module.exports = 1;\n');

    const local = await build(dir);
    assert.equal(typeof local.f['dist/x.mjs'], 'object', 'the `import` condition target must be inlined');
    assert.equal(typeof local.f['dist/x.cjs'], 'object', 'and so must the `require` one');
    assert.ok(!/^\s*export\s/m.test(local.f['dist/x.mjs'].c), 'and the ESM one transpiled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a require of a DIRECTORY follows its package.json, not just an index file', async () => {
  // Also found by fault injection: emptying the directory-package.json step left the suite
  // green, because every fixture directory happened to have an index. Node reads a nested
  // `package.json` `main`/`module` FIRST, and a package that ships one — a legacy
  // `lib/thing/package.json` re-pointing into `../../dist` is common — otherwise leaves the
  // real file size-only while `d` still names `./thing`: the module is listed and its bytes
  // are not there, which is the shape that throws `Dependency "…" not collected from "…"`.
  const dir = mkdtempSync(join(tmpdir(), 'ir-dirmain-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dirmain', version: '1.0.0', main: './index.js' }));
    writeFileSync(join(dir, 'index.js'), "module.exports = require('./sub');\n");
    mkdirSync(join(dir, 'sub'), { recursive: true });
    // Deliberately NOT an index file, and deliberately not the only candidate name.
    writeFileSync(join(dir, 'sub', 'package.json'), JSON.stringify({ main: './impl.js' }));
    writeFileSync(join(dir, 'sub', 'impl.js'), 'module.exports = 1;\n');

    const local = await build(dir);
    assert.deepEqual(local.f['index.js'].d, ['./sub'], 'the specifier stays as written');
    assert.equal(typeof local.f['sub/impl.js'], 'object', "…and the file its package.json names carries content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transpile failure REFUSES the package — it never ships a quiet hole', async () => {
  // The property fault injection found untested: deleting the `throw` left all 20 tests
  // green. It is the load-bearing one. A file the transpiler cannot handle, left as a size
  // behind an otherwise-complete package, is the worst of both worlds — the caller believes
  // it has a self-sufficient bundle and the app takes a blocking unpkg fetch at boot for the
  // one file that was hard. Refusing sends the whole package back to the CDN, which
  // `cacheZip` reports in `localRefusals`.
  const dir = mkdtempSync(join(tmpdir(), 'ir-refuse-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0', module: './index.mjs' }));
    writeFileSync(join(dir, 'index.mjs'), 'export const x = 1;\n');
    const failing = async () => ({ error: { message: 'Unexpected token' } });
    await assert.rejects(
      () => buildLocalPackage(dir, scanCjsModule, failing),
      /could not transpile 1 file\(s\).*index\.mjs.*Unexpected token/s,
      'the package must be refused, and the error must name the file and the reason',
    );
    // And the refusal is not a blanket one: the same package transpiles fine for real.
    const ok = await build(dir);
    assert.equal(typeof ok.f['index.mjs'], 'object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wildcard export is expanded against the files present', async () => {
  // `"./icons/*": "./icons/*.mjs"` is how a package declares a thousand entry points.
  // Emitting the literal `icons/*.mjs` drops all of them — most of lucide-react.
  const dir = mkdtempSync(join(tmpdir(), 'ir-wild-'));
  try {
    mkdirSync(join(dir, 'icons'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'wild', version: '1.0.0', exports: { './icons/*': './icons/*.mjs' } }),
    );
    writeFileSync(join(dir, 'icons', 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'icons', 'b.mjs'), 'export const b = 2;\n');
    const local = await build(dir);
    assert.equal(typeof local.f['icons/a.mjs'], 'object');
    assert.equal(typeof local.f['icons/b.mjs'], 'object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exports ARRAY keeps its inherited condition — numeric keys are not conditions', async () => {
  // The leak review named: `["./i.cjs", "./i.mjs"]` under `import` has keys "0"/"1", which
  // `key.startsWith('.')` reads as conditions, replacing the real one. Harmless now that ESM
  // is transpiled, but it silently changed WHICH entries were seeded.
  const dir = mkdtempSync(join(tmpdir(), 'ir-arr-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'arr', version: '1.0.0', exports: { '.': { types: ['./a.d.ts', './b.d.ts'], default: './i.cjs' } } }),
    );
    writeFileSync(join(dir, 'i.cjs'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'a.d.ts'), 'export {};\n');
    const local = await build(dir);
    assert.equal(typeof local.f['i.cjs'], 'object', 'the default target is seeded');
    assert.equal(typeof local.f['a.d.ts'], 'number', 'a `types` ARRAY member is still skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('react/jsx-runtime is inlined — the multi-entry case a main-only seed misses', async () => {
  // Named explicitly because this is the regression, not a general property: seeding only
  // from `main` shipped `jsx-runtime.js` as a size, and every React app imports it.
  const local = await build(REACT);
  assert.equal(kindOf(local.f['jsx-runtime.js']), 'content');
  assert.equal(kindOf(local.f['cjs/react-jsx-runtime.development.js']), 'content');
});

test('…and the same `d` for every file that ships content (order is not semantic)', async () => {
  // `d` must be EXACT, and this is the case that says so. The runtime constructs a bundled
  // module with `isCompiled = true`, so `transformModule` short-circuits and never scans
  // it: `file.d` is the ONLY source of that module's dependency graph. Order is compared
  // as a set because the consumer is `file.d.map(dep => addDependency(dep))` — it affects
  // transform scheduling, nothing observable.
  const local = await build(FIXTURE);
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

test('…and the same `t` (already-transpiled) flag for every file BOTH ship with content', async () => {
  // Kept as a CDN-SHAPE check, with the reason corrected: review found nothing on the
  // consume side reads `t` at all (`_writePrecompiledModule` passes `isCompiled = true`
  // unconditionally; `grep -rn 'file\.t' sandbox/src` is empty). So this asserts we produce
  // the field the format declares, NOT that the bundler behaves differently because of it —
  // the justification I first wrote was behaviour the consumer does not have.
  const local = await build(FIXTURE);
  const wrong = Object.entries(CDN.f)
    .filter(([p, f]) => typeof f !== 'number' && typeof local.f[p] === 'object')
    .filter(([p, f]) => local.f[p].t !== f.t)
    .map(([p, f]) => `${p}: CDN=${f.t} local=${local.f[p].t}`);
  assert.deepEqual(wrong, []);
});

test('…and the same transient dependency list', async () => {
  const local = await build(FIXTURE);
  assert.deepEqual(sorted(local.m), sorted(CDN.m));
});

test('the bytes decode into something the runtime can actually BOOT', async () => {
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
    const decoded = decodeMsgPack(encodeLocalPackage(await build(fixture)));
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

test('the entry closure is followed on BOTH sides, and an unreachable file stays a size', async () => {
  // This case USED to assert `dist/launch.js` stays size-only, on the theory that the ESM
  // build is reachable from nothing. That was the round-2 defect written down as a test: the
  // resolver prefers `module`, so the ESM build IS reachable and leaving it size-only is a
  // boot-time unpkg fetch. It is now inlined — transpiled — and the closure is walked with
  // the IMPORTER's extension priority, without which `./launch` from an ESM file resolves to
  // the CJS sibling and the ESM one is silently missed.
  const local = await build(FIXTURE);
  assert.equal(typeof local.f['dist/launch.cjs'], 'object', 'the CJS sibling ships content');
  assert.equal(typeof local.f['dist/launch.js'], 'object', 'and so does the ESM one');
  assert.ok(!/^\s*import\s/m.test(local.f['dist/launch.js'].c), 'transpiled, not raw');
  // A genuinely unreachable file — no entry point names it and nothing requires it.
  assert.equal(typeof local.f['dist/launch.js.map'], 'number', 'a sourcemap is reachable from nothing');
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

test('caret under a ZERO major pins the minor, the way npm reads it', () => {
  // Review round 4. `^0.11.0` does NOT mean "any 0.x": npm treats a 0 major as unstable and
  // pins the MINOR, so 0.12.0 is out. `react-refresh: ^0.11.0` — carried by this package —
  // is exactly that shape, so the wrong rule would have accepted a react-refresh the
  // transpiler never asked for and put it in the lockset under a range it does not satisfy.
  //
  // The rule had TWO homes and they disagreed: this one was wrong while
  // `scripts/check-platform-provided.mjs` was right, so the check passed a version the
  // resolver would have rejected. The script now imports this implementation.
  assert.equal(satisfies('0.11.0', '^0.11.0'), true);
  assert.equal(satisfies('0.11.9', '^0.11.0'), true, 'a higher patch inside the pinned minor is in');
  assert.equal(satisfies('0.12.0', '^0.11.0'), false, 'the next MINOR is out under a 0 major');
  assert.equal(satisfies('0.10.9', '^0.11.0'), false, 'and so is a lower one');

  // Non-vacuity: a non-zero major keeps the ordinary caret meaning, so the branch above is
  // not simply making every caret stricter.
  assert.equal(satisfies('6.1.5', '^6.1.0'), true);
  assert.equal(satisfies('6.2.0', '^6.1.0'), true, 'a higher minor IS in when the major is non-zero');
  assert.equal(satisfies('7.0.0', '^6.1.0'), false);
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

test('the resolution sources have STRICT precedence — a name is resolved once, by the nearest', () => {
  // The defect the live acceptance found and the suite did not. `react-error-boundary` is
  // injected by the platform AND hoisted into landing-page's node_modules, so concatenating
  // the sources put it in the lockset TWICE, at 6.1.3 and 6.1.5, and the runtime's
  // completeness guard passed — it asks whether every wanted name is present, not whether
  // any is present twice.
  const cdn = [{ n: 'react', v: '19.2.6', d: {} }];
  const app = [
    { n: 'react', v: '19.0.0', d: {} },
    { n: 'react-error-boundary', v: '6.1.3', d: {} },
  ];
  const platform = [
    { n: 'react-error-boundary', v: '6.1.5', d: {} },
    { n: 'core-js', v: '3.22.7', d: {} },
  ];

  const merged = mergeResolved(cdn, app, platform);
  assert.deepEqual(
    merged.map((r) => `${r.n}@${r.v}`),
    ['react@19.2.6', 'react-error-boundary@6.1.3', 'core-js@3.22.7'],
    'the CDN wins over the app tree, the app tree over ours, and nothing appears twice',
  );
  assert.equal(new Set(merged.map((r) => r.n)).size, merged.length, 'no name resolved twice');
});

test('…and the merge is order-preserving, so the CDN prefix stays identifiable', () => {
  // `resolveLockset` reports which entries were FILLED by slicing off the CDN's prefix, so
  // a merge that reordered would mislabel the summary line — the line whose whole job is
  // saying where the content came from.
  const cdn = [{ n: 'a', v: '1', d: {} }, { n: 'b', v: '1', d: {} }];
  const merged = mergeResolved(cdn, [{ n: 'c', v: '1', d: {} }], []);
  assert.deepEqual(merged.slice(0, cdn.length), cdn);
  assert.deepEqual(merged.slice(cdn.length).map((r) => r.n), ['c']);
});

test('the runtime enters a dual package through `require`, and that decides which build loads', async () => {
  // Recorded because it cost a live acceptance and because the conclusion is
  // counter-intuitive: inlining MORE did not change which file the runtime loads.
  //
  // `EXPORTS_KEYS = ['browser','development','default','require','import']`
  // (`sandbox/src/resolver/utils/exports.ts`) puts `require` BEFORE `import`, so a package
  // with an `exports` map is entered through its CJS build — `dist/index.cjs` for omnibox —
  // while a package with no `exports` at all is entered through `module` (MAIN_PKG_FIELDS),
  // i.e. its ESM build. Both sides are reachable depending on the package, which is why
  // `entryPoints` seeds both and `buildLocalPackage` transpiles the ESM one.
  //
  // Resolution then does NOT depend on which files carry content: the runtime's existence
  // test is `files[rel] != null`, so a size-only entry counts as present. The assertion
  // below runs against the CDN's OWN payload and lands on the same file this builder lands
  // on — which is what makes the difference between the two sources bytes, not behaviour.
  const has = (p) => CDN.f[p] != null;
  const resolveLike = (from, spec) => {
    // `dirname` + the specifier, the way the runtime joins them.
    const b = `${from.split('/').slice(0, -1).join('/')}/${spec.replace(/^\.\//, '')}`;
    for (const e of ['', ...RUNTIME_EXTENSIONS]) if (has(b + e)) return b + e;
    return null;
  };

  assert.notEqual(typeof CDN.f['dist/index.cjs'], 'number', 'the CJS entry the `require` condition selects carries content');
  const target = resolveLike('dist/index.cjs', './Omnibox');
  assert.equal(target, 'dist/Omnibox.js', 'a `.cjs` importer still resolves `.js` first — the order is not importer-aware');
  assert.equal(typeof CDN.f[target], 'number', 'and the CDN ships that file SIZE-ONLY: a blocking unpkg fetch at boot');

  // This builder ships it with content instead — the whole point — and lands on the same file.
  const local = await build(FIXTURE);
  assert.equal(typeof local.f[target], 'object', 'the local build carries the file the runtime actually loads');
});

test('the declared range is checked at EVERY depth, not only at the root', async () => {
  // Review round 3. `depth === 0` looked sufficient because a declared name is resolved at
  // depth 0 — but a name the root declares is usually ALSO reachable transitively, and the
  // second route re-resolved it unchecked. The repo below declares `wrongver: ^3.0.0` and
  // its tree holds 0.0.9, reachable both directly and under a parent; the wrong version must
  // not enter the lockset by either route.
  const root = mkdtempSync(join(tmpdir(), 'ir-depth-range-'));
  const pkg = (dir, manifest) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest));
  };
  try {
    pkg('.', { name: 'app', dependencies: { parentpkg: '^1.0.0', wrongver: '^3.0.0' } });
    pkg('node_modules/parentpkg', { name: 'parentpkg', version: '1.0.0', dependencies: { wrongver: '^0.0.1' } });
    pkg('node_modules/wrongver', { name: 'wrongver', version: '0.0.9' });

    const wanted = { parentpkg: '^1.0.0', wrongver: '^3.0.0' };
    const resolved = resolveFromInstalledTree(root, wanted);
    assert.deepEqual(
      resolved.map((r) => `${r.n}@${r.v}`),
      ['parentpkg@1.0.0'],
      'the wrong version must be omitted however it is reached, so the CDN gets its chance',
    );

    // Non-vacuity: the SAME tree with a range that fits does resolve it.
    const ok = resolveFromInstalledTree(root, { parentpkg: '^1.0.0', wrongver: '^0.0.1' });
    assert.deepEqual(ok.map((r) => `${r.n}@${r.v}`), ['parentpkg@1.0.0', 'wrongver@0.0.9']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skipped condition stays skipped through a NESTED condition', async () => {
  // Review round 3, and a shape both fixtures happen not to use. `SKIP_CONDITIONS` was
  // consulted only for the innermost key, so `{"types": {"default": "./index.d.ts"}}` seeded
  // the `.d.ts` — which then fails `JS_RE` and is inlined verbatim as an asset. Typings
  // shipped as content, silently.
  //
  // `main` is set throughout so the no-main `index.js` fallback cannot be mistaken for a
  // seeded target, and every filename is distinct so each assertion names one path only.
  const flat = entryPoints({ main: './m.js', exports: { '.': { types: './t.d.ts', default: './d.js' } } });
  assert.deepEqual(flat.sort(), ['d.js', 'm.js'], 'the flat shape was already correct');

  const nested = entryPoints({ main: './m.js', exports: { '.': { types: { default: './t.d.ts' }, default: './d.js' } } });
  assert.deepEqual(nested.sort(), ['d.js', 'm.js'], 'and a nested condition under `types` is still skipped');

  // Non-vacuity, both ways: a nested condition under a NON-skipped key IS seeded…
  const kept = entryPoints({ main: './m.js', exports: { '.': { browser: { default: './b.js' } } } });
  assert.deepEqual(kept.sort(), ['b.js', 'm.js']);
  // …and nesting two deep under a skipped one is still skipped.
  const deep = entryPoints({ main: './m.js', exports: { '.': { types: { browser: { default: './t.d.ts' } } } } });
  assert.deepEqual(deep.sort(), ['m.js']);
});
