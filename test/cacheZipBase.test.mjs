// Regression test for the cache-zip git-archive base (the bug the G2-3 artifacts
// refactor introduced: the zip carried only the .immediately.run/ sidecar, none of the
// tracked repo files, so every blob failed the host's verifyZipBlobs). Runs against
// the compiled dist/ (`npm test` builds first). Uses node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCacheZip } from '../dist/commands/cacheZip.js';

const gitBlobSha = (buf) => {
  const h = createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
};

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'ir-cachezip-base-'));
  const g = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'index.tsx'), 'export const x = 1;\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'App.tsx'), 'export const App = () => null;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  return root;
};

const entryNames = (zip) =>
  execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('cache-zip includes the tracked tree at HEAD (git archive base), not just the sidecar', async () => {
  const root = makeRepo();
  try {
    // --no-lockset/--no-artifacts: isolate the base archive (no network, no transpile).
    const { outputPath } = await buildCacheZip({
      repoPath: root,
      owner: 'o',
      repository: 'r',
      ref: 'main',
      defaultBranch: 'main',
      out: join(root, 'out.zip'),
      artifacts: false,
      lockset: false,
    });
    const names = entryNames(outputPath);
    // The tracked files MUST be present (the regression: only the sidecar was).
    assert.ok(names.includes('index.tsx'), 'index.tsx present');
    assert.ok(names.includes('src/App.tsx'), 'src/App.tsx present');
    assert.ok(names.includes('package.json'), 'package.json present');
    assert.ok(names.includes('.immediately.run/contribute-manifest.json'), 'sidecar present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every sidecar blob entry's bytes are in the zip and hash-match (verifyZipBlobs parity)", async () => {
  const root = makeRepo();
  try {
    const { outputPath } = await buildCacheZip({
      repoPath: root,
      owner: 'o',
      repository: 'r',
      ref: 'main',
      defaultBranch: 'main',
      out: join(root, 'out.zip'),
      artifacts: false,
      lockset: false,
    });
    const sidecar = JSON.parse(
      execFileSync('unzip', ['-p', outputPath, '.immediately.run/contribute-manifest.json'], { encoding: 'utf8' }),
    );
    const blobs = sidecar.entries.filter((e) => e.type === 'blob');
    assert.ok(blobs.length >= 3);
    for (const e of blobs) {
      // Mirrors the host's verifyZipBlobs: the bytes at e.path must git-blob-hash to e.sha.
      const bytes = execFileSync('unzip', ['-p', outputPath, e.path], { maxBuffer: 1e8 });
      assert.equal(gitBlobSha(bytes), e.sha, `blob ${e.path} matches its sidecar sha`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
