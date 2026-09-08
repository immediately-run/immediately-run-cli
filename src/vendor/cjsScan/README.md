# `src/vendor/cjsScan` — the sandbox's CJS scanner, VERBATIM

`sandbox/src/bundler/transforms/raw-cjs/scan.ts` and `sandbox/src/utils/sourceScan.ts`,
copied byte-for-byte apart from one import specifier (`'../../../utils/sourceScan'` →
`'./sourceScan.js'`, which this package's module resolution requires).

## Why a copy, and why VERBATIM

`buildLocalPackage` must produce the same per-file `d` (dependency) lists the dependency
CDN produces, because a bundled module is constructed `isCompiled = true` and the bundler
therefore **never scans it** — `file.d` is the only source of its graph. A `d` that is
short by one entry does not degrade: `Evaluation.ts` throws
`Dependency "…" not collected from "…"` the first time that module is evaluated.

The CLI cannot depend on the sandbox package — it runs on a bare CI runner with only its
own npm dependencies — so a copy is the only option. **What it must not be is a
re-implementation.** The first version of this file was a 60-line paraphrase, and review
found it disagreed with the original on 5 of 10 cases, including the one
`sandbox/src/bundler/transforms/raw-cjs/scan.ts` was written for (R3-233): a regex literal
containing a quote character opens a phantom string and swallows every `require` after it.

So: copy, do not paraphrase. `npm run check:scanner-drift` compares these files against the
sandbox checkout when it is present as a sibling, and says so when it is not.
