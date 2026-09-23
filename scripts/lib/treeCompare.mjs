// Shared tree-compare core for the release gates: the published-payload parity
// check (`check-published-parity.mjs`) and the build-determinism check
// (`check-build-reproducible.mjs`) are the same comparison — two trees, per-entry
// content digests, differences as rows — over different subjects (published
// tarball vs rebuilt dist). One home (R6); each gate keeps only its own subject
// and its own exit-code policy.
//
// Vendored from `immediately-run-sdk/scripts/lib/treeCompare.mjs` (R3-755): the
// code below is identical to the SDK original — only this vendoring note (and
// this paragraph) is added. This repo and the SDK are separate packages with no
// shared runtime dep, and a git-submodule/workspace indirection for a few dozen
// stable lines would cost more than the vendoring does. If the core ever
// changes, change every copy in the same wave — the copies are the SDK root's
// `scripts/lib/treeCompare.mjs`, its safe-content vendoring
// (`safe-content/scripts/lib/treeCompare.mjs`), and this file (grove's parity
// script predates the extraction and keeps its own inline digest walk, so it is
// not a copy); verify a copy's code by diffing below the header, not by
// whole-file hash.
//
// Row fields are named first/second: the reproducible check compares two builds
// of the same tree and neither side is "published"; the parity check maps them
// onto its published/local vocabulary in its own wrapper.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** sha256 of one file, hex — the per-entry content digest. */
export function fileDigest(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** Walk a directory, returning `Map<relativePath, digest>` (regular files). */
export function treeDigests(root) {
  const map = new Map();
  const walk = (rel) => {
    const abs = rel === '' ? root : join(root, rel);
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(rel === '' ? entry : `${rel}/${entry}`);
    } else if (statSync(abs).isFile()) {
      map.set(rel, fileDigest(abs));
    }
  };
  walk('');
  return map;
}

/**
 * Compare two digest Maps, per entry. Returns the differences as
 * `{ path, first, second }` rows — empty means the trees are byte-identical. A
 * path on one side only is a row reading `(absent)` on the other, in both
 * directions: an added-only change must not be silent.
 */
export function digestDrift(first, second) {
  const rows = [];
  for (const path of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    const a = first.get(path);
    const b = second.get(path);
    if (a !== b) rows.push({ path, first: a ?? '(absent)', second: b ?? '(absent)' });
  }
  return rows;
}
