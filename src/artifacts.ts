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

import { isUnderSidecar } from '@immediately-run/platform-constants';
import {
  computeToolchainHash,
  isTransformable,
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
