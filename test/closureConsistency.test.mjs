// Tests for R3-1204: closure consistency between the resolved dependency set
// and the bundled package content. Runs against the compiled dist/ (`npm
// test` builds first). Uses node:test. The CDN is never contacted: the
// regression case carries the R3-1203 answers recorded verbatim, and the
// end-to-end cases run against a local fake CDN (the bundledPackages.test.mjs
// pattern).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode as encodeMsgPack } from '@msgpack/msgpack';

import { bareDependencyName, closureFindings, closureFailureMessage } from '../dist/closureConsistency.js';
import { encodePackageKey } from '../dist/lockset.js';
import { buildCacheZip } from '../dist/commands/cacheZip.js';

// --- the R3-1203 regression, real data (recorded from the live CDN
// 2026-10-13; the same answers the sandbox's undeclared-transitive test
// carries) --------------------------------------------------------------

// The /dep_tree answer for {"@codemirror/language":"^6.11.0"} — nine entries,
// @codemirror/streamparser (and @lezer/lr, which the dist never imports)
// absent because the resolver walks DECLARED metadata.
const LANGUAGE_CARET_TREE = [
  { n: '@codemirror/language', v: '6.13.0', d: 0 },
  { n: '@lezer/highlight', v: '1.2.4', d: 1 },
  { n: '@lezer/common', v: '1.5.3', d: 1 },
  { n: 'style-mod', v: '4.1.4', d: 1 },
  { n: '@codemirror/view', v: '6.43.9', d: 1 },
  { n: '@codemirror/state', v: '6.7.5', d: 1 },
  { n: 'w3c-keyname', v: '2.2.8', d: 2 },
  { n: '@marijn/find-cluster-break', v: '1.0.3', d: 2 },
  { n: 'crelt', v: '1.0.6', d: 2 },
];

// The recorded package-level `m` for @codemirror/language@6.13.0 — the CDN's
// import list computed from the real dist, naming the undeclared transitive.
const LANGUAGE_6130_IMPORTS = [
  '@lezer/highlight',
  'style-mod',
  '@codemirror/streamparser',
  '@codemirror/state',
  '@lezer/common',
  '@codemirror/view',
];

// The /package response's `dist/index.cjs` dependency list starts with the
// undeclared transitive (recorded live): streamparser first, then the rest of
// the recorded import set.
const LANGUAGE_6130_DIST_D = [
  '@codemirror/streamparser',
  '@codemirror/view',
  '@codemirror/state',
  '@lezer/common',
  '@lezer/highlight',
  'style-mod',
];

const bundled = (name, version, module) => ({
  key: encodePackageKey(name, version),
  name,
  version,
  bytes: new Uint8Array(Buffer.from(encodeMsgPack(module))),
});

test('the R3-1203 regression: exactly one import-source finding, naming the undeclared transitive', () => {
  const resolvedNames = new Set(LANGUAGE_CARET_TREE.map((entry) => entry.n));
  const pkg = bundled('@codemirror/language', '6.13.0', {
    f: { 'dist/index.cjs': { c: '/* transpiled dist */', d: LANGUAGE_6130_DIST_D, t: true } },
    m: LANGUAGE_6130_IMPORTS,
  });
  const findings = closureFindings([pkg], resolvedNames);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'import');
  assert.equal(findings[0].name, '@codemirror/language');
  assert.equal(findings[0].version, '6.13.0');
  assert.equal(findings[0].dependency, '@codemirror/streamparser');
  assert.match(
    closureFailureMessage(findings[0]),
    /closure inconsistency: @codemirror\/language@6.13\.0 content imports @codemirror\/streamparser, but the resolved dependency set does not include it — pin @codemirror\/streamparser in the app's package\.json or refresh the CDN mirror/,
  );
});

// --- unit: name extraction -------------------------------------------------

