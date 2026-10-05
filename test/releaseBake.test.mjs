// Tests for the §5 5a registry zip bake (UI_RELEASES_SPEC §3.4, R3-637).
// Runs against the compiled dist/ (`npm test` builds first). No network: the
// materializer's remote is injected as a local `file://` bare-repo fixture —
// the same clone/fetch/checkout path, pointed at a fixture instead of GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { bakeSet, ensureZip, installDependencies, materializeCommit } from '../dist/commands/releaseBake.js';
import { bakeCommittedLocks, runPinRelease } from '../dist/commands/pinRelease.js';
import { buildIndex, resolveLock, serializeIndex, serializeLock } from '../dist/release.js';

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

// A registry zip must carry the same pre-bundled dependencies as the app repo's
// own `cache.yml` zip, or a cold boot on a pinned release fetches them live.
//
// Everything below is offline. The fixture app declares `tiny-dep@1.0.0` by
// version, and its lockfile resolves that to a tarball committed in the repo
// (`file:vendor/…`), so `npm ci` — the real one, as the bake runs it — installs
// it with no registry. The CDN root is a dead port, so whatever is bundled came
// from the installed tree and this CLI's own platform-provided tree.
const DEAD_CDN = 'http://127.0.0.1:9';
const hasNpm = hasBinary('npm');

/** A bare remote holding one commit of an app that depends on `tiny-dep`.
 *  `lock: 'good'` commits a lockfile npm can install offline, `'corrupt'` one it
 *  cannot parse, `'none'` no lockfile. `node_modules` is never committed. */
const makeAppRemote = (lock) => {
  const work = mkdtempSync(join(tmpdir(), 'ir-bake-deps-work-'));
  const bare = mkdtempSync(join(tmpdir(), 'ir-bake-deps-bare-'));
  const dep = mkdtempSync(join(tmpdir(), 'ir-bake-deps-dep-'));
  const g = (args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'index.tsx'), "import dep from 'tiny-dep';\nexport const x = dep;\n");
  const root = { name: 'app', version: '1.0.0', dependencies: { 'tiny-dep': '1.0.0' } };
  writeFileSync(join(work, 'package.json'), JSON.stringify(root));
  if (lock === 'good') {
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'tiny-dep', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(dep, 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(work, 'vendor'));
    execFileSync('npm', ['pack', '--silent', '--pack-destination', join(work, 'vendor')], { cwd: dep, stdio: 'pipe' });
    const tgz = readFileSync(join(work, 'vendor/tiny-dep-1.0.0.tgz'));
    writeFileSync(
      join(work, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': root,
          'node_modules/tiny-dep': {
            version: '1.0.0',
            resolved: 'file:vendor/tiny-dep-1.0.0.tgz',
            integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
          },
        },
      }),
    );
  } else if (lock === 'corrupt') {
    writeFileSync(join(work, 'package-lock.json'), '{ this is not a lockfile');
  }
  g(['add', '.']);
  g(['commit', '-q', '-m', 'app with a dependency']);
  const commit = g(['rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  rmSync(work, { recursive: true, force: true });
  rmSync(dep, { recursive: true, force: true });
  return { url: `file://${bare}`, bare, commit };
};

const bundledIn = (zip) =>
  execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.startsWith('.immediately.run/packages/') && !p.endsWith('/'));

const captureWarnings = (fn) => {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => seen.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
};

const testNpm = hasNpm ? test : test.skip;
const describeBakeNpm = hasNpm ? describeBake : test.skip;

testNpm('installDependencies: no lockfile is skipped, a lockfile is installed, a failed install warns with npm\'s reason', () => {
  const none = makeAppRemote('none');
  const good = makeAppRemote('good');
  const corrupt = makeAppRemote('corrupt');
  const checkouts = [];
  try {
    const at = (r) => {
      const c = materializeCommit('ir', 'app', r.commit, r.url);
      checkouts.push(c);
      return c;
    };
    const plain = at(none);
    assert.equal(installDependencies(plain), false);
    assert.equal(existsSync(join(plain, 'node_modules')), false, 'no lockfile: nothing is installed');

    const installable = at(good);
    assert.equal(installDependencies(installable), true);
    assert.equal(
      JSON.parse(readFileSync(join(installable, 'node_modules/tiny-dep/package.json'), 'utf8')).version,
      '1.0.0',
    );

    const broken = at(corrupt);
    let result;
    const warnings = captureWarnings(() => {
      result = installDependencies(broken);
    });
    assert.equal(result, false, 'a failed install is non-fatal');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /npm ci failed/);
    // npm's own words, not just the command line execFileSync puts in err.message.
    assert.match(warnings[0], /npm error|npm ERR!/);
  } finally {
    for (const d of [...checkouts, none.bare, good.bare, corrupt.bare]) rmSync(d, { recursive: true, force: true });
  }
});

