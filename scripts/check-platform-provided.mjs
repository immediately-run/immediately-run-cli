#!/usr/bin/env node
/**
 * Fail this repo's `verify` if `@immediately-run/transpiler` injects a runtime dependency
 * this package does not carry — see `src/platformProvided.ts` for why it carries any.
 *
 * The failure this prevents is quiet: a fourth injected name would simply be absent from
 * every lockset built without a reachable CDN, the runtime's echo-match would reject the
 * lockset WHOLE, and every app would go back to resolving live — with a green cache build
 * and a cheerful "all from node_modules" summary. Nothing else in the suite can see it,
 * because the transpiler's injected set is not an input any test controls.
 *
 * `--self-test` proves the check itself fails when it should.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { computeInputDepMap, rootRuntimeDependencies } = require('@immediately-run/transpiler');

// The SAME `satisfies` the resolution uses — imported, never re-implemented. A private copy
// here disagreed with `src/localPackageSource.ts` on `^0.x` (npm pins the minor when the
// major is 0), so this script passed a range the resolver would have failed. One rule, one
// home (ways_of_working §6).
const { satisfies } = await import(pathToFileURL(join(root, 'dist/localPackageSource.js')).href);

/** The names the transpiler adds on top of an app's own manifest, for a given root. */
function injected(rootPkg) {
  const own = rootRuntimeDependencies(rootPkg);
  const augmented = computeInputDepMap(own, new Set());
  return Object.entries(augmented).filter(([name]) => own[name] === undefined);
}

function check(declared, entries, resolve) {
  const problems = [];
  for (const [name, range] of entries) {
    const have = declared[name];
    if (have === undefined) {
      problems.push(
        `${name}@${range} is injected by @immediately-run/transpiler but is not a dependency of this package.\n` +
          `    Every lockset built without a reachable CDN would omit it, the runtime would reject the\n` +
          `    lockset whole (R3-289 echo-match), and cache-zip would still report success.\n` +
          `    Fix: npm pkg set dependencies.${name}='${range}' && npm install`,
      );
      continue;
    }
    const installed = resolve(name);
    if (installed === null) {
      problems.push(`${name} is declared but not installed — run npm install`);
    } else if (!satisfies(installed, range)) {
      problems.push(`${name}: the transpiler asks for ${range}, this package has ${installed} installed`);
    }
  }
  return problems;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['a carried, satisfying dependency passes', { 'core-js': '3.22.7' }, [['core-js', '3.22.7']], () => '3.22.7', 0],
    ['a newly injected name fails', {}, [['brand-new', '^1.0.0']], () => null, 1],
    ['…and names the npm command that fixes it', {}, [['brand-new', '^1.0.0']], () => null, /npm pkg set dependencies\.brand-new/],
    ['a declared-but-uninstalled dependency fails', { x: '^1.0.0' }, [['x', '^1.0.0']], () => null, 1],
    ['an installed version outside the range fails', { x: '^1.0.0' }, [['x', '^1.0.0']], () => '0.9.0', 1],
    ['an EXACT pin the tree drifted off fails', { 'core-js': '3.22.7' }, [['core-js', '3.22.7']], () => '3.23.0', 1],
    ['a range the checker cannot parse does not invent a failure', { x: 'github:a/b' }, [['x', 'github:a/b']], () => '1.0.0', 0],
    ['an empty injected set passes', {}, [], () => null, 0],
  ];
  let failed = 0;
  for (const [label, declared, entries, resolve, expect] of cases) {
    const out = check(declared, entries, resolve);
    const ok = typeof expect === 'number' ? out.length === expect : expect.test(out.join('\n'));
    console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }
  // Non-vacuity for the real path: the live transpiler must actually inject something, or
  // every assertion above is over an empty set.
  const live = injected({ dependencies: { react: '^19.0.0' } });
  if (live.length === 0) {
    console.log('  FAIL  the live transpiler injects nothing — this check would be vacuous');
    failed++;
  } else {
    console.log(`  ok   the live transpiler injects ${live.length} name(s): ${live.map(([n]) => n).join(', ')}`);
  }
  console.log(`${cases.length + 1 - failed}/${cases.length + 1} self-test cases.`);
  process.exit(failed ? 1 : 0);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = injected({ dependencies: { react: '^19.0.0' } });
const problems = check(pkg.dependencies ?? {}, entries, (name) => {
  try {
    return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version ?? null;
  } catch {
    return null;
  }
});

if (problems.length) {
  console.error('The transpiler injects runtime dependencies this package does not provide:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: all ${entries.length} platform-injected dependenc(ies) are carried here: ${entries.map(([n, r]) => `${n}@${r}`).join(', ')}`);

// R3-1337 — the helpers the CDN's transpiler injects. cache-zip bundles each from THIS tree,
// so each must be a declared dependency here, at an EXACT version; and that version is the
// sandbox's own pin when a sibling sandbox checkout is present (CI checks this repo out alone,
// so the comparison then skips, loudly). One list, one home: src/platformProvided.ts.
const { CDN_INJECTED_HELPERS } = await import(pathToFileURL(join(root, 'dist/platformProvided.js')).href);
const helperProblems = [];
let sandboxPkg = null;
try {
  sandboxPkg = JSON.parse(readFileSync(join(root, '..', 'sandbox', 'package.json'), 'utf8'));
} catch {
  console.log('  skip: no sibling ../sandbox checkout, so the helper pins are not compared with the sandbox\'s');
}
for (const name of CDN_INJECTED_HELPERS) {
  const have = (pkg.dependencies ?? {})[name];
  if (have === undefined) helperProblems.push(`${name} is a CDN-injected helper but not a dependency of this package`);
  else if (!/^\d+\.\d+\.\d+$/.test(have)) helperProblems.push(`${name} must be pinned exactly, got ${have}`);
  const theirs = sandboxPkg ? { ...sandboxPkg.devDependencies, ...sandboxPkg.dependencies }[name] : undefined;
  if (sandboxPkg && theirs !== undefined && theirs !== have) {
    helperProblems.push(`${name}@${have} here, but the sandbox pins ${theirs}`);
  }
}
if (helperProblems.length) {
  console.error('CDN-injected helpers are not carried correctly:\n');
  for (const p of helperProblems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: the CDN-injected helper(s) are carried at exact versions: ${CDN_INJECTED_HELPERS.map((n) => `${n}@${pkg.dependencies[n]}`).join(', ')}`);
