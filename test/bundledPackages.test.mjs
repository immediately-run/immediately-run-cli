// Tests for R3-49a: bundling resolved dependency CONTENT into the cache zip.
// Runs against the compiled dist/ (`npm test` builds first). Uses node:test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as encodeMsgPack, decode as decodeMsgPack } from '@msgpack/msgpack';

import {
  LOCKSET_CDN_VERSION,
  encodePackageKey,
  bundledPackageFilename,
  fetchBundledPackages,
} from '../dist/lockset.js';
import { buildCacheZip } from '../dist/commands/cacheZip.js';

const RESOLVED = [
  { n: 'react', v: '18.3.1', d: 0 },
  { n: '@scope/pkg', v: '1.0.0', d: 1 }, // scoped name: exercises the `/` escape
];
// A distinct fake `ICDNModule` per package, keyed by the CDN key, so we can assert
// the right bytes land at the right path (verbatim round-trip).
const moduleFor = (key) => ({ f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] });

let server;
let cdnRoot;
const packageRequests = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url.startsWith('/dep_tree/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(encodeMsgPack(RESOLVED)));
      return;
    }
    if (req.url.startsWith('/package/')) {
      const key = decodeURIComponent(req.url.replace(/^\/package\//, ''));
      packageRequests.push(key);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(encodeMsgPack(moduleFor(key))));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cdnRoot = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

// --- unit -------------------------------------------------------------------

test('encodePackageKey matches the runtime /package/ key format', () => {
  const decoded = Buffer.from(encodePackageKey('react', '18.3.1'), 'base64').toString();
  assert.equal(decoded, `${LOCKSET_CDN_VERSION}(react@18.3.1)`);
});

test('bundledPackageFilename escapes the slash in a scoped name', () => {
  assert.equal(bundledPackageFilename('@scope/pkg', '1.0.0'), '%40scope%2Fpkg%401.0.0');
  assert.ok(!bundledPackageFilename('@scope/pkg', '1.0.0').includes('/'));
});

test('fetchBundledPackages fetches /package/<key> verbatim for each resolved dep', async () => {
  packageRequests.length = 0;
  const pkgs = await fetchBundledPackages(RESOLVED, cdnRoot);
  assert.equal(pkgs.length, RESOLVED.length);
  for (const { n, v } of RESOLVED) {
    const key = encodePackageKey(n, v);
    assert.ok(packageRequests.includes(key), `requested /package/${key}`);
    const bundled = pkgs.find((p) => p.name === n && p.version === v);
    // Bytes are the verbatim msgpack the CDN returned (decode round-trips identically).
    assert.deepEqual(decodeMsgPack(bundled.bytes), moduleFor(key));
  }
});

test('a per-package HTTP failure rejects (all-or-nothing)', async () => {
  await assert.rejects(
    fetchBundledPackages([{ n: 'nope', v: '0.0.0', d: 0 }], `${cdnRoot}missing/`),
    /package fetch failed/,
  );
});

// --- integration: cache-zip --bundle-packages -------------------------------

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'ir-bundle-test-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'index.tsx'), 'export const x = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  return root;
};

const zipOpts = (root, extra = {}) => ({
  repoPath: root,
  owner: 'o',
  repository: 'r',
  ref: 'main',
  defaultBranch: 'main',
  out: join(root, 'out.zip'),
  cdnRoot,
  artifacts: false, // keep the test focused on packages
  ...extra,
});

const entryNames = (zipPath) =>
  execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('--bundle-packages bundles the closure content + an index into the zip', async () => {
  const root = makeRepo();
  try {
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, /^2 packages, /);
    const names = entryNames(result.outputPath);
    assert.ok(names.includes('.immediately.run/packages/index.json'));
    for (const { n, v } of RESOLVED) {
      assert.ok(names.includes(`.immediately.run/packages/${bundledPackageFilename(n, v)}.msgpack`));
    }
    // Index keys the entries by the CDN key + the in-zip path.
    const index = JSON.parse(
      execFileSync('unzip', ['-p', result.outputPath, '.immediately.run/packages/index.json'], {
        encoding: 'utf8',
      }),
    );
    assert.equal(index.cdnVersion, LOCKSET_CDN_VERSION);
    const react = index.packages.find((p) => p.n === 'react');
    assert.equal(react.key, encodePackageKey('react', '18.3.1'));
    assert.equal(react.path, `${bundledPackageFilename('react', '18.3.1')}.msgpack`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without --bundle-packages no packages are bundled (default off)', async () => {
  const root = makeRepo();
  try {
    const result = await buildCacheZip(zipOpts(root));
    assert.equal(result.bundledPackagesSummary, 'omitted (not requested)');
    assert.ok(!entryNames(result.outputPath).some((n) => n.startsWith('.immediately.run/packages/')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--bundle-packages with --no-lockset omits packages (needs the resolved list)', async () => {
  const root = makeRepo();
  try {
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true, lockset: false }));
    assert.equal(result.bundledPackagesSummary, 'omitted (no lockset)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
