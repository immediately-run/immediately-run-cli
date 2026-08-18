/*
 * Pre-transpiled artifact emission for `cache-zip`
 * (PRETRANSPILED_ARTIFACTS_SPEC §4.1–§4.2, §7 step 1).
 *
 * After the archive + sidecar, transpile every covered tracked source through
 * @immediately-run/transpiler — the SAME code the sandbox babel-worker runs live
 * — and embed the outputs under `.immediately.run/artifacts/` with an index. A clean
 * cached boot can then seed `/transpiled` from these instead of running babel
 * (§5.1). Byte-identity with the live transpile is what makes that safe (§4.4);
 * it holds because this is literally the same package, exercised over the same
 * source bytes the zip carries.
 *
 * This step fails per-file softly: a file that won't transpile is omitted with a
 * warning (it would fail identically at runtime — the repo's own CI owns
 * correctness, §7). The whole step is opt-out via `--no-artifacts`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

import {
  isJsonSerializable,
  isUnderSidecar,
  validateMdxMetadataSidecar,
  type Frontmatter,
  type MdxMetadataFileEntry,
  type MdxMetadataSidecar,
} from '@immediately-run/platform-constants';
import {
  computeToolchainHash,
  isTransformable,
  parseFrontmatter,
  PRESET_NAME,
  transformFile,
  TRANSPILER_VERSION,
} from '@immediately-run/transpiler';

import type { ManifestEntry } from './manifest.js';

const TRANSPILER_PKG = '@immediately-run/transpiler';

// The bundler keys app modules under APP_ROOT (`sandbox/src/fsLayout.ts`), so a
// repo file `src/App.tsx` is the module `/app/src/App.tsx` at runtime. Transpile
// AS that path so chain selection (and any path-dependent output) matches the
// live transpile exactly. The artifact index keys, by contrast, are
// repo-relative (`/src/App.tsx`) — what the runtime consults `/transpiled` by.
const APP_ROOT = '/app';

export interface ArtifactIndexFileEntry {
  /** git blob SHA — must equal the manifest entry's `sha` (§4.2). */
  srcSha: string;
  /** Output path relative to `.immediately.run/artifacts/` (`transpiled/<path>.js`). */
  out: string;
  /** Raw dependency specifiers, as the chain reports them. */
  deps: string[];
}

export interface ArtifactIndex {
  schemaVersion: 1;
  toolchain: {
    transpiler: string;
    version: string;
    toolchainHash: string;
    preset: string;
  };
  files: Record<string, ArtifactIndexFileEntry>;
}

export interface ArtifactEmission {
  index: ArtifactIndex;
  /** Output files keyed by path relative to `.immediately.run/artifacts/`. */
  files: Map<string, string>;
  transpiledCount: number;
  skipped: { path: string; reason: string }[];
  sourceBytes: number;
  artifactBytes: number;
}

// `node_modules/` is never covered (the runtime transpiles it live & compact),
// and the platform sidecar dir is our own infrastructure — exclude both, mirroring §7.
const isExcluded = (relPath: string): boolean =>
  isUnderSidecar(relPath) ||
  relPath.split('/').includes('node_modules');

// Exact blob bytes (NOT the trimmed `git()` helper): the runtime transpiles the
// verbatim file the zip carries (a stripped trailing newline would change the
// emitted bytes and break byte-identity).
const readBlob = (repo: string, sha: string): string =>
  execFileSync('git', ['-C', repo, 'cat-file', 'blob', sha], {
    maxBuffer: 512 * 1024 * 1024,
  }).toString('utf8');

// Walk the INSTALLED @immediately-run/transpiler directory — which is exactly the
// extracted published npm tarball — and hash it by the §4.4 canonical-bytes
// recipe. Computing over the installed artifact (not a local rebuild) is what the
// spec requires of both producers; the deploy-time parity assertion (G2-8) checks
// the sandbox's embedded hash against this same published artifact.
const collectPackageFiles = (dir: string, base = dir): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue; // not in our tarball; defensive
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const [k, v] of collectPackageFiles(full, base)) out.set(k, v);
    } else {
      out.set(relative(base, full).split(sep).join('/'), readFileSync(full));
    }
  }
  return out;
};

