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

test('bareDependencyName refuses Node-internal #imports', () => {
  assert.equal(bareDependencyName('#internal'), null);
});

test('a peer exemption is per-importer: one package\'s peer never masks another\'s miss', () => {
  const a = bundled('pkg-with-peers', '1.0.0', {
    f: { 'index.js': { c: '// a', d: ['react'], t: false } },
    m: [],
  });
  const b = bundled('pkg-without-peers', '1.0.0', {
    f: { 'index.js': { c: '// b', d: ['react'], t: false } },
    m: [],
  });
  const findings = closureFindings(
    [a, b],
    new Set(),
    new Set(),
    new Map([['pkg-with-peers', new Set(['react'])]]),
  );
  // pkg-with-peers imports its own peer react (npm semantics: the consumer
  // supplies it); pkg-without-peers imports react with no peer relationship —
  // a genuine miss.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'pkg-without-peers');
  assert.equal(findings[0].dependency, 'react');
});

test('a non-bare m entry (node:fs, relative) is skipped, not warned', () => {
  const pkg = bundled('app-pkg', '1.0.0', { f: {}, m: ['node:fs', './x', 'https://esm.sh/y'] });
  assert.deepEqual(closureFindings([pkg], new Set()), []);
});

test('undecodable or non-module bytes are an import-source finding naming the package', () => {
  const nullBytes = new Uint8Array(Buffer.from(encodeMsgPack(null)));
  const findings = closureFindings(
    [{ key: 'k', name: 'broken-pkg', version: '2.0.0', bytes: nullBytes }],
    new Set(['everything']),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'import');
  assert.equal(findings[0].name, 'broken-pkg');
  assert.match(
    closureFailureMessage(findings[0]),
    /closure inconsistency: broken-pkg@2\.0\.0 bundled content is not decodable ICDNModule msgpack/,
  );
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
let depTree = RESOLVED; // per-test /dep_tree answer (R3-1337's cases swap it)

// The /package/ key is base64(LOCKSET_CDN_VERSION(name@version)), so content
// selectors must match on the DECODED key — a selector over the raw key never
// fires (found the hard way: react's bytes arrived as the else-branch).
const servesContent = (resolve) => (key) => resolve(key);

before(async () => {
  server = createServer((req, res) => {
    if (req.url.startsWith('/dep_tree/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(encodeMsgPack(depTree)));
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

test('a declared BUILD dependency is not exempt — only the self-hosted rail is (the build-filter subtraction)', async () => {
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.2.0', vite: '^5.0.0' } }),
    );
    const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'declare a build tool']);
    // vite in dependencies is filtered from the embedded DepMap as a build
    // dep — but it is NOT on the self-hosted rail, so runtime content
    // importing it is a genuine miss and the build must go red.
    moduleFor = (key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('react@')
        ? { f: { 'index.js': { c: '// react', d: ['vite'], t: false } }, m: [] }
        : { f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] };
    await assert.rejects(
      buildCacheZip(zipOpts(root, { bundlePackages: true })),
      /closure inconsistency: react@18\.3\.1 content imports vite, but the resolved dependency set does not include it/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end-to-end: the self-hosted SDK a declared app imports does not fail the build (the strip-set derivation)', async () => {
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.2.0', '@immediately-run/sdk': '^0.30.0' } }),
    );
    const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'declare the sdk']);
    // The transpiler strips the SDK from the embedded DepMap by construction,
    // so it never appears in resolved — while real bundled content (the
    // omnibox fixture shape) imports its subpaths. The exemption is DERIVED
    // from the two maps (head deps minus embedded DepMap), never hardcoded.
    moduleFor = (key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('react@')
        ? { f: { 'index.js': { c: '// react', d: ['@immediately-run/sdk/platformLink'], t: false } }, m: [] }
        : { f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] };
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, new RegExp(`^${RESOLVED.length} packages, `));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end-to-end: a registry-resolved name imported by bundled content does not fail the build', async () => {
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.2.0' },
        'immediately.run': { resolveFromRegistry: ['self-hosted-lib'] },
      }),
    );
    const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    g(['add', 'package.json']);
    g(['commit', '-q', '-m', 'registry-resolved dep']);
    moduleFor = (key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('react@')
        ? { f: { 'index.js': { c: '// react', d: ['self-hosted-lib'], t: false } }, m: [] }
        : { f: { 'index.js': { c: `// ${key}`, d: [], t: false } }, m: [] };
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, new RegExp(`^${RESOLVED.length} packages, `));
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

// --- R3-1337: a repo without React, and the CDN's injected @swc/helpers ------------------
//
// The producer is baton's REAL package.json at origin/main (immediately-run/baton 47824e3,
// 2026-11-05): a Cloudflare Worker whose only runtime dependency is jose. The /dep_tree answer
// is the shape the live CDN gave for it, with react-error-boundary at a version this CLI's own
// copy does not carry, so its bytes come from the CDN (the race that failed baton: the CDN's
// mirror at 6.1.5, npm's latest 6.1.6 beside the CLI). The content records are the live ones'
// shapes: react-error-boundary imports react; jose's CJS build requires @swc/helpers
// (`dist/webapi/jwt/encrypt.js`, 8 of 80 files on the live CDN).
const BATON_PACKAGE_JSON = { dependencies: { jose: '^6.2.12' } };
const BATON_TREE = [
  { n: 'core-js', v: '3.22.7', d: 0 },
  { n: 'jose', v: '6.2.14', d: 0 },
  { n: 'react-error-boundary', v: '6.1.0', d: 0 },
  { n: 'react-refresh', v: '0.11.0', d: 0 },
];
const batonContent = (key) => {
  const id = Buffer.from(key, 'base64').toString('utf8');
  if (id.includes('react-error-boundary@')) {
    return { f: { 'dist/index.cjs': { c: '// reb', d: ['react'], t: false } }, m: ['react'] };
  }
  if (id.includes('jose@')) {
    return { f: { 'dist/webapi/jwt/encrypt.js': { c: 'var swcHelpers=require("@swc/helpers");', d: ['@swc/helpers'], t: false } }, m: [] };
  }
  return { f: { 'index.js': { c: `// ${id}`, d: [], t: false } }, m: [] };
};
const makeBatonRepo = () => {
  const root = makeRepo();
  writeFileSync(join(root, 'package.json'), JSON.stringify(BATON_PACKAGE_JSON));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['add', 'package.json']);
  g(['commit', '-q', '-m', 'baton manifest']);
  return root;
};
const zipLockset = (outputPath) =>
  JSON.parse(execFileSync('unzip', ['-p', outputPath, '.immediately.run/contribute-manifest.json'], { encoding: 'utf8' })).lockset;
