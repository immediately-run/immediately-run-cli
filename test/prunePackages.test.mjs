// Tests for the bundled-package pruner (`src/prunePackages.ts`): content is kept only for
// package files a route from the app reaches, and everything else is listed by size.
// Runs against the compiled dist/ (`npm test` builds first). Uses node:test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { encode as encodeMsgPack, decode as decodeMsgPack } from '@msgpack/msgpack';
import { PLATFORM_CORE_JS_VERSION } from '@immediately-run/transpiler';

import { pruneBundledPackages, PLATFORM_SPECIFIERS } from '../dist/prunePackages.js';
import { encodePackageKey, bundledPackageFilename } from '../dist/lockset.js';
import { buildCacheZip, CACHE_ZIP_USAGE } from '../dist/commands/cacheZip.js';
import { parseArgs } from '../dist/args.js';
import { PACKAGES_DIR } from '@immediately-run/platform-constants';

const file = (c, d = []) => ({ c, d, t: true });
const manifest = (fields) => ({ c: JSON.stringify(fields), d: [], t: false });
const pack = (name, f, m = []) => ({
  key: encodePackageKey(name, '1.0.0'),
  name,
  version: '1.0.0',
  bytes: encodeMsgPack({ f, m }),
});
const filesOf = (result, name) => decodeMsgPack(result.packages.find((p) => p.name === name).bytes).f;
const inlined = (result, name) =>
  Object.entries(filesOf(result, name))
    .filter(([, entry]) => typeof entry === 'object')
    .map(([path]) => path)
    .sort();

// A package shaped like react-dom: a root entry, a `./client` subpath, and a server build
// behind its own subpath that a browser app never imports.
const domLike = () =>
  pack('dom', {
    'package.json': manifest({
      name: 'dom',
      main: 'index.js',
      exports: {
        '.': { 'react-server': './server-only.js', default: './index.js' },
        './client': './client.js',
        './server': { node: './server.node.js', default: './server.browser.js' },
        './package.json': './package.json',
      },
    }),
    'index.js': file('module.exports = require("./cjs/dom.js")', ['./cjs/dom.js']),
    'client.js': file('module.exports = require("./cjs/client")', ['./cjs/client']),
    'cjs/dom.js': file('exports.dom = 1', []),
    'cjs/client.js': file('exports.client = require("sched")', ['sched']),
    'server.node.js': file('exports.server = "node"'.repeat(200), ['./cjs/server.js']),
    'server.browser.js': file('exports.server = "browser"'.repeat(200), ['./cjs/server.js']),
    'server-only.js': file('throw new Error("react-server only")'),
    'cjs/server.js': file('exports.render = 1'.repeat(500)),
    'style.css': { c: '.a{}', d: [], t: false },
    'README.md': 1234,
  });

// Reached only through `dom/client`'s require, never by an app import.
const schedLike = () =>
  pack('sched', {
    'package.json': manifest({ name: 'sched', main: 'index.js' }),
    'index.js': file('module.exports = require("./cjs/sched.js")', ['./cjs/sched.js']),
    'cjs/sched.js': file('exports.s = 1'),
    'unstable_mock.js': file('exports.mock = 1'.repeat(100)),
  });

test('a file a route from the app reaches keeps its content; an unreachable one becomes its byte size', () => {
  const result = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  const f = filesOf(result, 'dom');
  assert.deepEqual(f['client.js'], file('module.exports = require("./cjs/client")', ['./cjs/client']));
  assert.equal(typeof f['cjs/client.js'], 'object');
  for (const gone of ['server.node.js', 'server.browser.js', 'cjs/server.js', 'server-only.js', 'index.js', 'cjs/dom.js']) {
    assert.equal(typeof f[gone], 'number', `${gone} must be size-only`);
  }
  // The size is the UTF-8 byte length of what was there, which is what the runtime's
  // `statSync` reports for a numeric entry.
  assert.equal(f['cjs/server.js'], Buffer.byteLength('exports.render = 1'.repeat(500), 'utf8'));
  // Demoted, never removed: the file map still names every file.
  assert.deepEqual(Object.keys(f), Object.keys(decodeMsgPack(domLike().bytes).f));
  assert.equal(result.prunedPackages, 2);
  assert.ok(result.bytesAfter < result.bytesBefore);
});

