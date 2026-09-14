/*
 * Dependency lockset for cached repository zips (PRETRANSPILED_ARTIFACTS_SPEC
 * §4.3, §7 step 2).
 *
 * At zip-build time we ask the same sandpack CDN resolver the immediately.run
 * runtime would otherwise query at boot (`/dep_tree/`), and embed the verbatim
 * response in the manifest sidecar. The runtime applies it only when its own
 * computed input DepMap exactly matches the `dependencies` echo, so a stale or
 * mismatched lockset can never be applied — it just falls back to live
 * resolution.
 */

import { decode as decodeMsgPack } from '@msgpack/msgpack';
import {
  assertDependenciesResolved,
  concreteVersion,
  computeInputDepMap,
  findUnrequestedPrereleases,
  type DepMap,
} from '@immediately-run/transpiler';

// `computeInputDepMap`, `assertDependenciesResolved` and the
// unrequested-prerelease guard are the single source of truth in
// @immediately-run/transpiler (PRETRANSPILED_ARTIFACTS_SPEC §4.4) — the input
// DepMap derivation, the resolution-completeness guard and the prerelease
// guard live in exactly one place, shared with the sandbox bundler.
// Re-exported here for convenience.
export { assertDependenciesResolved, computeInputDepMap, type DepMap };

// Mirrors sandbox/src/bundler/module-registry/module-cdn.ts (CDN_ROOT,
// CDN_VERSION). Drift is safe — the runtime checks `cdnVersion` and falls back
// to live resolution on mismatch — but wasteful; keep in sync.
export const DEFAULT_CDN_ROOT = 'https://sandpack-cdn-staging.blazingly.io/';
export const LOCKSET_CDN_VERSION = 5;

// One entry of the CDN's resolved flat dependency list: name / exact version /
// depth. Field names are the CDN wire format, embedded verbatim.
export interface ResolvedDependency {
  n: string;
  v: string;
  d: number;
}

export interface LocksetSection {
  cdnVersion: number;
  // The EXACT input DepMap the lockset was resolved for:
  // filterBuildDeps(augmentDependencies(package.json dependencies)), sorted.
  // The runtime applies `resolved` only on an exact match against its own
  // computed map.
  dependencies: DepMap;
  // Verbatim /dep_tree response.
  resolved: ResolvedDependency[];
}

// --- CDN request -------------------------------------------------------------

// Same payload format as the runtime's encodePayload (module-cdn.ts).
export const encodeDepTreePayload = (deps: DepMap): string =>
  Buffer.from(`${LOCKSET_CDN_VERSION}(${JSON.stringify(deps)})`).toString('base64');

const isResolvedDependency = (value: unknown): value is ResolvedDependency => {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<ResolvedDependency>;
  return typeof d.n === 'string' && typeof d.v === 'string' && typeof d.d === 'number';
};

/**
 * The RAW `/dep_tree/` answer — whatever the CDN could resolve, with no completeness
 * guard. Split out for R3-567: gap-filling needs the partial list, because the CDN
 * SILENTLY OMITS a package it cannot resolve rather than erroring, and that omission is
 * exactly the set the installed tree fills in.
 *
 * Every caller that intends to SHIP the result must still run `assertDependenciesResolved`
 * over the final list — this function deliberately does not, and it is the only place in
 * this file that returns something incomplete.
 */