describeBakeNpm('ensureZip installs the pin\'s dependencies and bundles them under .immediately.run/packages/', async () => {
  const { url, bare, commit } = makeAppRemote('good');
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-deps-registry-'));
  try {
    // The default path: `install` is left on, and nothing is installed in the remote.
    const r = await ensureZip(dir, { repo: 'github:ir/app', ref: 'main', commit }, { remoteUrl: url, cdnRoot: DEAD_CDN });
    const bundled = bundledIn(r.path);
    assert.ok(
      bundled.some((p) => p.includes('tiny-dep')),
      `the declared dependency is bundled; .immediately.run/packages/ holds: ${bundled.join(', ') || '(nothing)'}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

describeBake('ensureZip refuses to land a zip whose declared dependencies were not bundled', async () => {
  // No lockfile and no reachable CDN: nothing can supply `tiny-dep`. A resident zip is
  // reused for good, so landing this one would serve the thin zip on every later run.
  const { url, bare, commit } = makeAppRemote('none');
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-thin-registry-'));
  try {
    const entry = { repo: 'github:ir/app', ref: 'main', commit };
    await assert.rejects(
      ensureZip(dir, entry, { remoteUrl: url, cdnRoot: DEAD_CDN }),
      /declares 1 dependencies but none were bundled/,
    );
    const zipDir = join(dir, 'zips/ir/app');
    assert.deepEqual(existsSync(zipDir) ? readdirSync(zipDir) : [], [], 'neither the zip nor a staging file is left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// `--bake-only` lands the zips of pins that already exist. It is the one path that
// builds a zip without resolving a ref, so what it must not do matters as much as
// what it does: no lock and no index may change.
describeBake('bakeCommittedLocks bakes every committed lock\'s pins once, reuses resident zips, and writes nothing else', async () => {
  const { url, first, second, bare } = makeRemote();
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-only-registry-'));
  try {
    const lockOf = (id, apps) => serializeLock(resolveLock({ id, apps }, apps, (b) => b.commit));
    // Two locks: `base` pins the first commit in two regions, `next` pins both commits.
    const base = lockOf('base', { 'panel.a': `github:ir/app#${first}`, 'panel.b': `github:ir/app#${first}` });
    const next = lockOf('next', { 'panel.a': `github:ir/app#${first}`, 'panel.b': `github:ir/app#${second}` });
    writeFileSync(join(dir, 'base.lock.json'), base);
    writeFileSync(join(dir, 'next.lock.json'), next);
    const index = serializeIndex(buildIndex([{ id: 'base', lockText: base }, { id: 'next', lockText: next }]));
    writeFileSync(join(dir, 'index.json'), index);

    const bake = (d, entry) => ensureZip(d, entry, { remoteUrl: url, cdnRoot: DEAD_CDN });
    assert.deepEqual(await bakeCommittedLocks(dir, bake), { baked: 2, reused: 0 });
    assert.deepEqual(readdirSync(join(dir, 'zips/ir/app')).sort(), [`${first}.zip`, `${second}.zip`].sort());
    // A second run finds both resident.
    assert.deepEqual(await bakeCommittedLocks(dir, bake), { baked: 0, reused: 2 });
    // One deleted zip is the only one built again.
    rmSync(join(dir, 'zips/ir/app', `${second}.zip`));
    assert.deepEqual(await bakeCommittedLocks(dir, bake), { baked: 1, reused: 1 });

    assert.equal(readFileSync(join(dir, 'base.lock.json'), 'utf8'), base);
    assert.equal(readFileSync(join(dir, 'next.lock.json'), 'utf8'), next);
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), index);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('bakeCommittedLocks stops at the first pin that cannot be baked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-only-fail-'));
  try {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const apps = { 'panel.a': `github:ir/app#${a}`, 'panel.b': `github:ir/other#${b}` };
    writeFileSync(join(dir, 'base.lock.json'), serializeLock(resolveLock({ id: 'base', apps }, apps, (x) => x.commit)));
    const asked = [];
    await assert.rejects(
      bakeCommittedLocks(dir, async (_d, entry) => {
        asked.push(entry.commit);
        throw new Error(`cannot bake ${entry.commit}`);
      }),
      /cannot bake/,
    );
    assert.equal(asked.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-release --bake-only refuses the flags that contradict it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ir-bake-only-flags-'));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    for (const extra of [{ check: true }, { 'no-bake': true }, { dated: 'testing' }, { only: 'base' }, { channel: 'testing=base' }]) {
      const code = await runPinRelease({ positionals: [], flags: { dir, 'bake-only': true, ...extra } });
      assert.equal(code, 1, `--bake-only with ${Object.keys(extra)[0]} is refused`);
    }
    assert.equal(errors.length, 5);
    for (const e of errors) assert.match(e, /--bake-only cannot be combined with/);
  } finally {
    console.error = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
