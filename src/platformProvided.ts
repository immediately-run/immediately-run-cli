/**
 * The dependencies the PLATFORM injects, which no app declares — and which this package
 * therefore carries so that a cache build never has to ask the dependency CDN for them.
 *
 * ## Why this file exists
 *
 * `computeInputDepMap` (`@immediately-run/transpiler`) does not return the app's
 * dependencies. It returns the app's dependencies PLUS the ones the sandbox runtime needs
 * to evaluate the transpiled output — today `react-refresh` (the HMR wrapper the Babel
 * preset injects), `core-js` (the polyfill it targets) and `react-error-boundary`. The
 * runtime's lockset echo-match (R3-289) is over that augmented map, so a lockset that omits
 * them is not "slightly short", it is REJECTED WHOLE and the app resolves live.
 *
 * npm never installs them: the app does not declare them, because it does not know about
 * them — they are the platform's, not the app's. So `resolveFromInstalledTree(repo, …)`
 * could never satisfy them however good the resolution got, and R3-567's exit criterion 1
 * ("no network call to the dependency CDN when an installed tree is present") was
 * unreachable. That was a missing SOURCE, not an app-tree problem.
 *
 * This package already depends on the exact `@immediately-run/transpiler` build that does
 * the injecting, so declaring its injected set as our own dependencies makes the two move
 * together. `scripts/check-platform-provided.mjs` fails this repo's tests if the transpiler
 * ever injects a name we do not carry, or a range our installed copy does not satisfy.
 *
 * ## ⚠ Why this uses `require.resolve` and NOT a directory walk
 *
 * The first cut walked up from this module's directory with `ownPackageRoot()` as the floor,
 * by analogy with `resolveFromInstalledTree`'s repo-bounded walk. **It resolved nothing
 * whenever the CLI was installed rather than run from a checkout**, which is every real use:
 * npm HOISTS a package's dependencies to the installing root, so from
 * `<root>/node_modules/@immediately-run/cli` the copy sits at `<root>/node_modules/core-js`
 * — one level ABOVE the floor. The dev checkout, where `node_modules` really is inside the
 * package, was the only layout it worked in, so the whole feature was checkout-only while
 * every test and the live acceptance passed. Review caught it with `npm pack` + a clean
 * install; there is now a test that builds the hoisted layout.
 *
 * `require.resolve` from THIS module is node's own resolution and is hoist-correct by
 * construction. That is the opposite of the rule one level up in `resolvePackageDir`, which
 * deliberately avoids `require.resolve` — and correctly, because there the tree being
 * described is the TARGET REPO's, not ours. Here the tree being described IS ours.
 *
 * ## Why the second root stays narrow
 *
 * Resolving anything and everything from our tree would reopen review round 1's finding in a
 * worse form: an app's own `react` silently answered by the CLI's copy is a substitution
 * nobody would catch. So this is consulted only for names the augmented map ADDED — computed
 * by difference in `platformProvidedNames`, never listed — and only at depth 0, so a
 * platform package's own dependencies never enter an app's lockset from here either.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DepMap, ResolvedDependency } from './lockset.js';
import { satisfies } from './localPackageSource.js';

/**
 * The names present in the AUGMENTED map that the app's own manifest never mentioned.
 *
 * Derived by difference, never listed, so the day the transpiler injects a fourth this
 * returns four. `check-platform-provided.mjs` is what turns that into a red build rather
 * than a silent gap.
 */
export function platformProvidedNames(rootDeps: DepMap, augmented: DepMap): string[] {
  return Object.keys(augmented)
    .filter((name) => rootDeps[name] === undefined)
    .sort();
}

/** How a name is looked up in THIS package's tree. Injected so the hoisted layout — the one
 *  the walk-based version silently failed in — is reachable from a test. */
export type OwnResolver = (specifier: string) => string;

const ownRequire = createRequire(import.meta.url);
const defaultResolve: OwnResolver = (specifier) => ownRequire.resolve(specifier);

/**
 * The platform-injected dependencies, resolved from THIS package's own tree, at depth 0.
 *
 * A name whose installed copy does not satisfy the range the transpiler asked for is
 * OMITTED rather than substituted: a wrong version here would be a silent mismatch the
 * runtime cannot catch, because the echo it matches on is the range map, which still
 * matches. Omitting sends it to the CDN, which is the pre-existing behaviour.
 */
export function resolvePlatformProvided(
  names: readonly string[],
  augmented: DepMap,
  resolve: OwnResolver = defaultResolve,
): ResolvedDependency[] {
  const out: ResolvedDependency[] = [];
  for (const name of names) {
    let version: string | null = null;
    try {
      const manifest = JSON.parse(readFileSync(resolve(`${name}/package.json`), 'utf8')) as { version?: unknown };
      version = typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
      // Not installed here, or a package that does not expose its own package.json through
      // `exports`. Either way this source cannot answer for it; the CDN still can.
      version = null;
    }
    if (!version || !satisfies(version, augmented[name])) continue;
    out.push({ n: name, v: version, d: 0 });
  }
  // Sorted, so two runs over the same tree produce byte-identical locksets.
  return out.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
}

/**
 * The DIRECTORY of one platform-provided package in this package's own tree, for
 * `--bundle-packages` to read content from — resolved the same hoist-correct way, never by
 * walking. Returns null for a name this tree cannot answer for, so the caller falls back to
 * the CDN rather than shipping nothing.
 */
export function ownPackageDir(name: string, resolve: OwnResolver = defaultResolve): string | null {
  try {
    return dirname(resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}