const resolveToolchainHash = async (): Promise<string> => {
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve(`${TRANSPILER_PKG}/package.json`));
  return computeToolchainHash(collectPackageFiles(pkgDir));
};

/**
 * Transpile every covered tracked source into pre-transpiled artifacts + an
 * index. `entries` is the manifest's `entries[]` (sorted by path); iterating it
 * makes both the index key order and the file set deterministic.
 */
export const emitArtifacts = async (
  repo: string,
  entries: ManifestEntry[],
): Promise<ArtifactEmission> => {
  const files = new Map<string, string>();
  const indexFiles: Record<string, ArtifactIndexFileEntry> = {};
  const skipped: { path: string; reason: string }[] = [];
  let sourceBytes = 0;
  let artifactBytes = 0;

  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const rel = entry.path;
    if (isExcluded(rel)) continue;

    const runtimePath = `${APP_ROOT}/${rel}`;
    if (!isTransformable(runtimePath)) continue;

    const code = readBlob(repo, entry.sha);
    const result = await transformFile({ path: runtimePath, code });
    if ('error' in result) {
      console.warn(`Warning: artifact omitted for ${rel} (${result.error.message})`);
      skipped.push({ path: rel, reason: result.error.message });
      continue;
    }

    const out = `transpiled/${rel}.js`;
    files.set(out, result.code);
    indexFiles[`/${rel}`] = { srcSha: entry.sha, out, deps: result.deps };
    sourceBytes += Buffer.byteLength(code, 'utf8');
    artifactBytes += Buffer.byteLength(result.code, 'utf8');
  }

  const index: ArtifactIndex = {
    schemaVersion: 1,
    toolchain: {
      transpiler: TRANSPILER_PKG,
      version: TRANSPILER_VERSION,
      toolchainHash: await resolveToolchainHash(),
      preset: PRESET_NAME,
    },
    files: indexFiles,
  };

  return {
    index,
    files,
    transpiledCount: files.size,
    skipped,
    sourceBytes,
    artifactBytes,
  };
};

// The sidecar's SCHEMA is owned by `@immediately-run/platform-constants` (R3-275):
// this writer and the sandbox's reader used to describe the format independently,
// which is how a reader can tighten a check the writer never learns about — and every
// entry it then drops looks exactly like "this repo has no frontmatter". Re-exported
// under the names this package already published so consumers are unaffected.
//
// `srcSha` is the git blob SHA and must equal the manifest entry's `sha`: the runtime
// confines a sidecar entry to a manifest member whose sha matches before seeding.
// Keys are repo-relative with a leading slash (`/content/post.mdx`), the
// manifest/`index.json` key space; the runtime translates them to the absolute
// `/app/...` metadata-store key at seed time.
export type { MdxMetadataFileEntry, MdxMetadataSidecar };

export interface MdxMetadataEmission {
  sidecar: MdxMetadataSidecar;
  count: number;
  skipped: { path: string; reason: string }[];
}

/**
 * The frontmatter content-collection sidecar (MDX_CONTENT_COLLECTIONS_SPEC §1.3):
 * a blob-SHA-keyed map from every tracked `.mdx` under the app root to its parsed
 * frontmatter, so a clean cached boot can seed the metadata store from JSON instead
 * of a recursive directory walk + per-file read across the COW port.
 *
 * `.mdx`-ONLY and byte-identical to the live scan by construction:
 *  - The runtime metadata store is `.mdx`-only — `Bundler.preloadMDXMetadata` globs
 *    `/**\/*.mdx` and `extractMetadata` guards `path.endsWith('.mdx')` — so an app-root
 *    `.md` (which is MDX-transpilable, hence has a `/transpiled` artifact) still carries
 *    NO frontmatter metadata. Emitting `.md` here would break the §2 cache==live set.
 *  - Uses the SAME `parseFrontmatter` the runtime's `extractMetadata` uses.
 *  - Replicates the empty-frontmatter DROP (`extractMetadata` stores nothing when the
 *    parsed frontmatter has zero keys): no entry for absent/empty (`---\n---`) frontmatter.
 *  - A file whose frontmatter fails to parse is omitted with a warning (as the runtime's
 *    try/catch drops it), never failing the build — this is a third independently-failing
 *    cache-zip step, opt-out via `--no-mdx-metadata`.
 */