const zipPackages = (outputPath) =>
  execFileSync('unzip', ['-Z1', outputPath], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('.immediately.run/packages/'));

test('R3-1337: a repo without react builds — a CDN-sourced platform package\'s peer is exempt, and @swc/helpers is closed over', async () => {
  const root = makeBatonRepo();
  depTree = BATON_TREE;
  try {
    moduleFor = servesContent(batonContent);
    const result = await buildCacheZip(zipOpts(root, { bundlePackages: true }));
    assert.match(result.bundledPackagesSummary, /\+2 closed over by this CLI \(CDN-injected helpers\): @swc\/helpers@0\.5\.17, tslib@/);
    const resolved = zipLockset(result.outputPath).resolved.map((e) => e.n);
    assert.ok(resolved.includes('@swc/helpers') && resolved.includes('tslib'), `lockset.resolved: ${resolved.join(', ')}`);
    assert.ok(!resolved.includes('react'), 'react must not be pulled into a repo that never declared it');
    const files = zipPackages(result.outputPath);
    assert.ok(files.some((f) => f.includes(encodeURIComponent('@swc/helpers@0.5.17'))), `bundled: ${files.join(', ')}`);
  } finally {
    depTree = RESOLVED;
    rmSync(root, { recursive: true, force: true });
  }
});

test('R3-1337: an APP-declared package importing react in a repo without react still fails the build', async () => {
  const root = makeBatonRepo();
  depTree = BATON_TREE;
  try {
    moduleFor = servesContent((key) =>
      Buffer.from(key, 'base64').toString('utf8').includes('jose@')
        ? { f: { 'index.js': { c: '// jose', d: ['react'], t: false } }, m: [] }
        : batonContent(key));
    await assert.rejects(
      buildCacheZip(zipOpts(root, { bundlePackages: true })),
      /closure inconsistency: jose@6\.2\.14 content imports react, but the resolved dependency set does not include it/,
    );
  } finally {
    depTree = RESOLVED;
    rmSync(root, { recursive: true, force: true });
  }
});

// R3-1337's three closureFindings groups, asserted directly (review 1-B-1): the per-package
// keying of the peer map is what keeps (a) from masking (b).
test('R3-1337 (a)/(b): a CDN-sourced platform package\'s own peer is exempt; the same import from another package is not', () => {
  const reb = bundled('react-error-boundary', '6.1.5', { f: { 'dist/index.cjs': { c: '// reb', d: ['react'], t: false } }, m: [] });
  const jose = bundled('jose', '6.2.14', { f: { 'index.js': { c: '// jose', d: ['react'], t: false } }, m: [] });
  const findings = closureFindings([reb, jose], new Set(['react-error-boundary', 'jose']), new Set(), new Map([['react-error-boundary', new Set(['react', '@types/react'])]]));
  assert.deepEqual(findings.map((f) => `${f.name}:${f.dependency}`), ['jose:react']);
});

test('R3-1337 (c): content requiring @swc/helpers is not a finding once the helper is resolved', () => {
  const jose = bundled('jose', '6.2.14', { f: { 'dist/webapi/jwt/encrypt.js': { c: 'var swcHelpers=require("@swc/helpers");', d: ['@swc/helpers'], t: false } }, m: [] });
  assert.equal(closureFindings([jose], new Set(['jose'])).length, 1);
  assert.equal(closureFindings([jose], new Set(['jose', '@swc/helpers'])).length, 0);
});
