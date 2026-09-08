/*
 * `require()` specifiers from CJS source (R3-567).
 *
 * A DELIBERATE SECOND COPY of the sandbox's `bundler/transforms/raw-cjs/scan.ts`, kept
 * small on purpose. The two cannot share a module today: the scanner lives in the sandbox
 * repo, which this CLI does not depend on (and must not — it runs on a bare CI runner
 * with only its own npm deps). Copying it is the same trade `check-dependency-pins.mjs`
 * documents for its own duplication.
 *
 * WHAT KEEPS THE COPY HONEST is not discipline: `test/localPackageSource.test.mjs` diffs
 * this scanner's output, through `buildLocalPackage`, against the VERBATIM `/package/`
 * response the real CDN returns for the same package. If this drifts from what the
 * bundler's scanner would produce, the per-file `d` lists stop matching and that test
 * goes red.
 *
 * It is narrower than the sandbox's scanner by design — it answers only "which specifiers
 * does this file require", not "is this file ESM", because the caller already knows the
 * file is part of a CJS entry closure.
 */

/** Positions inside a string, template or comment, which must not be scanned. */
const SKIP_OPENERS: Record<string, string> = { "'": "'", '"': '"', '`': '`' };

/**
 * The `require(<literal>)` specifiers in `source`, de-duplicated, in first-seen order.
 *
 * Skips string, template and comment bodies so a `require(` inside a doc comment or a
 * string literal is not mistaken for a call — the failure that would put a phantom
 * dependency into `d` and send the bundler resolving something that does not exist.
 */
export function scanCjsRequires(source: string): { requires: string[] } {
  const requires: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];

    // Comments.
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Strings and templates.
    const closer = SKIP_OPENERS[c];
    if (closer) {
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === closer) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // `require` as a WORD, not `.require` and not `myrequire`.
    if (c === 'r' && source.startsWith('require', i)) {
      const before = i > 0 ? source[i - 1] : '';
      const after = source[i + 7] ?? '';
      const isWord = !/[\w$.]/.test(before) && !/[\w$]/.test(after);
      if (isWord) {
        const m = /^require\s*\(\s*(['"])([^'"]*)\1\s*\)/.exec(source.slice(i));
        if (m) {
          if (!requires.includes(m[2])) requires.push(m[2]);
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  return { requires };
}
