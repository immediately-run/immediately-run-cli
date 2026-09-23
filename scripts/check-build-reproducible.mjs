#!/usr/bin/env node
/*
 * Build this tree twice; the two `dist/` outputs must be byte-identical.
 *
 * This is the proof the published-payload parity gate (R3-756) rests on. The CLI
 * publishes BUILT `dist` — the tarball's `files` is `["dist", "README.md",
 * "LICENSE"]` — so comparing the packed payload against the published package
 * is only sound if the build is a pure function of the source tree: same input,
 * same bytes. If the build embedded timestamps, absolute paths, or unordered
 * iteration, every pair of builds would differ, a payload gate would be red
 * forever, and the honest gate would decay into a downgraded one nobody reads.
 * Measured here, not assumed: the check runs the real `npm run build` twice and
 * byte-compares the whole output, naming any file whose digest moved.
 *
 * Ported from `immediately-run-sdk/scripts/check-build-reproducible.mjs`
 * (R3-755's proof), adapted to this repo's build (`tsc`, whose output is a pure
 * compile of `src/` — the `Date` uses in `src/` are runtime arguments to
 * exported functions, not build-time embedding; that is exactly the assumption
 * this check turns into evidence).
 *
 * ## What counts as a difference
 *
 * Any file present on one side and not the other, or present on both with
 * different SHA-256 digests. Nothing is ignored: no mtime window, no normalized
 * line endings, no allowlist. A file that genuinely varies per build (a
 * generated timestamp header) is a BUILD bug to fix, not noise to filter — that
 * is the invariant the payload gate needs.
 *
 * ## Where it runs
 *
 * `verify` (through `check:reproducible`, after a build — `npm test` builds
 * first, and the check itself builds twice more). Two extra `tsc` builds per
 * run is the price of the proof; this repo's build is seconds.
 *
 * Usage: node scripts/check-build-reproducible.mjs [--self-test]
 * Exit:  0 the two builds are byte-identical (or --self-test passed)
 *        1 the two builds differ — the differing paths are named; fix the build
 *        2 a build itself failed
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { digestDrift, treeDigests } from './lib/treeCompare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The impure half, one function: run the real build, move the fresh `dist/` into
 * a temp directory this script creates and removes, and return the directory. Two
 * calls yield two independently built trees to compare.
 */
function buildInto() {
  // INSIDE the repo: `renameSync` cannot cross filesystems, and /tmp is often
  // another mount. Created, used, and removed by this script alone.
  const dest = mkdtempSync(join(ROOT, '.build-reproducible-'));
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  renameSync(join(ROOT, 'dist'), join(dest, 'dist'));
  return dest;
}

function selfTest() {
  let ok = 0;
  let total = 0;
  const check = (label, cond) => {
    total += 1;
    if (cond) ok += 1;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };

  const dir = mkdtempSync(join(tmpdir(), 'build-reproducible-selftest-'));
  try {
    mkdirSync(join(dir, 'a', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'b', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a', 'index.js'), 'same');
    writeFileSync(join(dir, 'a', 'sub', 'x.js'), 'same');
    writeFileSync(join(dir, 'b', 'index.js'), 'same');
    writeFileSync(join(dir, 'b', 'sub', 'x.js'), 'CHANGED');
    const a = treeDigests(join(dir, 'a'));
    const b = treeDigests(join(dir, 'b'));
    check('identical trees have no drift', digestDrift(a, treeDigests(join(dir, 'a'))).length === 0);
    const rows = digestDrift(a, b);
    check(
      'a changed byte is one row naming the path and both digests',
      rows.length === 1 && rows[0].path === 'sub/x.js' && rows[0].first !== rows[0].second,
    );
    mkdirSync(join(dir, 'c', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'c', 'index.js'), 'same');
    writeFileSync(join(dir, 'c', 'sub', 'x.js'), 'same');
    writeFileSync(join(dir, 'c', 'extra.js'), 'x');
    const added = digestDrift(a, treeDigests(join(dir, 'c')));
    check(
      'an ADDED file is a row, (absent) on the first side',
      added.length === 1 && added[0].path === 'extra.js' && added[0].first === '(absent)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${ok}/${total} self-test cases.`);
  return ok === total ? 0 : 1;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

let first;
let second;
let exitCode = 0;
try {
  first = buildInto();
  try {
    second = buildInto();
  } catch (e) {
    // The second build died: the first build's dist is still moved aside, and the
    // tree must not be left without a build for the chain steps that read one.
    if (first && existsSync(join(first, 'dist')) && !existsSync(join(ROOT, 'dist'))) {
      renameSync(join(first, 'dist'), join(ROOT, 'dist'));
    }
    throw e;
  }
  const rows = digestDrift(treeDigests(join(first, 'dist')), treeDigests(join(second, 'dist')));
  if (rows.length === 0) {
    console.log('✓ two builds of this tree are byte-identical — the payload gate can trust the bytes.');
  } else {
    console.error(
      `::error::the build is NOT reproducible: two builds of the same tree differ in ${rows.length} file(s). ` +
        `The published-payload gate cannot trust these bytes — fix the build (a timestamp, an absolute path, unordered output).`,
    );
    for (const r of rows.slice(0, 20)) {
      const short = (d) => (d === '(absent)' ? d : `${d.slice(0, 12)}…`);
      console.error(`  ${r.path}: first ${short(r.first)} · second ${short(r.second)}`);
    }
    if (rows.length > 20) console.error(`  …and ${rows.length - 20} more.`);
    exitCode = 1;
  }
} catch (e) {
  console.error(
    `✗ the build itself failed (${e instanceof Error ? e.message : String(e)}) — reproducibility not checked.`,
  );
  exitCode = 2;
} finally {
  // Later steps in the chain (npm test, check:published) read a built `dist` —
  // leave the second build's (fresh, and byte-identical to the first when this
  // check is green).
  if (second && existsSync(join(second, 'dist')) && !existsSync(join(ROOT, 'dist'))) {
    renameSync(join(second, 'dist'), join(ROOT, 'dist'));
  }
  for (const d of [first, second]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
}
process.exit(exitCode);