export const fetchDepTree = async (
  dependencies: DepMap,
  cdnRoot: string = DEFAULT_CDN_ROOT,
): Promise<ResolvedDependency[]> => {
  const base = cdnRoot.endsWith('/') ? cdnRoot : `${cdnRoot}/`;
  const url = `${base}dep_tree/${encodeDepTreePayload(dependencies)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`dep_tree request failed: HTTP ${response.status}`);
  }
  const resolved = decodeMsgPack(new Uint8Array(await response.arrayBuffer()));
  if (!Array.isArray(resolved) || !resolved.every(isResolvedDependency)) {
    throw new Error('dep_tree response is not a resolved-dependency list');
  }
  return resolved;
};

/**
 * The guarded `/dep_tree/` fetch (R3-600): the raw answer, refused when it
 * carries a prerelease no requested range asked for (the CDN answered `react
 * ^19.2.5` with `19.3.0-canary-…` while stable 19.3.0 was on npm). On offending
 * entries the offending top-level dependencies are re-resolved pinned to their
 * range's floor (`^18.2.0` → `18.2.0` — the runtime's own recovery) — ONE
 * retry, with a console warning per re-pin on the builder's warn surface — and
 * the clean answer is returned, BEFORE the R3-567 gap-filling folds in the
 * local/platform sources (a canary must not survive into the merge). A range
 * with no concrete floor, or a prerelease that survives the retry, throws.
 */
export const fetchDepTreeGuarded = async (
  dependencies: DepMap,
  cdnRoot: string = DEFAULT_CDN_ROOT,
): Promise<ResolvedDependency[]> => {
  let resolved = await fetchDepTree(dependencies, cdnRoot);
  const offending = findUnrequestedPrereleases(dependencies, resolved);
  if (offending.length === 0) return resolved;

  const retry: DepMap = { ...dependencies };
  for (const entry of offending) {
    const range = entry.range ?? dependencies[entry.n];
    if (range === undefined) continue; // transitive: named in the surviving check below
    const floor = concreteVersion(range);
    if (floor === undefined) {
      throw new Error(
        `The package CDN resolved "${entry.n}" to the prerelease ${entry.v}, and the requested ` +
          `range "${range}" has no concrete version to re-pin it to.`,
      );
    }
    console.warn(
      `The package CDN resolved "${entry.n}@${range}" to the prerelease ${entry.v}; ` +
        `re-resolving pinned at ${floor}`,
    );
    retry[entry.n] = floor;
  }
  resolved = await fetchDepTree(retry, cdnRoot);
  const remaining = findUnrequestedPrereleases(retry, resolved);
  if (remaining.length > 0) {
    const list = remaining.map((e) => `"${e.n}"→${e.v}`).join(', ');
    throw new Error(
      `The package CDN resolved prereleases no requested range asked for (${list}); ` +
        `refusing the answer rather than embedding one.`,
    );
  }
  return resolved;
};

// --- bundled package content (R3-49a) ----------------------------------------
//
// The lockset above embeds only the RESOLUTION (name/version/depth). The module
// CONTENT is what the runtime still fetches per-package from `/package/<name@ver>`
// at boot — the step profiling showed dominates cold boot (`loadNodeModules`,
// ~99%). Bundling that content into the cache zip makes it local + deterministic;
// the sandbox consume-side + ZenFS batch hydration (R3-49b) then deliver it without
// the per-package round-trips. See plans/dependency-loading-optimization.md.

/** The `/package/` key the CDN (and the sandbox runtime's `fetchModule`) use for a
 *  package: `btoa("<CDN_VERSION>(<name>@<version>)")`. Mirrors the sandbox's
 *  `module-cdn.ts` `encodePayload` so a bundled package is found under the exact key
 *  the runtime would otherwise fetch. */
export const encodePackageKey = (name: string, version: string): string =>
  Buffer.from(`${LOCKSET_CDN_VERSION}(${name}@${version})`).toString('base64');

/** Filesystem-safe in-zip filename for a bundled package. The CDN key is standard
 *  base64 (contains `/`), so it can't be a path; `encodeURIComponent(name@version)`
 *  is deterministic, collision-free, and escapes the `/` in scoped names
 *  (`@scope/pkg`). The consume side computes the same from name+version. */
export const bundledPackageFilename = (name: string, version: string): string =>
  encodeURIComponent(`${name}@${version}`);

/** A fetched package: its `/package/` key + the verbatim msgpack `ICDNModule` bytes
 *  (stored unchanged so the runtime decodes them identically to a live fetch). */
export interface BundledPackage {
  key: string;
  name: string;
  version: string;
  bytes: Uint8Array;
}

/**
 * Fetch the verbatim `/package/<name@version>` response for every resolved
 * dependency, for embedding in the cache zip. Each `/package/` URL is immutable
 * (a fixed name@exact-version), so the bytes are reproducible. A per-package
 * failure throws — package bundling is all-or-nothing for a build (a partial
 * bundle would silently fall back to live fetch for the gaps, defeating
 * determinism); the caller may catch to omit the whole section.
 */
export const fetchBundledPackages = async (
  resolved: readonly ResolvedDependency[],
  cdnRoot: string = DEFAULT_CDN_ROOT,
): Promise<BundledPackage[]> => {
  const base = cdnRoot.endsWith('/') ? cdnRoot : `${cdnRoot}/`;
  return Promise.all(
    resolved.map(async ({ n: name, v: version }) => {
      const key = encodePackageKey(name, version);
      const response = await fetch(`${base}package/${key}`);
      if (!response.ok) {
        throw new Error(`package fetch failed for ${name}@${version}: HTTP ${response.status}`);
      }
      return { key, name, version, bytes: new Uint8Array(await response.arrayBuffer()) };
    }),
  );
};
