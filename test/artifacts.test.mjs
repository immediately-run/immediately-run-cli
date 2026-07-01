import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { transformFile } from '@immediately-run/transpiler';
import { treeEntries } from '../dist/git.js';
import { emitArtifacts } from '../dist/artifacts.js';
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