export const emitMdxMetadata = (repo: string, entries: ManifestEntry[]): MdxMetadataEmission => {
  const files: Record<string, MdxMetadataFileEntry> = {};
  const skipped: { path: string; reason: string }[] = [];

  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const rel = entry.path;
    if (isExcluded(rel)) continue;
    // Case-sensitive `.mdx`, matching the runtime scan (NOT `isTransformable`'s
    // case-insensitive `.mdx?` — that governs transpile coverage, not the store).
    if (!rel.endsWith('.mdx')) continue;

    const code = readBlob(repo, entry.sha);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(code).data;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: mdx-metadata omitted for ${rel} (frontmatter parse failed: ${reason})`);
      skipped.push({ path: rel, reason });
      continue;
    }
    // Empty-frontmatter drop — replicate extractMetadata exactly.
    if (Object.keys(frontmatter).length === 0) continue;

    // The envelope contract (R3-275): values must survive JSON unchanged. A value
    // that does not — a `Date`, a non-finite number — would be written as something
    // ELSE (a string, `null`) and the cached boot would then see a different value
    // than the live scan, silently. Omit-with-warning instead, the same treatment a
    // parse failure gets, so the sidecar is never a lie about what it carries.
    //
    // Unreachable with today's parser: `@immediately-run/transpiler` uses `yaml`'s
    // core schema, which yields a string for `date: 2020-01-02`. This guards the
    // parser CHANGING (a YAML-1.1 timestamp schema, a custom tag), which is exactly
    // the kind of upstream change that would otherwise land as a boot-time mystery.
    if (!isJsonSerializable(frontmatter)) {
      const reason = 'frontmatter contains a value JSON cannot carry unchanged';
      console.warn(`Warning: mdx-metadata omitted for ${rel} (${reason})`);
      skipped.push({ path: rel, reason });
      continue;
    }

    files[`/${rel}`] = { srcSha: entry.sha, frontmatter: frontmatter as Frontmatter };
  }

  const sidecar: MdxMetadataSidecar = { schemaVersion: 1, files };
  assertEmittedSidecar(sidecar);
  return { sidecar, count: Object.keys(files).length, skipped };
};

/**
 * Run the READER's validator over our own output before it is written (R3-275b).
 *
 * The point is not to catch a corrupted disk — nothing has touched the object yet.
 * It is to catch THIS emitter drifting from the schema the sandbox enforces, here,
 * in the build that produced the zip, instead of downstream as "the cache seeded
 * nothing" on someone else's boot, which is indistinguishable from "this repo has no
 * frontmatter". Since the two sides ran independent readings of the format until
 * R3-275, that drift is the historically likely failure, not a hypothetical one.
 *
 * Throws rather than warning: a cache zip carrying a sidecar the runtime will
 * discard is strictly worse than one carrying no sidecar at all — the runtime treats
 * a present-but-unusable sidecar as "seeded, nothing to do" and does not live-scan.
 */
export const assertEmittedSidecar = (sidecar: MdxMetadataSidecar): void => {
  const validation = validateMdxMetadataSidecar(sidecar);
  if (!validation.ok) {
    throw new Error(
      `mdx-metadata sidecar failed its own schema validation (${validation.reason}) — ` +
        'this is a bug in emitMdxMetadata, not in the repo being packaged.',
    );
  }
  if (validation.rejected.length) {
    const detail = validation.rejected.map((r) => `${r.path} (${r.reason})`).join(', ');
    throw new Error(
      `mdx-metadata sidecar built ${validation.rejected.length} entry/entries the runtime ` +
        `would discard: ${detail} — this emitter and the shared schema have drifted.`,
    );
  }
};
