// Tests for the dependency lockset (PRETRANSPILED_ARTIFACTS_SPEC §4.3, §7).
// Runs against the compiled dist/ (`npm test` builds first). Uses node:test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as encodeMsgPack } from '@msgpack/msgpack';

import {
  LOCKSET_CDN_VERSION,
  computeInputDepMap,
  encodeDepTreePayload,
  fetchDepTree,
  assertDependenciesResolved,
} from '../dist/lockset.js';
import { buildCacheZip } from '../dist/commands/cacheZip.js';
import { bundledPackageFilename } from '../dist/lockset.js';

// --- unit: input DepMap derivation ------------------------------------------

test('computeInputDepMap augments react deps, filters build deps, sorts keys', () => {
  const result = computeInputDepMap({
    zod: '^3.0.0',
    react: '^18.2.0',
    vite: '^5.0.0', // build dep: filtered
    '@babel/preset-env': '^7.0.0', // build dep (regex): filtered
  });
  assert.deepEqual(result, {
    'core-js': '3.22.7',
    react: '^18.2.0',
    'react-error-boundary': '^6.1.0',
    'react-refresh': '^0.11.0',
    zod: '^3.0.0',
  });
  // Key order is sorted (matters for the encoded dep_tree URL).
  assert.deepEqual(Object.keys(result), Object.keys(result).slice().sort());
});

test('computeInputDepMap keeps an explicit react-refresh range', () => {
  const result = computeInputDepMap({ 'react-refresh': '^0.14.0' });
  assert.equal(result['react-refresh'], '^0.14.0');
});

test('computeInputDepMap strips registry-resolved modules from the CDN dep map', () => {
  // The SDK is self-hosted (resolveFromRegistry), so it must NOT appear in the
  // map sent to /dep_tree/ — that is what makes resolution survive the SDK's
  // npm→CDN replication lag. Its own deps (react-error-boundary) are added by
  // the react augmentation regardless and are unaffected.
  const result = computeInputDepMap(
    { react: '^19.0.0', '@immediately-run/sdk': '^0.2.7' },
    ['@immediately-run/sdk'],
  );
  assert.equal(result['@immediately-run/sdk'], undefined);
  assert.equal(result['react'], '^19.0.0');
  assert.equal(result['react-error-boundary'], '^6.1.0');
});

test('encodeDepTreePayload matches the runtime payload format', () => {
  const deps = { react: '^18.2.0' };
  const decoded = Buffer.from(encodeDepTreePayload(deps), 'base64').toString();
  assert.equal(decoded, `${LOCKSET_CDN_VERSION}(${JSON.stringify(deps)})`);
});

// --- integration: mock CDN + cache-zip ---------------------------------------

// Complete over the react-preset augmentation (core-js / react-error-boundary /
// react-refresh are added by computeInputDepMap), so the resolution-completeness
// check (assertLocksetResolves) passes for the `{ react }` inputs below.
const RESOLVED = [
  { n: 'react', v: '18.3.1', d: 0 },
  { n: 'core-js', v: '3.22.7', d: 0 },
  { n: 'react-error-boundary', v: '6.1.0', d: 0 },
  { n: 'react-refresh', v: '0.11.0', d: 0 },
];

let server;
let cdnRoot;
let lastPath;
let nextStatus = 200;
// Simulate npm→CDN replication lag: 500 any /dep_tree/ request whose decoded
// payload mentions this substring (e.g. an SDK version not yet replicated),
// while every other request resolves normally.
let failIfPayloadIncludes;
// R3-567: the CDN SILENTLY OMITS a package it cannot resolve rather than erroring — which
// is the behaviour gap-filling exists to cover, so the stub has to reproduce it faithfully
// rather than 500. Set to a package name to have the stub answer 200 with that name absent.
let dropFromDepTree;

