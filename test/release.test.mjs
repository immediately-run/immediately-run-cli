// Tests for UI release authoring/resolution (UI_RELEASES_SPEC §5).
// Runs against compiled dist/ (`npm test` builds first). No network: the pure
// path uses a stub resolver, and the command's --check mode is networkless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
  substituteDatedTargets,
  validateChannels,
} from '../dist/release.js';
import { runPinRelease } from '../dist/commands/pinRelease.js';
import { parseArgs } from '../dist/args.js';

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

test('substituteDatedTargets resolves the @dated self-reference; other targets pass through', () => {
  const out = substituteDatedTargets({ testing: '@dated', stable: 'stable-2026-09' }, 'testing-2026-09-16-d6fe99a4');
  assert.deepEqual(out, { testing: 'testing-2026-09-16-d6fe99a4', stable: 'stable-2026-09' });
});

test('pin-release --check: a channel-template authoring needs no plain lock (the name is the channel\'s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writeFixture(dir);
    // A dated target + the channel template that produced it (no plain lock).
    const target = datedLockName('testing', serializeLock(resolveLock({ id: 'testing', apps: {} }, {}, stub)), new Date('2026-09-16T00:00:00Z'));
    const targetText = serializeLock(resolveLock({ id: 'testing', label: 'Testing', apps: { 'panel.spaces': 'github:ir/sm@main' } }, { 'panel.spaces': 'github:ir/sm@main' }, stub));
    writeFileSync(join(dir, 'testing.json'), JSON.stringify({ id: 'testing', label: 'Latest of origin/main', extends: 'base', channel: true, apps: {} }, null, 2));
    writeFileSync(join(dir, `${target}.lock.json`), targetText);
    writeFileSync(
      join(dir, 'index.json'),
      serializeIndex(buildIndex([
        { id: 'base', lockText: readFileSync(join(dir, 'base.lock.json'), 'utf8'), label: 'Default' },
        { id: target, lockText: targetText, label: 'Testing' },
      ], { testing: target })),
    );
    const code = await runPinRelease({ positionals: [], flags: { dir, check: true } });
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- write mode, offline (commit-pinned authoring short-circuits the resolver;

// --no-bake skips the bake) — the round-1 review's R2 finding ---------------

const PIN_A = 'c'.repeat(40);
const PIN_B = 'd'.repeat(40);

/** A registry fixture whose authoring is COMMITT-PINNED (no network anywhere):
 * base.json at PIN_A + its committed lock + index + derived map. */
const writePinnedFixture = (dir) => {
  const baseAuthoring = { id: 'base', label: 'Default', apps: { 'panel.spaces': `github:ir/sm#${PIN_A}` } };
  writeFileSync(join(dir, 'base.json'), JSON.stringify(baseAuthoring, null, 2));
  // The committed lock must match what write mode derives from the PINNED
  // authoring (the pin itself — the same short-circuit the default resolver
  // applies), or the immutability guard refuses the no-op republish.
  const pinResolver = (b) => b.commit ?? stub(b);
  const lockText = serializeLock(resolveLock(baseAuthoring, baseAuthoring.apps, pinResolver));
  writeFileSync(join(dir, 'base.lock.json'), lockText);
  writeFileSync(join(dir, 'index.json'), serializeIndex(buildIndex([{ id: 'base', lockText, label: 'Default' }])));
  writeFileSync(join(dir, 'defaults-map.json'), JSON.stringify(baseAuthoring.apps, null, 2) + '\n');
  return { baseAuthoring, lockText };
};

test('write mode: --channel repoints ONLY the channel map (the index otherwise byte-identical)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    const before = readFileSync(join(dir, 'index.json'), 'utf8');
    const beforeLock = readFileSync(join(dir, 'base.lock.json'), 'utf8');
    const code = await runPinRelease({ positionals: [], flags: { dir, 'no-bake': true, channel: 'testing=base' } });
    assert.equal(code, 0);
    const after = readFileSync(join(dir, 'index.json'), 'utf8');
    // The lock is untouched (same content, immutable) and the index differs ONLY
    // by the channels block.
    assert.equal(readFileSync(join(dir, 'base.lock.json'), 'utf8'), beforeLock);
    assert.deepEqual(JSON.parse(after).channels, { testing: 'base' });
    assert.deepEqual(JSON.parse(after).releases, JSON.parse(before).releases);
    // And --check agrees the result is consistent.
    assert.equal(await runPinRelease({ positionals: [], flags: { dir, check: true } }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode: --dated + --channel testing=@dated publishes the dated lock and repoints at it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    writeFileSync(
      join(dir, 'testing.json'),
      JSON.stringify({ id: 'testing', label: 'Latest of origin/main', extends: 'base', channel: true, apps: {} }, null, 2),
    );
    const code = await runPinRelease({
      positionals: [],
      flags: { dir, 'no-bake': true, only: 'testing', dated: 'testing', channel: 'testing=@dated' },
    });
    assert.equal(code, 0);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    const target = index.channels.testing;
    assert.match(target, /^testing-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    // The dated lock exists; the plain name does NOT (the dual-name rule).
    assert.ok(existsSync(join(dir, `${target}.lock.json`)), 'dated lock written');
    assert.ok(!existsSync(join(dir, 'testing.lock.json')), 'no plain lock for a channel template');
    // The channel target is a published release in the same index.
    assert.ok(index.releases[target], 'target indexed');
    assert.equal(await runPinRelease({ positionals: [], flags: { dir, check: true } }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode: --only freezes every other lock (a channel run can never republish base)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    const { baseAuthoring } = writePinnedFixture(dir);
    // The committed base lock is at PIN_B — the AUTHORING would resolve to
    // PIN_A. A testing run must leave the committed bytes untouched.
    const driftedAuthoring = { id: 'base', label: 'Default', apps: { 'panel.spaces': `github:ir/sm#${PIN_B}` } };
    const pinResolver = (b) => b.commit ?? stub(b);
    const committedLockText = serializeLock(resolveLock(driftedAuthoring, driftedAuthoring.apps, pinResolver));
    writeFileSync(join(dir, 'base.lock.json'), committedLockText);
    writeFileSync(join(dir, 'testing.json'), JSON.stringify({ id: 'testing', extends: 'base', channel: true, apps: {} }, null, 2));
    const code = await runPinRelease({
      positionals: [],
      flags: { dir, 'no-bake': true, only: 'testing', dated: 'testing' },
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, 'base.lock.json'), 'utf8'), committedLockText);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(index.releases.base.sha256, sha256Hex(committedLockText), 'the COMMITTED lock is the indexed one');
    // The unpinned-authoring id is still on disk for the next deliberate run.
    assert.ok(existsSync(join(dir, 'base.json')));
    void baseAuthoring;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode: a channel template without --dated is refused (the dual-name rule)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    writeFileSync(join(dir, 'testing.json'), JSON.stringify({ id: 'testing', extends: 'base', channel: true, apps: {} }, null, 2));
    const code = await runPinRelease({ positionals: [], flags: { dir, 'no-bake': true } });
    assert.equal(code, 1);
    assert.ok(!existsSync(join(dir, 'testing.lock.json')), 'no plain lock written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode: a corrupt index.json ABORTS instead of wiping the committed channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    writeFileSync(join(dir, 'index.json'), '{not json');
    await assert.rejects(
      runPinRelease({ positionals: [], flags: { dir, 'no-bake': true } }),
      /index.json is not valid JSON.*channel map/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode: a bare value-bearing flag is refused, not silently disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    const code = await runPinRelease({ positionals: [], flags: { dir, 'no-bake': true, channel: true } });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt historical lock aborts NAMING the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-release-'));
  try {
    writePinnedFixture(dir);
    writeFileSync(join(dir, 'ghost-2026-09-16-aaaaaaaa.lock.json'), '{oops');
    await assert.rejects(
      runPinRelease({ positionals: [], flags: { dir, check: true } }),
      /ghost-2026-09-16-aaaaaaaa\.lock\.json: not valid JSON/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round-2 review: the parse-level guarantee behind every write-mode test's
// injected 'no-bake': true — the flag is REGISTERED as boolean, so a real
// `--no-bake <token>` invocation cannot consume the token (the round-1 bug).
test('parseArgs: --no-bake is a registered boolean flag (a following token stays a positional)', () => {
  const parsed = parseArgs(['--no-bake', 'releases']);
  assert.equal(parsed.flags['no-bake'], true);
  assert.deepEqual(parsed.positionals, ['releases']);
});