test('a transitive `d` edge crosses into another package, and prunes that package by what it reached', () => {
  const result = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  assert.deepEqual(inlined(result, 'sched'), ['cjs/sched.js', 'index.js', 'package.json']);
  assert.equal(typeof filesOf(result, 'sched')['unstable_mock.js'], 'number');
});

test('only JavaScript is demoted: package.json, a stylesheet and an already size-only entry are untouched', () => {
  const result = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  const f = filesOf(result, 'dom');
  assert.equal(typeof f['package.json'], 'object');
  assert.deepEqual(f['style.css'], { c: '.a{}', d: [], t: false });
  assert.equal(f['README.md'], 1234);
});

test('a root import takes every main field and every condition of ".", except the skipped ones', () => {
  const result = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom'] });
  const f = filesOf(result, 'dom');
  assert.equal(typeof f['index.js'], 'object');
  assert.equal(typeof f['cjs/dom.js'], 'object');
  assert.equal(typeof f['server-only.js'], 'number', '`react-server` is a condition a browser never takes');
  assert.equal(typeof f['client.js'], 'number');
});

test('an `exports` wildcard subpath resolves through its pattern', () => {
  const icons = pack('icons', {
    'package.json': manifest({ name: 'icons', exports: { '.': './dist/index.js', './icons/*': './dist/icons/*.js' } }),
    'dist/index.js': file('exports.all = 1'.repeat(300), ['./icons/a.js', './icons/b.js']),
    'dist/icons/a.js': file('exports.a = 1'),
    'dist/icons/b.js': file('exports.b = 1'),
  });
  const result = pruneBundledPackages([icons], { appSpecifiers: ['icons/icons/a'] });
  assert.deepEqual(inlined(result, 'icons'), ['dist/icons/a.js', 'package.json']);
});

test('a subpath with no `exports` map resolves as a file, with the runtime extension list', () => {
  const plain = pack('plain', {
    'package.json': manifest({ name: 'plain', main: 'lib/index.js' }),
    'lib/index.js': file('exports.i = 1'),
    'lib/deep.mjs': file('exports.d = 1'),
    'lib/other.js': file('exports.o = 1'),
  });
  const result = pruneBundledPackages([plain], { appSpecifiers: ['plain/lib/deep'] });
  assert.deepEqual(inlined(result, 'plain'), ['lib/deep.mjs', 'package.json']);
});

test('every target of a `browser` replacement map is kept once the package is entered', () => {
  const swapped = pack('swapped', {
    'package.json': manifest({ name: 'swapped', main: 'index.js', browser: { './node.js': './browser.js', fs: false } }),
    'index.js': file('module.exports = require("./node.js")', ['./node.js']),
    'node.js': file('exports.n = 1'),
    'browser.js': file('exports.b = 1'),
    'unused.js': file('exports.u = 1'),
  });
  const result = pruneBundledPackages([swapped], { appSpecifiers: ['swapped'] });
  assert.deepEqual(inlined(result, 'swapped'), ['browser.js', 'index.js', 'node.js', 'package.json']);
});

test('the platform specifiers are seeded whatever the app imports', () => {
  assert.ok(PLATFORM_SPECIFIERS.includes('react-dom/client'));
  const reactDom = pack('react-dom', {
    'package.json': manifest({ name: 'react-dom', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './server': './server.js' } }),
    'index.js': file('exports.i = 1'),
    'client.js': file('exports.c = 1'),
    'server.js': file('exports.s = 1'),
  });
  // The app imports nothing from react-dom at all: the SDK and the boot-default entry do.
  const result = pruneBundledPackages([reactDom], { appSpecifiers: [] });
  assert.deepEqual(inlined(result, 'react-dom'), ['client.js', 'index.js', 'package.json']);
});