test('bareDependencyName extracts the package a specifier resolves to', () => {
  assert.equal(bareDependencyName('react'), 'react');
  assert.equal(bareDependencyName('react/jsx-runtime'), 'react');
  assert.equal(bareDependencyName('@scope/pkg'), '@scope/pkg');
  assert.equal(bareDependencyName('@scope/pkg/sub'), '@scope/pkg');
  assert.equal(bareDependencyName('./x'), null);
  assert.equal(bareDependencyName('../x/y'), null);
  assert.equal(bareDependencyName('/x'), null);
  assert.equal(bareDependencyName('https://esm.sh/x'), null);
  assert.equal(bareDependencyName('node:fs'), null);
  assert.equal(bareDependencyName(''), null);
});

// --- unit: exemptions -------------------------------------------------------

test('node builtins, registry-resolved and github-pinned names are not findings', () => {
  const pkg = bundled('app-pkg', '1.0.0', {
    f: {
      'index.js': {
        c: '// code',
        d: ['node:fs', 'fs', 'path', 'registry-hosted-pkg', 'github-pinned-pkg', 'react'],
        t: false,
      },
    },
    m: [],
  });
  const findings = closureFindings(
    [pkg],
    new Set(['react']),
    new Set(['registry-hosted-pkg', 'github-pinned-pkg']),
  );
  assert.deepEqual(findings, []);
});

test('a size-only file entry carries no imports; an m-only name is a declared finding', () => {
  const pkg = bundled('app-pkg', '1.0.0', {
    f: { 'assets/logo.png': 4096 },
    m: ['peer-optional'],
  });
  const findings = closureFindings([pkg], new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'declared');
  assert.equal(findings[0].dependency, 'peer-optional');
});

test('a name both imported and declared reports once, as the import', () => {
  const pkg = bundled('app-pkg', '1.0.0', {
    f: { 'index.js': { c: '// code', d: ['left-pad'], t: false } },
    m: ['left-pad'],
  });
  const findings = closureFindings([pkg], new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'import');
});

// --- integration: cache-zip over a fake CDN --------------------------------

// Complete over the react-preset augmentation (computeInputDepMap adds core-js
// / react-error-boundary / react-refresh) so the lockset embeds.
const RESOLVED = [
  { n: 'react', v: '18.3.1', d: 0 },
  { n: 'core-js', v: '3.22.7', d: 0 },
  { n: 'react-error-boundary', v: '6.1.0', d: 0 },
  { n: 'react-refresh', v: '0.11.0', d: 0 },
];

let server;
let cdnRoot;
let moduleFor; // per-test content resolver over the CDN package key

// The /package/ key is base64(LOCKSET_CDN_VERSION(name@version)), so content
// selectors must match on the DECODED key — a selector over the raw key never
// fires (found the hard way: react's bytes arrived as the else-branch).
const servesContent = (resolve) => (key) => resolve(key);

before(async () => {
  server = createServer((req, res) => {
    if (req.url.startsWith('/dep_tree/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(encodeMsgPack(RESOLVED)));
      return;
    }
    if (req.url.startsWith('/package/')) {
      const key = decodeURIComponent(req.url.replace(/^\/package\//, ''));
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

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'ir-closure-test-'));
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
  artifacts: false,
  ...extra,
});

test('end-to-end fail: content importing a package the resolution omits rejects the build', async () => {
  const root = makeRepo();
  try {
    moduleFor = servesContent((key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('react@')
        ? { f: { 'index.js': { c: '// react', d: ['prop-types'], t: false } }, m: [] }
        : { f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] });
    await assert.rejects(
      buildCacheZip(zipOpts(root, { bundlePackages: true })),
      /closure inconsistency: react@18\.3\.1 content imports prop-types, but the resolved dependency set does not include it/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end-to-end warn: an m-only miss resolves the build and warns, naming the package', async () => {
  const root = makeRepo();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    moduleFor = servesContent((key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('react@')
        ? { f: { 'index.js': { c: '// react', d: [], t: false } }, m: ['peer-optional'] }
        : { f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] });
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, new RegExp(`^${RESOLVED.length} packages, `));
    assert.ok(
      warnings.some((line) => /declared but unresolved in bundled content:.*react@18\.3\.1: peer-optional/.test(line)),
      `expected the warn line to name react@18.3.1: peer-optional, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});
