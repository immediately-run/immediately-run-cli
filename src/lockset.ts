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
import { computeInputDepMap, type DepMap } from '@immediately-run/transpiler';

// `computeInputDepMap` is the single source of truth in @immediately-run/transpiler
// (PRETRANSPILED_ARTIFACTS_SPEC §4.4) — re-export it so the runtime's input DepMap
// derivation (react-preset augment → filter build deps → strip self-hosted → sort)
// lives in exactly one place, shared with the sandbox bundler.
export { computeInputDepMap, type DepMap };

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
