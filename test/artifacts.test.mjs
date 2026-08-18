import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { transformFile, parseFrontmatter } from '@immediately-run/transpiler';
import { treeEntries } from '../dist/git.js';
import { assertEmittedSidecar, emitArtifacts, emitMdxMetadata } from '../dist/artifacts.js';
import { validateMdxMetadataSidecar } from '@immediately-run/platform-constants';
import { buildCacheZip } from '../dist/commands/cacheZip.js';

const APP_TSX = `import { useState } from 'react';

export default function App() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

const UTIL_TS = `export const add = (a: number, b: number): number => a + b;
`;

const POST_MDX = `---
title: Hello
tags:
  - a
  - b
---

# Heading

A paragraph with a ~~strike~~ and a [link](https://example.com).
`;

// Build a throwaway git repo. commit.gpgsign is disabled because this is a plain
// content fixture, not a signed release.
const makeRepo = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'ir-artifacts-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  for (const [p, content] of Object.entries(files)) {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return root;
};

test('emits a valid index and byte-identical transpiled output', async () => {
  const root = makeRepo({
    'src/App.tsx': APP_TSX,
    'src/util.ts': UTIL_TS,
    'node_modules/dep/index.js': 'module.exports = 1;\n',
  });
  try {
    const emission = await emitArtifacts(root, treeEntries(root));

    // index shape (§4.2)
    assert.equal(emission.index.schemaVersion, 1);
    assert.equal(emission.index.toolchain.transpiler, '@immediately-run/transpiler');
    assert.equal(emission.index.toolchain.preset, 'react');
    assert.match(emission.index.toolchain.toolchainHash, /^[0-9a-f]{64}$/);

    // covered sources in, node_modules out
    const keys = Object.keys(emission.index.files).sort();
    assert.deepEqual(keys, ['/src/App.tsx', '/src/util.ts']);

    // per-file entry: out path + srcSha == git blob sha
    const entry = emission.index.files['/src/App.tsx'];
    assert.equal(entry.out, 'transpiled/src/App.tsx.js');
    const blobSha = treeEntries(root).find((e) => e.path === 'src/App.tsx').sha;
    assert.equal(entry.srcSha, blobSha);

    // byte-identity: the emitted artifact equals transformFile of the same source
    // at the runtime path the bundler uses.
    const expected = await transformFile({ path: '/app/src/App.tsx', code: APP_TSX });
    assert.ok(!('error' in expected));
    assert.equal(emission.files.get('transpiled/src/App.tsx.js'), expected.code);
    assert.deepEqual(entry.deps, expected.deps);

    // react-refresh instrumentation present on the .tsx, absent on the plain .ts
    assert.match(emission.files.get('transpiled/src/App.tsx.js'), /\$RefreshSig\$/);
    assert.doesNotMatch(emission.files.get('transpiled/src/util.ts.js'), /\$RefreshSig\$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emits .mdx (and .md) artifacts as MDX — react-refresh-instrumented, deps collected (G-MDX-2)', async () => {
  const root = makeRepo({
    'content/post.mdx': POST_MDX,
    // App-root `.md` is MDX too (transpiler `isTransformable` covers `.mdx?`),
    // so a README is compiled as MDX like any other content file.
    'README.md': '# Readme\n\nPlain markdown.\n',
    'node_modules/pkg/readme.md': '# not covered — under node_modules\n',
  });
  try {
    const emission = await emitArtifacts(root, treeEntries(root));

    // Both app-root markdown files are covered; the node_modules one is not.
    const keys = Object.keys(emission.index.files).sort();
    assert.deepEqual(keys, ['/README.md', '/content/post.mdx']);

    // Byte-identity: the emitted `.mdx` artifact equals `transformFile` of the
    // same source at the runtime path (the §1.1 build==runtime guarantee for MDX).
    const expected = await transformFile({ path: '/app/content/post.mdx', code: POST_MDX });
    assert.ok(!('error' in expected));
    assert.equal(emission.files.get('transpiled/content/post.mdx.js'), expected.code);

    const entry = emission.index.files['/content/post.mdx'];
    // srcSha == the git blob sha, exactly like other extensions.
    const blobSha = treeEntries(root).find((e) => e.path === 'content/post.mdx').sha;
    assert.equal(entry.srcSha, blobSha);

    // deps collected (not the old empty Set): the MDX-emitted provider import, and
    // the react-refresh HMR helper the wrap adds — identical to transformFile.
    assert.deepEqual(entry.deps, expected.deps);
    assert.ok(
      entry.deps.includes('@immediately-run/sdk/MDXProvider'),
      `expected provider in deps, got ${JSON.stringify(entry.deps)}`,
    );

    // react-refresh instrumentation present → a seeded MDX artifact hot-accepts.
    assert.match(emission.files.get('transpiled/content/post.mdx.js'), /\$RefreshSig\$/);
    // frontmatter is stripped by the compile (it is data, not rendered content).
    assert.doesNotMatch(emission.files.get('transpiled/content/post.mdx.js'), /tags:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emitMdxMetadata — .mdx-only, /app-space-ready keys, empty-frontmatter dropped (G-MDX-3)', () => {
  const root = makeRepo({
    'content/post.mdx': POST_MDX,
    'content/empty.mdx': '---\n---\n\n# no frontmatter\n', // 0 keys → dropped
    'content/none.mdx': '# plain, no fence\n', // no frontmatter → dropped
    // App-root `.md` is MDX-transpilable (gets an artifact) but the metadata store
    // is `.mdx`-only, so it must NOT appear in the sidecar (keeps §2 cache==live).
    'README.md': '---\ntitle: Readme\n---\n\n# hi\n',
    'node_modules/pkg/doc.mdx': '---\ntitle: dep\n---\n', // excluded
  });
  try {
    const entries = treeEntries(root);
    const { sidecar, count } = emitMdxMetadata(root, entries);

    assert.equal(sidecar.schemaVersion, 1);
    // Only the one .mdx with non-empty frontmatter; keys are repo-relative with a
    // leading slash (the index.json / manifest key space).
    assert.deepEqual(Object.keys(sidecar.files), ['/content/post.mdx']);
    assert.equal(count, 1);

    const e = sidecar.files['/content/post.mdx'];
    // srcSha == git blob sha, exactly like the artifact index.
    const blobSha = entries.find((x) => x.path === 'content/post.mdx').sha;
    assert.equal(e.srcSha, blobSha);
    // frontmatter is byte-identical to the shared parser (cache==live by construction).
    assert.deepEqual(e.frontmatter, parseFrontmatter(POST_MDX).data);
    assert.deepEqual(e.frontmatter, { title: 'Hello', tags: ['a', 'b'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emitMdxMetadata — a malformed frontmatter file is omitted, non-fatally', () => {
  const root = makeRepo({
    'content/ok.mdx': POST_MDX,
    'content/bad.mdx': '---\n: : not: valid: yaml\n\t- broken\n---\n\n# bad\n',
  });
  try {
    const { sidecar, skipped } = emitMdxMetadata(root, treeEntries(root));
    assert.ok('/content/ok.mdx' in sidecar.files);
    assert.ok(!('/content/bad.mdx' in sidecar.files));
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].path, 'content/bad.mdx');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-zip embeds mdx-metadata.json; --no-mdx-metadata omits it; no-frontmatter repo omits it', async () => {
  const readEntry = (zip, name) =>
    execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const withRoot = makeRepo({ 'content/post.mdx': POST_MDX, 'package.json': '{"name":"x"}\n' });
  try {
    const withZip = join(withRoot, 'with.zip');
    await buildCacheZip({ repoPath: withRoot, owner: 'a', repository: 'b', ref: 'main', out: withZip, lockset: false });
    const sidecar = JSON.parse(readEntry(withZip, '.immediately.run/artifacts/mdx-metadata.json'));
    assert.equal(sidecar.schemaVersion, 1);
    assert.ok('/content/post.mdx' in sidecar.files);

    // --no-mdx-metadata omits the sidecar.
    const offZip = join(withRoot, 'off.zip');
    await buildCacheZip({ repoPath: withRoot, owner: 'a', repository: 'b', ref: 'main', out: offZip, lockset: false, mdxMetadata: false });
    assert.throws(() => readEntry(offZip, '.immediately.run/artifacts/mdx-metadata.json'));
  } finally {
    rmSync(withRoot, { recursive: true, force: true });
  }

  // A repo with no MDX frontmatter ships no sidecar (runtime live-scans, finds nothing).
  const bareRoot = makeRepo({ 'src/App.tsx': APP_TSX, 'package.json': '{"name":"x"}\n' });
  try {
    const bareZip = join(bareRoot, 'bare.zip');
    await buildCacheZip({ repoPath: bareRoot, owner: 'a', repository: 'b', ref: 'main', out: bareZip, lockset: false });
    assert.throws(() => readEntry(bareZip, '.immediately.run/artifacts/mdx-metadata.json'));
  } finally {
    rmSync(bareRoot, { recursive: true, force: true });
  }
});

test('omits a file that fails to transform, non-fatally', async () => {
  const root = makeRepo({ 'src/bad.tsx': 'const = =;\n', 'src/ok.tsx': APP_TSX });
  try {
    const emission = await emitArtifacts(root, treeEntries(root));
    assert.ok('/src/ok.tsx' in emission.index.files);
    assert.ok(!('/src/bad.tsx' in emission.index.files));
    assert.equal(emission.skipped.length, 1);
    assert.equal(emission.skipped[0].path, 'src/bad.tsx');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('is deterministic — two runs produce an identical index and artifacts', async () => {
  const root = makeRepo({ 'src/App.tsx': APP_TSX, 'src/util.ts': UTIL_TS });
  try {
    const a = await emitArtifacts(root, treeEntries(root));
    const b = await emitArtifacts(root, treeEntries(root));
    assert.deepEqual(a.index, b.index);
    assert.deepEqual([...a.files.entries()].sort(), [...b.files.entries()].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-zip embeds the artifact index; --no-artifacts omits it', async () => {
  const root = makeRepo({ 'src/App.tsx': APP_TSX, 'package.json': '{"name":"x"}\n' });
  const readEntry = (zip, name) =>
    execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const withArtifacts = join(root, 'with.zip');
    await buildCacheZip({
      repoPath: root,
      owner: 'acme',
      repository: 'demo',
      ref: 'main',
      out: withArtifacts,
      lockset: false,
    });
    const index = JSON.parse(readEntry(withArtifacts, '.immediately.run/artifacts/index.json'));
    assert.equal(index.schemaVersion, 1);
    assert.ok('/src/App.tsx' in index.files);
    // the transpiled output is present and evaluable-shaped (CommonJS module)
    const out = readEntry(withArtifacts, '.immediately.run/artifacts/transpiled/src/App.tsx.js');
    assert.match(out, /\$RefreshSig\$/);

    const noArtifacts = join(root, 'none.zip');
    await buildCacheZip({
      repoPath: root,
      owner: 'acme',
      repository: 'demo',
      ref: 'main',
      out: noArtifacts,
      artifacts: false,
      lockset: false,
    });
    assert.throws(() => readEntry(noArtifacts, '.immediately.run/artifacts/index.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R3-275b — the sidecar's schema is owned by @immediately-run/platform-constants now,
// and this writer runs the READER's validator over its own output before the zip is
// written. These pin that guard: the drift it catches is this emitter diverging from
// the schema the sandbox enforces, caught in the build that produced the zip rather
// than downstream, where an unusable sidecar looks exactly like a repo with no
// frontmatter (the runtime treats present-but-unusable as "seeded, nothing to do").
test('assertEmittedSidecar — a deliberately broken write is caught before it is written', () => {
  const valid = { schemaVersion: 1, files: { '/a.mdx': { srcSha: 'abc', frontmatter: { t: 1 } } } };
  assert.doesNotThrow(() => assertEmittedSidecar(valid));

  // Whole-file breakage: the reader would not know what it is looking at.
  assert.throws(
    () => assertEmittedSidecar({ ...valid, schemaVersion: 2 }),
    /schema-version/,
  );
  assert.throws(() => assertEmittedSidecar({ schemaVersion: 1, files: [] }), /files-not-an-object/);
  assert.throws(() => assertEmittedSidecar(null), /not-an-object/);

  // Entry-level breakage: the reader would silently drop just this file, so the guard
  // has to name it rather than let a partly-useless sidecar ship.
  assert.throws(
    () => assertEmittedSidecar({ schemaVersion: 1, files: { '/a.mdx': { frontmatter: { t: 1 } } } }),
    /entry-src-sha/,
  );
  assert.throws(
    () => assertEmittedSidecar({ schemaVersion: 1, files: { '/a.mdx': { srcSha: 'x', frontmatter: 'nope' } } }),
    /entry-frontmatter/,
  );
  assert.throws(
    () => assertEmittedSidecar({ schemaVersion: 1, files: { '/a.mdx': { srcSha: 'x', frontmatter: {} } } }),
    /entry-frontmatter-empty/,
  );
});

test('emitMdxMetadata output is accepted by the shared validator, entry for entry', () => {
  const root = makeRepo({
    'content/post.mdx': POST_MDX,
    'content/other.mdx': '---\ntitle: Other\ntags:\n  - a\n  - b\n---\n\n# other\n',
  });
  try {
    const entries = treeEntries(root);
    const { sidecar } = emitMdxMetadata(root, entries);

    // The reader's own verdict on the writer's bytes — the round trip this item is
    // about, minus the transport.
    const verdict = validateMdxMetadataSidecar(JSON.parse(JSON.stringify(sidecar)));
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.rejected, []);
    assert.deepEqual(Object.keys(verdict.sidecar.files).sort(), ['/content/other.mdx', '/content/post.mdx']);

    // …and the two confinement properties the sandbox checks ON TOP of the schema,
    // which the writer is the only side able to get right: every key names a manifest
    // member, and every srcSha is that member's blob sha. A sidecar that fails these
    // validates fine and still seeds nothing.
    for (const [key, entry] of Object.entries(verdict.sidecar.files)) {
      const member = entries.find((e) => `/${e.path}` === key);
      assert.ok(member, `sidecar key ${key} is not a manifest member`);
      assert.equal(entry.srcSha, member.sha);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
