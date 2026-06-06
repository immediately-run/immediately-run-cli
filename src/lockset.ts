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

// Mirrors sandbox/src/bundler/module-registry/module-cdn.ts (CDN_ROOT,
// CDN_VERSION). Drift is safe — the runtime checks `cdnVersion` and falls back
// to live resolution on mismatch — but wasteful; keep in sync. Phase 03 of the
// plan moves this into the shared @immediately-run/transpiler package.
export const DEFAULT_CDN_ROOT = 'https://sandpack-cdn-staging.blazingly.io/';
export const LOCKSET_CDN_VERSION = 5;

// dependency name => version range, same shape the runtime uses.
export type DepMap = Record<string, string>;

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

// --- input DepMap derivation -------------------------------------------------
// Replicates the runtime's `loadNodeModules` derivation for the react preset
// (the v1 default): ReactPreset.augmentDependencies, then filterBuildDeps,
// then key-sort. Ported from:
//   sandbox/src/bundler/presets/react/ReactPreset.ts
//   sandbox/src/bundler/module-registry/build-dep.ts
// Divergence (e.g. a repo running the solid preset, or a runtime-side change
// to these lists) makes the runtime's echo comparison fail → live resolution,
// never a wrong lockset.

const BUILD_DEPS = new Set(['parcel', 'parcel-bundler', 'vite', '@babel/core', 'react-scripts']);
const BUILD_DEP_REGEXES = [
  /babel-plugin.*/,
  /@babel\/plugin.*/,
  /babel-preset.*/,
  /@babel\/preset.*/,
  /.*parcel-plugin.*/,
];

const isBuildDep = (name: string): boolean =>
  BUILD_DEPS.has(name) || BUILD_DEP_REGEXES.some((re) => re.test(name));

const augmentReactDependencies = (dependencies: DepMap): DepMap => {
  const augmented: DepMap = { ...dependencies };
  if (!augmented['react-refresh']) {
    augmented['react-refresh'] = '^0.11.0';
  }
  augmented['core-js'] = '3.22.7';
  augmented['react-error-boundary'] = '^6.1.0';
  return augmented;
};

const sortDepMap = (deps: DepMap): DepMap =>
  Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// Modules the runtime ALWAYS resolves from a self-hosted versioned origin, not
// the sandpack CDN (sandbox `SELF_HOST_BASES`). Resolution is implicit, so these
// are stripped from the lockset's `/dep_tree/` input unconditionally — keep in
// sync with the sandbox. (`@immediately-run/sdk` is fetched from gh-pages
// `/v/<version>/`.)
const SELF_HOSTED_MODULES = ['@immediately-run/sdk'];

/**
 * Modules the runtime resolves from a self-hosted origin (not the sandpack CDN)
 * are stripped from the dep map *before* the `/dep_tree/` query. This makes the
 * lockset robust to npm→CDN replication lag for those modules (notably
 * `@immediately-run/sdk`): a freshly published version that has not yet
 * replicated would otherwise 500 the whole request. Stripping mirrors the
 * runtime's `loadNodeModules`, so the runtime's echo comparison still matches.
 *
 * `SELF_HOSTED_MODULES` are always stripped (implicit resolution); the
 * `registryResolved` param adds any extra names (e.g. a legacy opt-in field) and
 * defaults to none.
 */
export const computeInputDepMap = (
  pkgDependencies: DepMap,
  registryResolved: readonly string[] = [],
): DepMap => {
  const skip = new Set([...SELF_HOSTED_MODULES, ...registryResolved]);
  const selfHosted: DepMap = {};
  for (const [name, range] of Object.entries(pkgDependencies)) {
    if (!skip.has(name)) selfHosted[name] = range;
  }
  const augmented = augmentReactDependencies(selfHosted);
  const filtered: DepMap = {};
  for (const [name, range] of Object.entries(augmented)) {
    if (!isBuildDep(name) && !skip.has(name)) filtered[name] = range;
  }
  return sortDepMap(filtered);
};

// --- CDN request -------------------------------------------------------------

// Same payload format as the runtime's encodePayload (module-cdn.ts).
export const encodeDepTreePayload = (deps: DepMap): string =>
  Buffer.from(`${LOCKSET_CDN_VERSION}(${JSON.stringify(deps)})`).toString('base64');

const isResolvedDependency = (value: unknown): value is ResolvedDependency => {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<ResolvedDependency>;
  return typeof d.n === 'string' && typeof d.v === 'string' && typeof d.d === 'number';
};

export const fetchLockset = async (
  pkgDependencies: DepMap,
  cdnRoot: string = DEFAULT_CDN_ROOT,
  registryResolved: readonly string[] = [],
): Promise<LocksetSection> => {
  const dependencies = computeInputDepMap(pkgDependencies, registryResolved);
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
  return { cdnVersion: LOCKSET_CDN_VERSION, dependencies, resolved };
};
