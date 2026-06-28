/*
 * The contribute manifest sidecar embedded in a cached repository zip.
 *
 * This MUST stay shape-compatible with `RepoManifest` in the immediately.run
 * client (`immediately-run-site-main/src/filesystem/manifest.ts`). The client
 * reads this file from inside the zip (`.immediately.run/contribute-manifest.json`)
 * so contributions work offline: each entry's `sha` is the git blob object id,
 * which is exactly what the contribute diff compares the working tree against.
 */

import { CONTRIBUTE_MANIFEST_PATH } from '@immediately-run/platform-constants';

import type { LocksetSection } from './lockset.js';

export type { LocksetSection, ResolvedDependency, DepMap } from './lockset.js';

export const MANIFEST_SCHEMA_VERSION = 1;

// Stored without a leading slash — zip entries are root-relative. Mirrors
// ZIP_MANIFEST_SIDECAR_PATH ('/<sidecar>/contribute-manifest.json') in the client.
// The literal lives once in @immediately-run/platform-constants (R3-104).
export const MANIFEST_SIDECAR_ENTRY = CONTRIBUTE_MANIFEST_PATH;

export type ManifestSource = 'github-rest' | 'zip-sidecar' | 'zip-lazy-fetched';
export type RefKind = 'branch' | 'tag' | 'commit';
export type EntryType = 'blob' | 'commit';

export interface ManifestEntry {
  path: string;
  mode: string;
  type: EntryType;
  sha: string;
  size?: number;
}

export interface RepoManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  source: ManifestSource;
  capturedAt: number;
  provider: 'github';
  namespace: string;
  repository: string;
  ref: string;
  refKind: RefKind;
  commitSha: string;
  treeSha: string;
  defaultBranch: string;
  truncated: boolean;
  entries: ManifestEntry[];
  // Optional resolved-dependency lockset (PRETRANSPILED_ARTIFACTS_SPEC §4.3).
  // Additive + ignorable by old readers; never bumps schemaVersion (the client
  // hard-rejects unknown versions, so a bump would invalid-zip every deployed
  // client — see CONTRIBUTE_SPEC §14).
  lockset?: LocksetSection;
}
