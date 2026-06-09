// Tests for UI release authoring/resolution (UI_RELEASES_SPEC §5).
// Runs against compiled dist/ (`npm test` builds first). No network: the pure
// path uses a stub resolver, and the command's --check mode is networkless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseBindingId,
  appKey,
  flattenAuthoring,
  resolveLock,
  serializeLock,
  serializeIndex,
  buildIndex,
  sha256Hex,
} from '../dist/release.js';
import { runPinRelease } from '../dist/commands/pinRelease.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
// Deterministic stub: maps a binding to a commit by repository name.
const stub = (b) => (b.repository === 'monaco-editor' ? SHA2 : SHA);

test('parseBindingId + appKey strip ref/commit to the repo scope', () => {
  const b = parseBindingId('github:immediately-run/space-manager@main');
  assert.equal(appKey(b), 'github:immediately-run/space-manager');
  assert.equal(b.ref, 'main');
});

test('flattenAuthoring: overlay wins per region', () => {
  const base = { id: 'base', apps: { 'panel.spaces': 'github:ir/sm@main', 'task.edit-file': 'github:ir/ef@main' } };
  const overlay = { id: 'monaco', extends: 'base', apps: { 'task.edit-file': 'github:ir/monaco-editor@main' } };
  const bases = new Map([['base', base], ['monaco', overlay]]);
  const flat = flattenAuthoring(overlay, bases);
  assert.deepEqual(flat, {
    'panel.spaces': 'github:ir/sm@main',
    'task.edit-file': 'github:ir/monaco-editor@main',
  });
});

test('flattenAuthoring: overlay region absent from base is rejected (R3)', () => {
  const base = { id: 'base', apps: { 'panel.spaces': 'github:ir/sm@main' } };
  const overlay = { id: 'x', extends: 'base', apps: { 'panel.bogus': 'github:ir/b@main' } };
  const bases = new Map([['base', base], ['x', overlay]]);
  assert.throws(() => flattenAuthoring(overlay, bases), /absent from base/);
});

test('resolveLock: pins every region, sorted, repo scoped', () => {
  const a = { id: 'base', label: 'Default', apps: {} };
  const flat = { 'task.edit-file': 'github:ir/ef@main', 'panel.spaces': 'github:ir/sm@main' };
  const lock = resolveLock(a, flat, stub);
  assert.deepEqual(Object.keys(lock.apps), ['panel.spaces', 'task.edit-file']); // sorted
  assert.deepEqual(lock.apps['panel.spaces'], { repo: 'github:ir/sm', ref: 'main', commit: SHA });
  assert.equal(lock.label, 'Default');
});

test('serializeLock is deterministic + buildIndex digest matches', () => {
  const a = { id: 'base', apps: {} };
  const lock = resolveLock(a, { 'panel.spaces': 'github:ir/sm@main' }, stub);
  const text1 = serializeLock(lock);
  const text2 = serializeLock(resolveLock(a, { 'panel.spaces': 'github:ir/sm@main' }, stub));
  assert.equal(text1, text2);
  assert.ok(text1.endsWith('\n'));
  const index = buildIndex([{ id: 'base', lockText: text1 }]);
  assert.equal(index.releases.base.sha256, sha256Hex(text1));
  assert.equal(index.releases.base.url, 'base.lock.json');
});

// --- command --check (the networkless CI path) ------------------------------

const writeFixture = (dir) => {
  const baseAuthoring = { id: 'base', label: 'Default', apps: { 'panel.spaces': 'github:ir/sm@main' } };
  writeFileSync(join(dir, 'base.json'), JSON.stringify(baseAuthoring, null, 2));
  const lock = resolveLock(baseAuthoring, baseAuthoring.apps, stub);
  const lockText = serializeLock(lock);
  writeFileSync(join(dir, 'base.lock.json'), lockText);
  writeFileSync(join(dir, 'index.json'), serializeIndex(buildIndex([{ id: 'base', lockText, label: 'Default' }])));
};

test('pin-release --check passes on consistent fixtures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --check fails on a tampered index digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: 1, releases: { base: { label: 'Default', url: 'base.lock.json', sha256: 'deadbeef' } } }, null, 2) + '\n',
    );
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --check fails when a lock is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    rmSync(join(dir, 'base.lock.json'));
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
