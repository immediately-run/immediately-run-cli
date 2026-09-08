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

// The SECOND thing copied out of the sandbox, and the one that cost a live acceptance: the
// order the runtime resolves relative specifiers in. `RUNTIME_EXTENSIONS` must equal
// `bundler.ts`'s `extensions` default verbatim, ORDER INCLUDED — `.js` before `.cjs` is the
// whole content of the rule, and a copy that merely holds the same SET resolves
// `./Omnibox` to the other build and mispairs the interop. Not a missing file; a wrong one.
const EXT_SOURCE = ['src/bundler/bundler.ts', /extensions: string\[\] = (\[[^\]]*\])/];
const MINE_EXT = ['src/localPackageSource.ts', /RUNTIME_EXTENSIONS = (\[[^\]]*\])/];

const extract = (text, re, what) => {
  const m = re.exec(text);
  if (!m) throw new Error(`could not find ${what} — the shape it is read from changed`);
  return m[1].replace(/\s+/g, ' ').trim();
};

if (process.argv.includes('--self-test')) {
  const norm = (t) => ALLOWED.reduce((s, [from, to]) => s.split(to).join(from), t);
  const cases = [
    ['an identical file passes', 'a\nb\n', 'a\nb\n', true],
    ['a changed line fails', 'a\nb\n', 'a\nc\n', false],
    ['the allowed import rewrite passes', "from './sourceScan.js';\n", "from '../../../utils/sourceScan';\n", true],
    ['a second, unallowed rewrite fails', "from './other.js';\n", "from '../../../utils/sourceScan';\n", false],
    // The extension list is compared as TEXT so order counts; these prove it does.
    ['the same extensions in the same order pass', "['.js', '.cjs']", "['.js', '.cjs']", true],
    ['the same extensions REORDERED fail', "['.cjs', '.js']", "['.js', '.cjs']", false],
    ['a missing extension fails', "['.js']", "['.js', '.cjs']", false],
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
// The extension order, compared as text so a reordering fails.
try {
  const theirs = extract(readFileSync(join(SANDBOX, EXT_SOURCE[0]), 'utf8'), EXT_SOURCE[1], 'the sandbox resolver extensions');
  const mine = extract(readFileSync(join(root, MINE_EXT[0]), 'utf8'), MINE_EXT[1], 'RUNTIME_EXTENSIONS');
  if (mine !== theirs) {
    console.error(`✗ RUNTIME_EXTENSIONS has DRIFTED from ${EXT_SOURCE[0]}`);
    console.error(`      copy:    ${mine}`);
    console.error(`      sandbox: ${theirs}`);
    console.error('\n  Order is load-bearing: the runtime tries these against a relative');
    console.error('  specifier in THIS order, so a package shipping both `x.js` and `x.cjs`');
    console.error('  gets whichever comes first. Resolving to the other one does not fail —');
    console.error('  it hands a module transpiled against one build to an importer expecting');
    console.error('  the other ("Element type is invalid: … but got: object").');
    process.exit(1);
  }
  console.log(`PASS  RUNTIME_EXTENSIONS matches the sandbox resolver: ${mine}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

console.log('PASS  the vendored CJS scanner matches the sandbox, verbatim.');
