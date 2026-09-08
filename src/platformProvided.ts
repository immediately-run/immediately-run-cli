/**
 * The dependencies the PLATFORM injects, which no app declares — and which this package
 * therefore carries so that a cache build never has to ask the dependency CDN for them.
 *
 * ## Why this file exists
 *
 * `computeInputDepMap` (`@immediately-run/transpiler`) does not return the app's
 * dependencies. It returns the app's dependencies PLUS the ones the sandbox runtime needs
 * to evaluate the transpiled output — today `react-refresh` (the HMR wrapper the Babel
 * preset injects), `core-js` (the polyfill the preset targets) and `react-error-boundary`.
 * The runtime's lockset echo-match (R3-289) is over that augmented map, so a lockset that
 * omits them is not "slightly short", it is REJECTED WHOLE and the app resolves live.
 *
 * npm never installs them: the app does not declare them, because it does not know about
 * them — they are the platform's, not the app's. So `resolveFromInstalledTree(repo, …)`
 * could never satisfy them, and R3-567's exit criterion 1 ("no network call to the
 * dependency CDN when an installed tree is present") was unreachable no matter how good the
 * local resolution got. That is not an app-tree problem to fix; it is a missing SOURCE.
 *
 * This package already depends on the exact `@immediately-run/transpiler` build that does
 * the injecting, so declaring its injected set as our own dependencies makes the two move
 * together, resolved by npm against the real registry. `scripts/check-platform-provided.mjs`
 * fails this repo's `verify` if the transpiler ever injects a name we do not carry, or a
 * range our installed copy does not satisfy — the coupling is real, so it is checked rather
 * than commented.
 *
 * ## Why the second root is NARROW
 *
 * `resolveFromInstalledTree` is deliberately bounded at the repo (review round 1: an
 * unbounded walk could resolve a foreign package into a repo's lockset). Resolving from
 * THIS package's tree reopens exactly that hole if it is done for everything — an app's
 * `react` silently becoming the CLI's would be a substitution nobody would catch. So the
 * second root is consulted only for names the app did not declare AND the platform did
 * inject: `platformProvidedNames` computes that difference rather than hard-coding it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DepMap } from './lockset.js';

/**
 * The names present in the AUGMENTED map that the app's own manifest never mentioned.
 *
 * Derived by difference, never listed, so the day the transpiler injects a fourth this
 * returns four. `check-platform-provided.mjs` is what turns that into a red build instead
 * of a silent gap.
 */
export function platformProvidedNames(rootDeps: DepMap, augmented: DepMap): string[] {
  return Object.keys(augmented)
    .filter((name) => rootDeps[name] === undefined)
    .sort();
}

/**
 * This package's own root — the tree npm installed our dependencies into.
 *
 * Found by walking up from this module to the nearest `package.json` rather than by
 * counting `../`, because the count differs between `src/` and the compiled `dist/` and a
 * wrong one fails as "no local copy" — that is, as a silent fallback to the CDN, which is
 * the one failure mode this whole item exists to remove.
 */
export function ownPackageRoot(from: string = fileURLToPath(import.meta.url)): string | null {
  let dir = dirname(from);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
