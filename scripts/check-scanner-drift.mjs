#!/usr/bin/env node
// `src/vendor/cjsScan/` must stay a VERBATIM copy of the sandbox's CJS scanner.
//
// WHY A CHECK AND NOT A COMMENT. The first version of this vendored scanner was a
// paraphrase, and its header claimed the differential test kept it honest. That claim was
// false: review replaced the whole scanner body with a naive four-line regex and every test
// stayed green, because the fixture's two files with a non-empty `d` are plain tsup CJS and
// exercise none of the lexical logic. A comment that describes behaviour the code does not
// have is worse than no comment.
//
// The sandbox is a sibling CHECKOUT, not a dependency, so this cannot run everywhere. That
// is a third outcome, not a pass: absent → SKIP, loudly, naming why.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = process.env.IR_SANDBOX_ROOT ?? join(root, '..', 'sandbox');

/** The one edit the copy is allowed: this package resolves `.js` specifiers. */
const ALLOWED = [["from '../../../utils/sourceScan'", "from './sourceScan.js'"]];

const PAIRS = [
  ['src/vendor/cjsScan/scan.ts', 'src/bundler/transforms/raw-cjs/scan.ts'],
  ['src/vendor/cjsScan/sourceScan.ts', 'src/utils/sourceScan.ts'],
];

if (process.argv.includes('--self-test')) {
  const norm = (t) => ALLOWED.reduce((s, [from, to]) => s.split(to).join(from), t);
  const cases = [
    ['an identical file passes', 'a\nb\n', 'a\nb\n', true],
    ['a changed line fails', 'a\nb\n', 'a\nc\n', false],
    ['the allowed import rewrite passes', "from './sourceScan.js';\n", "from '../../../utils/sourceScan';\n", true],
    ['a second, unallowed rewrite fails', "from './other.js';\n", "from '../../../utils/sourceScan';\n", false],
  ];
  let bad = 0;
  for (const [name, mine, theirs, expected] of cases) {
    const ok = norm(mine) === theirs;
    if (ok === expected) console.log(`PASS  ${name}`);
    else {
      console.error(`FAIL  ${name}`);
      bad++;
    }
  }
  console.log(`\n${cases.length - bad}/${cases.length} self-test cases.`);
  process.exit(bad ? 1 : 0);
}

if (!existsSync(SANDBOX)) {
  console.log(`SKIP  scanner drift: no sandbox checkout at ${SANDBOX}.`);
  console.log('      This is a SKIP, not a pass — the copy is unverified in this environment.');
  console.log('      Set IR_SANDBOX_ROOT, or run it where the sibling checkouts are.');
  process.exit(0);
}

let drifted = 0;
for (const [mineRel, theirsRel] of PAIRS) {
  const mine = readFileSync(join(root, mineRel), 'utf8');
  const theirs = readFileSync(join(SANDBOX, theirsRel), 'utf8');
  const normalised = ALLOWED.reduce((s, [from, to]) => s.split(to).join(from), mine);
  if (normalised === theirs) {
    console.log(`PASS  ${mineRel} is verbatim`);
    continue;
  }
  drifted++;
  console.error(`✗ ${mineRel} has DRIFTED from ${theirsRel}`);
  const a = normalised.split('\n');
  const b = theirs.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`    first difference at line ${i + 1}:`);
      console.error(`      copy:    ${a[i] ?? '(absent)'}`);
      console.error(`      sandbox: ${b[i] ?? '(absent)'}`);
      break;
    }
  }
}
if (drifted) {
  console.error('\n  Re-copy them. This scanner produces the per-file `d` lists a bundled');
  console.error('  module is evaluated against, and a `d` short by one entry throws');
  console.error('  `Dependency "…" not collected` at runtime, not at build time.');
  process.exit(1);
}
console.log('PASS  the vendored CJS scanner matches the sandbox, verbatim.');
