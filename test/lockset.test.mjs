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

before(async () => {
  server = createServer((req, res) => {
    lastPath = req.url;
    if (nextStatus !== 200) {
      res.writeHead(nextStatus);
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