// --- the cases that must NOT be pruned ---------------------------------------

const sameBytes = (result, original) =>
  assert.equal(result.packages.find((p) => p.name === original.name), original, `${original.name} must be the same object`);

test('a package with no readable package.json ships verbatim', () => {
  const bare = pack('bare', { 'index.js': file('exports.x = 1'), 'other.js': file('exports.y = 1') });
  const result = pruneBundledPackages([bare], { appSpecifiers: ['bare'] });
  sameBytes(result, bare);
  assert.equal(result.demotedFiles, 0);
});

test('a package no route reaches ships verbatim, and its own requires are still followed', () => {
  const unreached = pack('unreached', {
    'package.json': manifest({ name: 'unreached', main: 'index.js' }),
    'index.js': file('module.exports = require("sched/unstable_mock")', ['sched/unstable_mock']),
    'extra.js': file('exports.e = 1'),
  });
  // `dom/client` reaches `sched` by its root; only the verbatim package asks for the mock.
  const withRoute = pruneBundledPackages([unreached, domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  sameBytes(withRoute, unreached);
  assert.equal(typeof filesOf(withRoute, 'sched')['unstable_mock.js'], 'object');
  const without = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  assert.equal(typeof filesOf(without, 'sched')['unstable_mock.js'], 'number');
});

test('packages unreached in the same pass are all kept whole, not pruned by each other', () => {
  // Which of two unreached packages "came first" is not a fact about the app, so neither
  // is pruned on the strength of the other's requires.
  const unreached = pack('unreached', {
    'package.json': manifest({ name: 'unreached', main: 'index.js' }),
    'index.js': file('module.exports = require("sched/unstable_mock")', ['sched/unstable_mock']),
  });
  const sched = schedLike();
  const result = pruneBundledPackages([unreached, sched], { appSpecifiers: [] });
  sameBytes(result, unreached);
  sameBytes(result, sched);
});

test('a specifier that names no file keeps the package whole rather than pruning around it', () => {
  const dom = domLike();
  const result = pruneBundledPackages([dom, schedLike()], { appSpecifiers: ['dom/no-such-entry'] });
  sameBytes(result, dom);
});

test('a package-internal `#import` keeps the package whole', () => {
  const internal = pack('internal', {
    'package.json': manifest({ name: 'internal', main: 'index.js', imports: { '#impl': './impl.js' } }),
    'index.js': file('module.exports = require("#impl")', ['#impl']),
    'impl.js': file('exports.i = 1'),
    'unused.js': file('exports.u = 1'),
  });
  const result = pruneBundledPackages([internal], { appSpecifiers: ['internal'] });
  sameBytes(result, internal);
});

test('a `neverPrune` package ships verbatim even when the app reaches only part of it', () => {
  const dom = domLike();
  const result = pruneBundledPackages([dom, schedLike()], {
    appSpecifiers: ['dom/client'],
    neverPrune: new Set(['dom']),
  });
  sameBytes(result, dom);
  // …and every file in it is a source of edges: `sched` is entered from `cjs/client.js`.
  assert.equal(typeof filesOf(result, 'sched')['index.js'], 'object');
});

test('undecodable bytes and two versions of one name are left alone', () => {
  const junk = { key: 'k', name: 'junk', version: '1.0.0', bytes: new Uint8Array([0xc1, 0xff, 0x00]) };
  const a = domLike();
  const b = { ...domLike(), version: '2.0.0' };
  const result = pruneBundledPackages([junk, a, b], { appSpecifiers: ['dom/client'] });
  assert.equal(result.packages[0], junk);
  assert.equal(result.packages[1], a);
  assert.equal(result.packages[2], b);
});

test('an unknown import list prunes nothing and says why', () => {
  const dom = domLike();
  const result = pruneBundledPackages([dom], { appSpecifiers: null });
  sameBytes(result, dom);
  assert.match(result.skippedReason, /not known/);
});

test('pruning is deterministic: the same input produces the same bytes, in the same order', () => {
  const run = () => pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client'] });
  const first = run();
  const second = run();
  assert.deepEqual(
    first.packages.map((p) => [p.name, Buffer.from(p.bytes).toString('base64')]),
    second.packages.map((p) => [p.name, Buffer.from(p.bytes).toString('base64')]),
  );
  // Specifier order is not an input: the walk is a closure, not a traversal record.
  const reordered = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['sched', 'dom/client'] });
  const forward = pruneBundledPackages([domLike(), schedLike()], { appSpecifiers: ['dom/client', 'sched'] });
  assert.deepEqual(
    reordered.packages.map((p) => Buffer.from(p.bytes).toString('base64')),
    forward.packages.map((p) => Buffer.from(p.bytes).toString('base64')),
  );
});

