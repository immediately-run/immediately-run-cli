// Tests for the §5 5a registry zip bake (UI_RELEASES_SPEC §3.4, R3-637).
// Runs against the compiled dist/ (`npm test` builds first). No network: the
// materializer's remote is injected as a local `file://` bare-repo fixture —
// the same clone/fetch/checkout path, pointed at a fixture instead of GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { bakeSet, ensureZip, materializeCommit } from '../dist/commands/releaseBake.js';

// The bake leg shells out to `git` AND `zip` (the CLI's documented runner
// dependencies — cacheZipBase.test.mjs has the same requirement). A machine
// without them skips the BUILD + sidecar legs loudly; the reuse/dedup/
// materialize legs (git-only) always run. Presence is probed with
// `command -v` (PATH lookup) — NOT a `--version` invocation: Info-ZIP's zip
// and unzip answer `-v`, not `--version`, so a version probe misjudges the CI
// runners' own binaries as absent and the gated legs skip EVERYWHERE (the
// round-3 review's finding — a skip-green CI).
const hasBinary = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
const describeBake = hasBinary('zip') && hasBinary('unzip') ? test : test.skip;
if (describeBake === test.skip) {
  console.warn('SKIP (no zip/unzip on this machine): the releaseBake BUILD + sidecar legs need them (CI runners have both)');
}

const makeRemote = () => {
  const work = mkdtempSync(join(tmpdir(), 'ir-bake-work-'));
  const bare = mkdtempSync(join(tmpdir(), 'ir-bake-bare-'));
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'index.tsx'), 'export const x = 1;\n');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'app' }));
  g(['add', '.']);
  g(['commit', '-q', '-m', 'first']);
  const FIRST = g(['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(join(work, 'index.tsx'), 'export const x = 2;\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'second']);
  const SECOND = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', work, 'branch', '-M', 'main']);
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  rmSync(work, { recursive: true, force: true });
  return { url: `file://${bare}`, bare, first: FIRST, second: SECOND };
};

const sidecarOf = (zip) =>
  JSON.parse(execFileSync('unzip', ['-p', zip, '.immediately.run/contribute-manifest.json'], { encoding: 'utf8' }));

test('materializeCommit checks out EXACTLY the pin (HEAD === commit)', () => {
  const { url, first, bare } = makeRemote();
  try {
    const checkout = materializeCommit('ir', 'app', first, url);
    try {
      const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD']).toString().trim();
      assert.equal(head, first);
      // The tree is the PIN's tree, not the branch head's.
      const x = execFileSync('git', ['-C', checkout, 'show', 'HEAD:index.tsx'], { encoding: 'utf8' });
      assert.match(x, /x = 1/);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

describeBake('ensureZip bakes at the pin with the §6.4 sidecar coordinate, and reuses a resident zip', async () => {
  const { url, first, bare } = makeRemote();
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-registry-'));
  try {
    const entry = { repo: 'github:ir/app', ref: 'main', commit: first };
    const r1 = await ensureZip(dir, entry, { remoteUrl: url });
    assert.equal(r1.reused, false);
    assert.ok(existsSync(r1.path), 'zip written at zips/<ns>/<repo>/<sha>.zip');
    // §6.4: the sidecar names the PIN as both ref and based-on commit — the
    // coordinate a host's commit-pinned mount matches.
    const sidecar = sidecarOf(r1.path);
    assert.equal(sidecar.ref, first);
    assert.equal(sidecar.commitSha, first);
    assert.equal(sidecar.refKind, 'commit');
    assert.equal(sidecar.namespace, 'ir');
    assert.equal(sidecar.repository, 'app');
    // §3.4 immutability: a resident zip is REUSED, never rebuilt.
    const before = statSync(r1.path).mtimeMs;
    const r2 = await ensureZip(dir, entry, { remoteUrl: url });
    assert.equal(r2.reused, true);
    assert.equal(statSync(r2.path).mtimeMs, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('bakeSet dedups one-repo-many-bindings (UI_AS_APPS §4) per (repo, commit)', () => {
  const SHA = 'a'.repeat(40);
  const entries = bakeSet([
    {
      apps: {
        'panel.spaces': { repo: 'github:ir/sm', ref: 'main', commit: SHA },
        'page.spaces': { repo: 'github:ir/sm', ref: 'main', commit: SHA },
        'panel.files': { repo: 'github:ir/fe', ref: 'main', commit: 'b'.repeat(40) },
      },
    },
    { apps: { 'panel.spaces': { repo: 'github:ir/sm', ref: 'main', commit: SHA } } },
  ]);
  assert.equal(entries.length, 2);
});

test('ensureZip ABORTS on a corrupt resident zip (an interrupted bake must never be reused)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-corrupt-'));
  try {
    const entry = { repo: 'github:ir/app', ref: 'main', commit: 'e'.repeat(40) };
    const path = join(dir, 'zips', 'ir', 'app', `${entry.commit}.zip`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not a zip at all — an interrupted bake left this');
    await assert.rejects(ensureZip(dir, entry), /fails the zip magic check.*aborting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The sidecar-leg error cases of validateResidentZip (round-2 review): real
// zips built with the `zip` binary (the cacheZipBase convention — the same
// runner dependency the BUILD leg already gates on), each failing one named
// leg. These also need `unzip` for the sidecar read, so they live in the
// describeBake guard.
import { validateResidentZip } from '../dist/commands/releaseBake.js';

const PIN = 'e'.repeat(40);
const zipFromEntries = (entries) => {
  // entries: [['path', Buffer|string], …] — built with the `zip` binary (the
  // cacheZipBase convention; same runner dependency the gate checks).
  const work = mkdtempSync(join(tmpdir(), 'ir-bake-fixture-'));
  const out = join(work, 'fixture.zip');
  try {
    const names = [];
    for (const [name, content] of entries) {
      const target = join(work, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      names.push(name);
    }
    execFileSync('zip', ['-q', '-X', out, ...names], { cwd: work });
    return readFileSync(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
const sidecarZip = (manifest) =>
  zipFromEntries([
    ['package.json', JSON.stringify({ name: 'app' })],
    ...(manifest !== null
      ? [['.immediately.run/contribute-manifest.json', JSON.stringify(manifest)]]
      : []),
  ]);
const sidecarZipRaw = (sidecarBytes) =>
  zipFromEntries([
    ['package.json', JSON.stringify({ name: 'app' })],
    ['.immediately.run/contribute-manifest.json', sidecarBytes],
  ]);

describeBake('validateResidentZip: each sidecar failure leg aborts with its named reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-legs-'));
  try {
    const entry = { repo: 'github:ir/app', ref: 'main', commit: PIN };
    const at = (bytes) => {
      const path = join(dir, 'zips', 'ir', 'app', `${PIN}.zip`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return path;
    };
    // A valid zip whose sidecar names a DIFFERENT based-on commit than the
    // pin → the §6.4 coordinate mismatch (the forged-registry shape). The
    // validator is synchronous — it THROWS.
    assert.throws(
      () => validateResidentZip(at(sidecarZip({ ref: PIN, commitSha: 'f'.repeat(40), namespace: 'ir', repository: 'app' })), entry),
      /does not name the pin/,
    );
    // A valid zip with NO sidecar entry.
    assert.throws(() => validateResidentZip(at(sidecarZip(null)), entry), /no readable sidecar/);
    // A valid zip whose sidecar is not JSON.
    assert.throws(
      () =>
        validateResidentZip(
          at(
            sidecarZipRaw(Buffer.from('not json', 'utf8')),
          ),
          entry,
        ),
      /unparseable sidecar/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
