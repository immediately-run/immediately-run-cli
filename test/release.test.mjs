// Tests for UI release authoring/resolution (UI_RELEASES_SPEC §5).
// Runs against compiled dist/ (`npm test` builds first). No network: the pure
// path uses a stub resolver, and the command's --check mode is networkless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  firstPartyStripWarnings,
  datedLockName,
  validateChannels,
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

// §5 step-3a lint (UI_RELEASES_SPEC §6.1b). The shipped first-party-only set is
// empty (R3-33d), so the manifest is injected here to exercise the lint.
test('firstPartyStripWarnings warns when a repoint strips first-party-only caps', () => {
  const flattened = {
    'monaco-2026-06': {
      'task.edit-file': 'github:fork/elsewhere@main', // repoint OFF the build default
      'panel.files': 'github:immediately-run/file-explorer@v2', // same scope, commit pin
    },
  };
  const buildDefaults = {
    'task.edit-file': { repo: 'github:immediately-run/editor', firstPartyOnlyCaps: ['editor:write'] },
    'panel.files': { repo: 'github:immediately-run/file-explorer', firstPartyOnlyCaps: ['x:fp'] },
  };
  const warnings = firstPartyStripWarnings(flattened, buildDefaults);
  // Only the repoint OFF the build-default scope warns; the same-scope commit pin does not.
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], {
    release: 'monaco-2026-06',
    region: 'task.edit-file',
    strippedCaps: ['editor:write'],
    fromRepo: 'github:immediately-run/editor',
    toRepo: 'github:fork/elsewhere',
  });
});

test('firstPartyStripWarnings is vacuous with the empty (shipped) manifest', () => {
  const flattened = { r: { 'task.edit-file': 'github:fork/x@main' } };
  assert.deepEqual(firstPartyStripWarnings(flattened, {}), []);
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
  // The §3.1 derived map the coverage assertion reads (matches the fixture's regions).
  writeFileSync(join(dir, 'defaults-map.json'), JSON.stringify(baseAuthoring.apps, null, 2) + '\n');
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

// --- §4.4 channels + §5 5a/7a (R3-637) --------------------------------------

test('buildIndex carries the channel map through; serializeIndex round-trips it', () => {
  const a = { id: 'base', label: 'Default', apps: { 'panel.spaces': 'github:ir/sm@main' } };
  const lockText = serializeLock(resolveLock(a, a.apps, stub));
  const index = buildIndex([{ id: 'base', lockText, label: 'Default' }], { testing: 'base' });
  assert.deepEqual(index.channels, { testing: 'base' });
  const parsed = JSON.parse(serializeIndex(index));
  assert.deepEqual(parsed.channels, { testing: 'base' });
  // An empty map is omitted (schema-stable for registries without channels).
  assert.equal('channels' in buildIndex([{ id: 'base', lockText }]), false);
});

test('validateChannels: dual names and unpublished targets are refused (naming both ids)', () => {
  validateChannels({ testing: 'base' }, new Set(['base']));
  assert.throws(() => validateChannels({ base: 'base' }, new Set(['base'])), /also a published release/);
  assert.throws(() => validateChannels({ testing: 'nope' }, new Set(['base'])), /not a published release/);
});

test('datedLockName is deterministic per composition+day and moves with either', () => {
  const text = serializeLock(resolveLock({ id: 'testing', apps: {} }, {}, stub));
  const d1 = new Date('2026-09-16T10:00:00Z');
  const d1b = new Date('2026-09-16T23:00:00Z');
  const d2 = new Date('2026-09-17T00:30:00Z');
  assert.equal(datedLockName('testing', text, d1), datedLockName('testing', text, d1b));
  assert.match(datedLockName('testing', text, d1), /^testing-2026-09-16-[0-9a-f]{8}$/);
  assert.notEqual(datedLockName('testing', text, d1), datedLockName('testing', text, d2));
  // A changed composition (different lock text) → a different name, same day.
  const text2 = serializeLock(resolveLock({ id: 'testing', apps: { 'panel.spaces': 'github:ir/sm@main' } }, { 'panel.spaces': 'github:ir/sm@main' }, stub));
  assert.notEqual(datedLockName('testing', text, d1), datedLockName('testing', text2, d1));
});

test('pin-release --check keeps historical (authoring-less) locks and validates channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    // A dated channel target whose authoring is GONE (the workflow's ephemeral
    // template) + the channel pointing at it.
    const target = datedLockName('testing', serializeLock(resolveLock({ id: 'testing', apps: {} }, {}, stub)), new Date('2026-09-16T00:00:00Z'));
    const targetText = serializeLock(resolveLock({ id: 'testing', label: 'Testing', apps: { 'panel.spaces': 'github:ir/sm@main' } }, { 'panel.spaces': 'github:ir/sm@main' }, stub));
    writeFileSync(join(dir, `${target}.lock.json`), targetText);
    writeFileSync(
      join(dir, 'index.json'),
      serializeIndex(buildIndex([
        { id: 'base', lockText: readFileSync(join(dir, 'base.lock.json'), 'utf8'), label: 'Default' },
        { id: target, lockText: targetText, label: 'Testing' },
      ], { testing: target })),
    );
    // base.lock.json's text via the fixture: re-read (written above by writeFixture).
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 0);
    // Dropping the historical lock from the index strands the channel target → fail.
    writeFileSync(
      join(dir, 'index.json'),
      serializeIndex(buildIndex([{ id: 'base', lockText: readFileSync(join(dir, 'base.lock.json'), 'utf8'), label: 'Default' }], { testing: target })),
    );
    const code2 = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code2, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --check fails when a channel targets an unpublished release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    writeFileSync(
      join(dir, 'index.json'),
      serializeIndex(buildIndex([{ id: 'base', lockText: readFileSync(join(dir, 'base.lock.json'), 'utf8'), label: 'Default' }], { testing: 'ghost' })),
    );
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --check coverage: a derived-map region the base lock omits is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    // site-main gained a region; the export map names it; the base lock does not.
    writeFileSync(join(dir, 'defaults-map.json'), JSON.stringify({
      'panel.spaces': 'github:ir/sm@main',
      'panel.brandnew': 'github:ir/new-app@main',
    }, null, 2) + '\n');
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --check fails loudly when the derived map is missing (anti-drift input)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    rmSync(join(dir, 'defaults-map.json'));
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
