// The platform-provided second resolution root (R3-567).
//
// THE CASE THAT MATTERS IS THE HOISTED ONE. The first cut of this module walked up from its
// own directory with the package root as the floor, and resolved nothing whenever the CLI
// was INSTALLED rather than run from a checkout — because npm hoists a package's
// dependencies to the installing root, one level above that floor. Every test passed and so
// did a live browser acceptance, because both ran the dev checkout, where `node_modules`
// really is inside the package. Review caught it with `npm pack` + a clean install.
//
// So the resolver is injected, and the layouts are built explicitly rather than inherited
// from whatever this repo's own tree happens to look like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownPackageDir, platformProvidedNames, resolvePlatformProvided } from '../dist/platformProvided.js';

/** A resolver over an explicit path→manifest map, standing in for node's own. */
const resolverOver = (files) => (specifier) => {
  if (!(specifier in files)) throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });
  return files[specifier];
};

/** Write `<root>/<dir>/package.json` and return the manifest path, as a resolver would. */
const writePkg = (root, dir, manifest) => {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  const path = join(full, 'package.json');
  writeFileSync(path, JSON.stringify(manifest));
  return path;
};

test('platformProvidedNames is a DIFFERENCE, so a newly injected name appears without an edit', () => {
  const root = { react: '^19.0.0' };
  const augmented = { react: '^19.0.0', 'core-js': '3.22.7', 'react-refresh': '^0.11.0' };
  assert.deepEqual(platformProvidedNames(root, augmented), ['core-js', 'react-refresh']);
  // A fourth needs no code change here — only a dependency, which check-platform-provided
  // is what enforces.
  assert.deepEqual(platformProvidedNames(root, { ...augmented, 'brand-new': '^1.0.0' }), [
    'brand-new',
    'core-js',
    'react-refresh',
  ]);
});

test('a name the APP declares is never platform-provided — that would be a silent substitution', () => {
  // The narrowness IS the safety property. An app's own `react` answered by the CLI's copy
  // is the failure review round 1 flagged one level up, and it would be worse here because
  // the versions could differ while the lockset still echo-matched.
  const augmented = { react: '^19.0.0', 'core-js': '3.22.7' };
  assert.deepEqual(platformProvidedNames({ react: '^19.0.0', 'core-js': '3.22.7' }, augmented), []);
  assert.ok(!platformProvidedNames({ react: '^19.0.0' }, augmented).includes('react'));
});

test('resolution works in the HOISTED layout — the one the walk-based version silently failed in', () => {
  // `npm i @immediately-run/cli` puts the CLI at <root>/node_modules/@immediately-run/cli
  // and its dependencies at <root>/node_modules/*, ABOVE the CLI's own directory. A walk
  // floored at the CLI's package root returns nothing here; node's resolution does not.
  const root = mkdtempSync(join(tmpdir(), 'ir-hoisted-'));
  try {
    const files = {
      'core-js/package.json': writePkg(root, 'node_modules/core-js', { name: 'core-js', version: '3.22.7' }),
      'react-refresh/package.json': writePkg(root, 'node_modules/react-refresh', {
        name: 'react-refresh',
        version: '0.11.0',
      }),
    };
    // Nothing lives under the CLI's own directory, which is the whole point.
    mkdirSync(join(root, 'node_modules/@immediately-run/cli'), { recursive: true });

    const resolved = resolvePlatformProvided(
      ['core-js', 'react-refresh'],
      { 'core-js': '3.22.7', 'react-refresh': '^0.11.0' },
      resolverOver(files),
    );
    assert.deepEqual(resolved, [
      { n: 'core-js', v: '3.22.7', d: 0 },
      { n: 'react-refresh', v: '0.11.0', d: 0 },
    ]);
    assert.equal(ownPackageDir('core-js', resolverOver(files)), join(root, 'node_modules/core-js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a version outside the range the transpiler asked for is OMITTED, never substituted', () => {
  // Omitting sends the name to the CDN — the pre-existing behaviour. Substituting would put
  // a version mismatch in the lockset that the runtime cannot catch, because the echo it
  // matches on is the RANGE map, which still matches.
  const root = mkdtempSync(join(tmpdir(), 'ir-badver-'));
  try {
    const files = {
      'core-js/package.json': writePkg(root, 'node_modules/core-js', { name: 'core-js', version: '3.23.0' }),
    };
    assert.deepEqual(resolvePlatformProvided(['core-js'], { 'core-js': '3.22.7' }, resolverOver(files)), []);
    // …and the same tree at the asked-for version does resolve, so the case is not vacuous.
    const ok = { 'core-js/package.json': writePkg(root, 'ok/node_modules/core-js', { name: 'core-js', version: '3.22.7' }) };
    assert.deepEqual(resolvePlatformProvided(['core-js'], { 'core-js': '3.22.7' }, resolverOver(ok)), [
      { n: 'core-js', v: '3.22.7', d: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unresolvable name is skipped rather than thrown, so the CDN still gets its chance', () => {
  assert.deepEqual(resolvePlatformProvided(['nope'], { nope: '^1.0.0' }, resolverOver({})), []);
  assert.equal(ownPackageDir('nope', resolverOver({})), null);
});

test('every entry is depth 0 — a platform package\'s own deps never enter an app\'s lockset', () => {
  // Bounded by construction rather than by a walk limit: this source resolves the NAMES it
  // is given and nothing they depend on. Were it a closure walk, a shared transitive
  // dependency of ours could be reported at a version the app never asked for.
  const root = mkdtempSync(join(tmpdir(), 'ir-depth-'));
  try {
    const files = {
      'plat/package.json': writePkg(root, 'node_modules/plat', {
        name: 'plat',
        version: '1.0.0',
        dependencies: { shared: '^1.0.0' },
      }),
      'shared/package.json': writePkg(root, 'node_modules/shared', { name: 'shared', version: '1.0.0-CLI-COPY' }),
    };
    const resolved = resolvePlatformProvided(['plat'], { plat: '^1.0.0' }, resolverOver(files));
    assert.deepEqual(resolved, [{ n: 'plat', v: '1.0.0', d: 0 }]);
    assert.ok(!resolved.some((r) => r.n === 'shared'), "a platform package's dependency must not come with it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real tree answers for every name the real transpiler injects', async () => {
  // The integration half: no stub resolver, no fixture — the actual dependencies this
  // package declares, resolved the way the CLI will resolve them at run time. If this repo's
  // install and the transpiler's injected set ever disagree, this fails here rather than in
  // someone's cache build.
  const { computeInputDepMap, rootRuntimeDependencies } = await import('@immediately-run/transpiler');
  const own = rootRuntimeDependencies({ dependencies: { react: '^19.0.0' } });
  const augmented = computeInputDepMap(own, new Set());
  const names = platformProvidedNames(own, augmented);

  assert.ok(names.length > 0, 'the transpiler must inject something, or every case above is over an empty set');
  const resolved = resolvePlatformProvided(names, augmented);
  assert.deepEqual(
    resolved.map((r) => r.n),
    names,
    `every injected name must resolve from this package's own tree — missing: ${names.filter((n) => !resolved.some((r) => r.n === n)).join(', ')}`,
  );
  for (const name of names) assert.ok(ownPackageDir(name), `${name} must have a readable directory for --bundle-packages`);
});
