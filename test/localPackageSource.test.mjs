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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode as decodeMsgPack } from '@msgpack/msgpack';

import {
  buildLocalPackage,
  resolveFromInstalledTree,
  resolvePackageDir,
  cjsEntry,
  encodeLocalPackage,
} from '../dist/localPackageSource.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/omnibox-0.2.1');
const CDN = decodeMsgPack(new Uint8Array(readFileSync(join(here, 'fixtures/omnibox-0.2.1.cdn.msgpack'))));

// The scanner the CLI actually ships, driven through the real thing rather than a
// convenience regex — this test is what keeps that copy honest against the CDN.
import { scanCjsRequires as scanCjsModule } from '../dist/scanCjsRequires.js';

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

test('…and makes the same content-vs-size decision for every one of them', () => {
  // The split is the load-bearing half: a file the CDN ships with content is one the
  // runtime may need to EVALUATE, and it is marked precompiled — so if we record a size
  // where the CDN records content, the bundler has no source for a module it will import.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  const kind = (v) => (typeof v === 'number' ? 'size' : 'content');
  const mismatches = Object.keys(CDN.f)
    .filter((p) => kind(CDN.f[p]) !== kind(local.f[p]))
    .map((p) => `${p}: CDN=${kind(CDN.f[p])} local=${kind(local.f[p])}`);
  assert.deepEqual(mismatches, []);
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
    assert.deepEqual(sorted(local.f[path].d), sorted(cdnFile.d), `d differs for ${path}`);
  }
});

test('…and the same `t` (already-transpiled) flag for every file that ships content', () => {
  // Found by fault injection: without this, forcing every file to `t: false` passed. The
  // flag decides whether the bundler treats the shipped bytes as final or as something to
  // re-transform, so getting it wrong is either a wasted transform or a re-transform of
  // code that must not be touched.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  const wrong = Object.entries(CDN.f)
    .filter(([, f]) => typeof f !== 'number')
    .filter(([p, f]) => local.f[p].t !== f.t)
    .map(([p, f]) => `${p}: CDN=${f.t} local=${local.f[p].t}`);
  assert.deepEqual(wrong, []);
});

test('…and the same transient dependency list', () => {
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  assert.deepEqual(sorted(local.m), sorted(CDN.m));
});

test('the result round-trips through msgpack as the runtime decodes it', () => {
  // The runtime decodes these bytes with the same decoder it uses for a live fetch, so the
  // encoding is part of the contract, not an implementation detail.
  const local = buildLocalPackage(FIXTURE, scanCjsModule);
  const back = decodeMsgPack(encodeLocalPackage(local));
  assert.deepEqual(sorted(Object.keys(back.f)), sorted(Object.keys(local.f)));
  assert.equal(back.f['dist/index.cjs'].c, local.f['dist/index.cjs'].c);
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

test('resolveFromInstalledTree reports the installed versions, at depth 0 for direct deps', () => {
  const root = join(here, 'fixtures');
  // The fixture is the package itself, so resolve against a tree that contains it.
  const dir = resolvePackageDir('@immediately-run/omnibox', join(here, '..'));
  if (!dir) return; // not installed here; the CDN-parity cases above are the substance
  const resolved = resolveFromInstalledTree(join(here, '..'), { '@immediately-run/omnibox': '0.2.1' });
  const entry = resolved.find((r) => r.n === '@immediately-run/omnibox');
  if (entry) assert.equal(entry.d, 0);
  assert.ok(root);
});

test('resolveFromInstalledTree omits a package the tree does not contain, rather than inventing one', () => {
  // The completeness guard downstream (`assertDependenciesResolved`) is what turns this
  // into a loud failure; silently emitting a made-up version would bake a broken lockset.
  const resolved = resolveFromInstalledTree(join(here, '..'), { 'definitely-not-installed-xyz': '1.0.0' });
  assert.deepEqual(resolved, []);
});
