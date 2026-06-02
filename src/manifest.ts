/*
 * The contribute manifest sidecar embedded in a cached repository zip.
 *
 * This MUST stay shape-compatible with `RepoManifest` in the immediately.run
 * client (`immediately-run-site-main/src/filesystem/manifest.ts`). The client
 * reads this file from inside the zip (`.tinkerable/contribute-manifest.json`)
 * so contributions work offline: each entry's `sha` is the git blob object id,
 * which is exactly what the contribute diff compares the working tree against.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

// Stored without a leading slash — zip entries are root-relative. Mirrors
// ZIP_MANIFEST_SIDECAR_PATH ('/.tinkerable/contribute-manifest.json') in the
// client.
export const MANIFEST_SIDECAR_ENTRY = '.tinkerable/contribute-manifest.json';

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
}
