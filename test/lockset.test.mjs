// Tests for the dependency lockset (PRETRANSPILED_ARTIFACTS_SPEC §4.3, §7).
// Runs against the compiled dist/ (`npm test` builds first). Uses node:test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as encodeMsgPack } from '@msgpack/msgpack';

import {
  LOCKSET_CDN_VERSION,
  computeInputDepMap,
  encodeDepTreePayload,
  fetchLockset,
} from '../dist/lockset.js';
import { buildCacheZip } from '../dist/commands/cacheZip.js';

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

const RESOLVED = [
  { n: 'react', v: '18.3.1', d: 0 },
  { n: 'core-js', v: '3.22.7', d: 0 },
];

let server;
let cdnRoot;
let lastPath;
let nextStatus = 200;
// Simulate npm→CDN replication lag: 500 any /dep_tree/ request whose decoded
// payload mentions this substring (e.g. an SDK version not yet replicated),
// while every other request resolves normally.
let failIfPayloadIncludes;

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
    res.end(Buffer.from(encodeMsgPack(RESOLVED)));
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
    execFileSync('unzip', ['-p', zipPath, '.tinkerable/contribute-manifest.json'], {
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

test('fetchLockset returns the CDN resolution with the input echo', async () => {
  const lockset = await fetchLockset({ react: '^18.2.0' }, cdnRoot);
  assert.equal(lockset.cdnVersion, LOCKSET_CDN_VERSION);
  assert.deepEqual(lockset.resolved, RESOLVED);
  assert.deepEqual(lockset.dependencies, computeInputDepMap({ react: '^18.2.0' }));
  // The request hit /dep_tree/<payload encoding exactly that echo>.
  assert.equal(lastPath, `/dep_tree/${encodeDepTreePayload(lockset.dependencies)}`);
});

test('cache-zip embeds the lockset in the sidecar', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  try {
    const result = await buildCacheZip(zipOpts(root));
    assert.equal(result.locksetSummary, `${RESOLVED.length} packages`);
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
// These two tests together prove the guarantee: with the SDK declared
// resolveFromRegistry, the lockset resolves even while the SDK version 500s on
// the CDN (it's stripped before the query); without the opt-in, the same lag
// would omit the lockset (the control case — proves the guard actually bites).

const SDK = '@immediately-run/sdk';

test('lockset resolves despite SDK CDN lag when the SDK is resolveFromRegistry', async () => {
  const root = makeRepo(
    JSON.stringify({
      dependencies: { react: '^19.0.0', [SDK]: '^0.2.7' },
      'immediately.run': { resolveFromRegistry: [SDK] },
    }),
  );
  try {
    // The CDN has NOT replicated the SDK version: any dep_tree mentioning it 500s.
    failIfPayloadIncludes = SDK;
    const result = await buildCacheZip(zipOpts(root));
    // Resolution still succeeded — the SDK never entered the dep_tree request.
    assert.equal(result.locksetSummary, `${RESOLVED.length} packages`);
    const sidecar = sidecarOf(result.outputPath);
    assert.deepEqual(sidecar.lockset.resolved, RESOLVED);
    assert.equal(sidecar.lockset.dependencies[SDK], undefined);
    assert.ok(!decodeDepTreePath(lastPath).includes(SDK));
  } finally {
    failIfPayloadIncludes = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test('control: same SDK lag DOES omit the lockset without the resolveFromRegistry opt-in', async () => {
  const root = makeRepo(JSON.stringify({ dependencies: { react: '^19.0.0', [SDK]: '^0.2.7' } }));
  try {
    failIfPayloadIncludes = SDK;
    const result = await buildCacheZip(zipOpts(root));
    // Without the opt-in the SDK is in the dep_tree request, which 500s → omitted.
    assert.match(result.locksetSummary, /^omitted \(/);
    assert.equal(sidecarOf(result.outputPath).lockset, undefined);
  } finally {
    failIfPayloadIncludes = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