// --- integration: cache-zip --bundle-packages --------------------------------

const RESOLVED = [
  { n: 'dom', v: '1.0.0', d: 0 },
  { n: 'sched', v: '1.0.0', d: 1 },
  { n: 'core-js', v: PLATFORM_CORE_JS_VERSION, d: 0 },
  { n: 'react-error-boundary', v: '6.1.0', d: 0 },
  { n: 'react-refresh', v: '0.11.0', d: 0 },
];
// The platform-injected packages get a manifest and an unreachable file too, so "never
// pruned" is shown by a file that WOULD be demoted if the rule were missing.
const platformLike = (name) => ({
  f: {
    'package.json': manifest({ name, main: 'index.js' }),
    'index.js': file(`exports.name = ${JSON.stringify(name)}`),
    'runtime.js': file('exports.runtime = 1'),
  },
  m: [],
});
const CDN = {
  dom: decodeMsgPack(domLike().bytes),
  sched: decodeMsgPack(schedLike().bytes),
  'core-js': platformLike('core-js'),
  'react-error-boundary': platformLike('react-error-boundary'),
  'react-refresh': platformLike('react-refresh'),
};

let server;
let cdnRoot;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    if (req.url.startsWith('/dep_tree/')) {
      res.end(Buffer.from(encodeMsgPack(RESOLVED)));
      return;
    }
    const found = RESOLVED.find(({ n, v }) => req.url === `/package/${encodePackageKey(n, v)}`);
    res.end(Buffer.from(encodeMsgPack(found ? CDN[found.n] : { f: {}, m: [] })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cdnRoot = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

const makeRepo = (files, pkg = { dependencies: { dom: '^1.0.0' } }) => {
  const root = mkdtempSync(join(tmpdir(), 'ir-prune-test-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  for (const [path, content] of Object.entries({ 'package.json': JSON.stringify(pkg), ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
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
  bundlePackages: true,
  ...extra,
});

const bundledFiles = (zipPath, name) =>
  decodeMsgPack(
    execFileSync('unzip', ['-p', zipPath, `${PACKAGES_DIR}/${bundledPackageFilename(name, '1.0.0')}.msgpack`], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).f;

const APP = { 'index.tsx': 'import { createRoot } from "dom/client";\nexport const root = createRoot;\n' };

test('cache-zip prunes bundled packages by the app import list, and reports the totals', async () => {
  const root = makeRepo(APP);
  try {
    const result = await buildCacheZip(zipOpts(root));
    assert.match(result.bundledPackagesSummary, /; pruned [\d.]+ K?B → [\d.]+ K?B \(\d+ unreachable file\(s\) in 2 package\(s\) listed by size\)$/);
    const dom = bundledFiles(result.outputPath, 'dom');
    assert.equal(typeof dom['client.js'], 'object');
    assert.equal(typeof dom['cjs/server.js'], 'number');
    assert.equal(typeof bundledFiles(result.outputPath, 'sched')['unstable_mock.js'], 'number');
    // Platform-injected packages are entered by the runtime, not by an app import: they are
    // byte-identical to the unpruned build's, whichever source supplied them.
    const whole = await buildCacheZip(zipOpts(root, { prunePackages: false, out: join(root, 'whole.zip') }));
    for (const name of ['core-js', 'react-refresh', 'react-error-boundary']) {
      const version = RESOLVED.find((r) => r.n === name).v;
      const entry = `${PACKAGES_DIR}/${bundledPackageFilename(name, version)}.msgpack`;
      const read = (zip) => execFileSync('unzip', ['-p', zip, entry], { maxBuffer: 256 * 1024 * 1024 });
      assert.ok(read(result.outputPath).equals(read(whole.outputPath)), `${name} must ship verbatim`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an import in an artifact-excluded file (a test) still counts as reachable', async () => {
  const root = makeRepo({ ...APP, 'index.test.tsx': 'import { render } from "dom/server";\nexport const r = render;\n' });
  try {
    const result = await buildCacheZip(zipOpts(root));
    const dom = bundledFiles(result.outputPath, 'dom');
    assert.equal(typeof dom['server.browser.js'], 'object');
    assert.equal(typeof dom['cjs/server.js'], 'object');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--no-prune-packages ships every package whole', async () => {
  const root = makeRepo(APP);
  try {
    const result = await buildCacheZip(zipOpts(root, { prunePackages: false }));
    assert.match(result.bundledPackagesSummary, /; not pruned \(--no-prune-packages\)$/);
    assert.deepEqual(bundledFiles(result.outputPath, 'dom'), CDN.dom.f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(parseArgs(['--no-prune-packages', 'repo']).flags['no-prune-packages'], true);
  assert.deepEqual(parseArgs(['--no-prune-packages', 'repo']).positionals, ['repo']);
  assert.match(CACHE_ZIP_USAGE, /--no-prune-packages/);
});

test('pruning stands down, by name, when the app import list is incomplete', async () => {
  // No artifacts: no import list at all.
  const plain = makeRepo(APP);
  try {
    const result = await buildCacheZip(zipOpts(plain, { artifacts: false }));
    assert.match(result.bundledPackagesSummary, /; not pruned \(no artifacts/);
    assert.deepEqual(bundledFiles(result.outputPath, 'dom'), CDN.dom.f);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  // A dynamic import the collector cannot read: that file's imports are unknown.
  const dynamic = makeRepo({ ...APP, 'lazy.ts': 'export const load = (name: string) => import(name);\n' });
  try {
    const result = await buildCacheZip(zipOpts(dynamic));
    assert.match(result.bundledPackagesSummary, /; not pruned \(1 source file\(s\) produced no artifact/);
    assert.deepEqual(bundledFiles(result.outputPath, 'dom'), CDN.dom.f);
  } finally {
    rmSync(dynamic, { recursive: true, force: true });
  }
  // A library mounted at boot brings imports this build never reads.
  const mounted = makeRepo(APP, {
    dependencies: { dom: '^1.0.0' },
    'immediately.run': { resolveFromRegistry: ['@immediately-run/sdk', '@acme/widgets'] },
  });
  try {
    const result = await buildCacheZip(zipOpts(mounted));
    assert.match(result.bundledPackagesSummary, /; not pruned \(@acme\/widgets resolved outside the lockset/);
    assert.deepEqual(bundledFiles(result.outputPath, 'dom'), CDN.dom.f);
  } finally {
    rmSync(mounted, { recursive: true, force: true });
  }
});

test('two builds of the same commit bundle byte-identical pruned packages', async () => {
  const root = makeRepo(APP);
  try {
    const read = (zip) =>
      RESOLVED.map(({ n, v }) =>
        execFileSync('unzip', ['-p', zip, `${PACKAGES_DIR}/${bundledPackageFilename(n, v)}.msgpack`], {
          // core-js 3.51.0's record is past execFileSync's 1 MiB default.
          maxBuffer: 256 * 1024 * 1024,
        }).toString('base64'),
      );
    const first = await buildCacheZip(zipOpts(root, { out: join(root, 'a.zip') }));
    const second = await buildCacheZip(zipOpts(root, { out: join(root, 'b.zip') }));
    assert.deepEqual(read(first.outputPath), read(second.outputPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