const decodeDepTreePath = (url) => {
  const enc = decodeURIComponent(url.replace(/^\/dep_tree\//, ''));
  try {
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch {
    return '';
  }
};

before(async () => {
  server = createServer((req, res) => {
    lastPath = req.url;
    const laggedOut =
      failIfPayloadIncludes && decodeDepTreePath(req.url).includes(failIfPayloadIncludes);
    if (nextStatus !== 200 || laggedOut) {
      res.writeHead(laggedOut ? 500 : nextStatus);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const body = dropFromDepTree ? RESOLVED.filter((r) => r.n !== dropFromDepTree) : RESOLVED;
    res.end(Buffer.from(encodeMsgPack(body)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cdnRoot = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

const makeRepo = (pkgJson) => {
  const root = mkdtempSync(join(tmpdir(), 'ir-lockset-test-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'index.tsx'), 'export const x = 1;\n');
  if (pkgJson !== undefined) writeFileSync(join(root, 'package.json'), pkgJson);
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  return root;
};

const sidecarOf = (zipPath) =>
  JSON.parse(
    execFileSync('unzip', ['-p', zipPath, '.immediately.run/contribute-manifest.json'], {
      encoding: 'utf8',
    }),
  );

const zipOpts = (root, extra = {}) => ({
  repoPath: root,
  owner: 'o',
  repository: 'r',
  ref: 'main',
  defaultBranch: 'main',
  out: join(root, 'out.zip'),
  cdnRoot,
  ...extra,
});

test('fetchDepTree asks the CDN for exactly the echo the runtime recomputes', async () => {
  // Retargeted from the deleted `fetchLockset` wrapper, which R3-567 left with no
  // production caller once `resolveLockset` took over composing the two halves. The
  // PROPERTY is what mattered and it still holds: the URL encodes the augmented input
  // DepMap, byte for byte, because the runtime's echo-match (R3-289) compares against it.
  const dependencies = computeInputDepMap({ react: '^18.2.0' });
  const resolved = await fetchDepTree(dependencies, cdnRoot);
  assert.deepEqual(resolved, RESOLVED);
  assert.equal(lastPath, `/dep_tree/${encodeDepTreePayload(dependencies)}`);
});

test('the completeness guard names a package the CDN silently dropped', async () => {
  // The mock CDN returns RESOLVED (no lucide-react) — the silent-drop shape. Detection is
  // the shared transpiler guard, so it reads identically to the runtime's. `resolveLockset`
  // treats the throw as non-fatal and omits the lockset; the cache-zip case below is the
  // end-to-end half of this.
  const dependencies = computeInputDepMap({ react: '^18.2.0', 'lucide-react': '^1.21.0' });
  assert.throws(
    () => assertDependenciesResolved(dependencies, RESOLVED),
    /Could not resolve.*lucide-react@\^1\.21\.0/,
  );
});

test('cache-zip warns and omits the lockset when the CDN drops a declared dep', async () => {
  const root = makeRepo(
    JSON.stringify({ dependencies: { react: '^18.2.0', 'lucide-react': '^1.21.0' } }),
  );
  try {
    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.locksetSummary, /^omitted \(/);
    assert.equal(sidecarOf(result.outputPath).lockset, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-zip embeds the lockset in the sidecar', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  try {
    const result = await buildCacheZip(zipOpts(root));
    // R3-567: the summary now NAMES the source, because a cache artifact that cannot say
    // where its content came from is how a silent regression back to the CDN goes unnoticed.
    assert.equal(result.locksetSummary, `${RESOLVED.length} packages (CDN)`);
    const sidecar = sidecarOf(result.outputPath);
    assert.equal(sidecar.schemaVersion, 1);
    assert.deepEqual(sidecar.lockset.resolved, RESOLVED);
    assert.equal(sidecar.lockset.cdnVersion, LOCKSET_CDN_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-zip --no-lockset issues no CDN request and omits the section', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  try {
    lastPath = undefined;
    const result = await buildCacheZip(zipOpts(root, { lockset: false }));
    assert.equal(result.locksetSummary, 'omitted (--no-lockset)');
    assert.equal(lastPath, undefined);
    assert.equal(sidecarOf(result.outputPath).lockset, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CDN failure warns and omits the lockset; the zip still builds', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  try {
    nextStatus = 500;
    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.locksetSummary, /^omitted \(/);
    const sidecar = sidecarOf(result.outputPath);
    assert.equal(sidecar.lockset, undefined);
    assert.equal(sidecar.commitSha.length, 40);
  } finally {
    nextStatus = 200;
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo without package.json omits the lockset gracefully', async () => {
  const root = makeRepo(undefined);
  try {
    const result = await buildCacheZip(zipOpts(root));
    assert.equal(result.locksetSummary, 'omitted (no package.json at HEAD)');
    assert.equal(sidecarOf(result.outputPath).lockset, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- CDN replication lag does not break the locking mechanism ----------------
// The SDK is self-hosted and resolved IMPLICITLY (no opt-in field), so it is
// always stripped from the dep_tree query — the lockset resolves even while the
// SDK version 500s on the CDN, with or without the legacy resolveFromRegistry
// field. The control proves it's the SDK strip (not blanket lag tolerance):
// lagging a NON-self-hosted dep still omits the lockset.

const SDK = '@immediately-run/sdk';

test('lockset resolves despite SDK CDN lag — implicit, no opt-in field needed', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', [SDK]: '0.2.8' } }));
  try {
    // The CDN has NOT replicated the SDK version: any dep_tree mentioning it 500s.
    failIfPayloadIncludes = SDK;
    const result = await buildCacheZip(zipOpts(root));
    // Resolution still succeeded — the SDK never entered the dep_tree request.
    // R3-567: the summary now NAMES the source, because a cache artifact that cannot say
    // where its content came from is how a silent regression back to the CDN goes unnoticed.
    assert.equal(result.locksetSummary, `${RESOLVED.length} packages (CDN)`);
    const sidecar = sidecarOf(result.outputPath);
    assert.deepEqual(sidecar.lockset.resolved, RESOLVED);
    assert.equal(sidecar.lockset.dependencies[SDK], undefined);
    assert.ok(!decodeDepTreePath(lastPath).includes(SDK));
  } finally {
    failIfPayloadIncludes = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test('still strips the SDK even with the legacy resolveFromRegistry field present', async () => {
  const root = makeRepo(
    JSON.stringify({
      dependencies: { react: '^19.0.0', [SDK]: '0.2.8' },
      'immediately.run': { resolveFromRegistry: [SDK] },
    }),
  );
  try {
    failIfPayloadIncludes = SDK;
    const result = await buildCacheZip(zipOpts(root));
    // R3-567: the summary now NAMES the source, because a cache artifact that cannot say
    // where its content came from is how a silent regression back to the CDN goes unnoticed.
    assert.equal(result.locksetSummary, `${RESOLVED.length} packages (CDN)`);
    assert.equal(sidecarOf(result.outputPath).lockset.dependencies[SDK], undefined);
  } finally {
    failIfPayloadIncludes = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

// R3-567 — the gap-filling that ends the 2026-09-08 outage. The CDN silently OMITS a
// package its npm mirror has not ingested (always a FRESH publish); the runner's own
// node_modules has exactly that package, because npm installed it. Filling the CDN's gaps
// from the tree covers the one failure mode that actually happened, and the two sources
// fail in opposite places: the tree lacks only the AUGMENTED build deps
// (react-refresh/core-js/scheduler), which are stable and which the CDN always has.
test('a package the CDN drops is filled in from node_modules', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', 'gap-pkg': '9.9.9' } }));
  try {
    // The CDN cannot resolve it — exactly what happened to @immediately-run/omnibox@0.3.0.
    failIfPayloadIncludes = undefined;
    dropFromDepTree = 'gap-pkg';
    // …but npm has installed it.
    const dir = join(root, 'node_modules', 'gap-pkg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gap-pkg', version: '9.9.9', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = 1;\n');

    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.locksetSummary, /from node_modules/);
    const resolved = sidecarOf(result.outputPath).lockset.resolved;
    const entry = resolved.find((r) => r.n === 'gap-pkg');
    assert.ok(entry, 'the dropped package must be in the lockset');
    assert.equal(entry.v, '9.9.9', 'and at the version npm installed, never a guess');
  } finally {
    dropFromDepTree = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the local bundling path is actually TAKEN when the version matches', async () => {
  // The positive case. Review found every --bundle-packages test was NEGATIVE (the
  // mismatched-version one), so nothing asserted the local path is used at all — which is
  // how a main-only entry seed and a paraphrased scanner both stayed invisible behind a
  // green suite.
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', 'gap-pkg': '9.9.9' } }));
  try {
    dropFromDepTree = 'gap-pkg';
    const dir = join(root, 'node_modules', 'gap-pkg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gap-pkg', version: '9.9.9', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = require("./helper");\n');
    writeFileSync(join(dir, 'helper.js'), 'module.exports = "LOCAL BYTES";\n');

    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, /from node_modules/);

    // …and the bytes in the zip are the local ones, with the require closure followed.
    const bytes = execFileSync(
      'unzip',
      ['-p', result.outputPath, `.immediately.run/packages/${bundledPackageFilename('gap-pkg', '9.9.9')}.msgpack`],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(bytes.includes(Buffer.from('LOCAL BYTES')), 'the required sibling must be inlined, not size-only');
  } finally {
    dropFromDepTree = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gap node_modules cannot fill still omits the lockset — no invented versions', async () => {
  // The completeness guard is what keeps gap-filling honest: a hole neither source can
  // close must fail loudly here rather than ship a lockset the runtime will act on.
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', 'absent-pkg': '1.0.0' } }));
  try {
    dropFromDepTree = 'absent-pkg';
    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.locksetSummary, /^omitted/);
  } finally {
    dropFromDepTree = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a node_modules copy at a DIFFERENT version is never bundled under the resolved key', async () => {
  // THE WORST FAILURE THIS FEATURE COULD HAVE, and the one the first version of this test
  // was too weak to catch (fault injection: weakening the version check left it green).
  // The hazard is not the lockset — it is the BUNDLE: the CDN resolves react@18.3.1, the
  // tree happens to hold a different react, and we ship those bytes under 18.3.1's key.
  // Silent, and undetectable downstream, because the key is the only thing the runtime
  // matches on.
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^18.0.0' } }));
  try {
    // The CDN resolves react@18.3.1 (see RESOLVED). node_modules holds a DIFFERENT one.
    const dir = join(root, 'node_modules', 'react');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'react', version: '0.0.1-wrong', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = "WRONG BYTES";\n');

    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    // Whatever else happens, the local copy must NOT have been used for react.
    assert.doesNotMatch(
      result.bundledPackagesSummary,
      /all from node_modules/,
      'a mismatched local copy must not be treated as the resolved package',
    );
    const bundled = execFileSync('unzip', ['-Z1', result.outputPath], { encoding: 'utf8' });
    if (bundled.includes(`${bundledPackageFilename('react', '18.3.1')}.msgpack`)) {
      const bytes = execFileSync(
        'unzip',
        ['-p', result.outputPath, `.immediately.run/packages/${bundledPackageFilename('react', '18.3.1')}.msgpack`],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      );
      assert.ok(!bytes.includes(Buffer.from('WRONG BYTES')), 'the wrong version\'s bytes must never ship under the resolved key');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control: lagging a NON-self-hosted dep still omits the lockset', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', zod: '^3.0.0' } }));
  try {
    // zod is a normal CDN dep — not stripped — so its lag omits the lockset.
    failIfPayloadIncludes = 'zod';
    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.locksetSummary, /^omitted \(/);
    assert.equal(sidecarOf(result.outputPath).lockset, undefined);
  } finally {
    failIfPayloadIncludes = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
