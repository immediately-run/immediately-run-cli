# `test/fixtures` — frozen inputs for the local-package-source differential test

## `omnibox-0.2.1/` + `omnibox-0.2.1.cdn.msgpack`

`@immediately-run/omnibox@0.2.1` exactly as npm installs it, beside the **verbatim
`/package/` response** the dependency CDN returns for the same version.

They are here together because the pair is the only way to know that
`buildLocalPackage` reproduces a producer whose source we cannot read: build the module
from the installed tree, and diff it against what the CDN actually said. A test that only
checked our own output against our own expectations would agree with itself.

**Frozen deliberately** (`ways_of_working` §4 — goldens over live data). `0.2.1` is used
rather than a current version precisely because it is old enough that the CDN resolves it;
the outage this work exists for is that a *fresh* version does not. Refreshing these means
re-fetching both halves for the same version, never one of them.

## `grove-hero/hero-33391ef.mdx` + `grove-hero/hero-e017647.mdx`

grove's `content/_layouts/hero.mdx` copied verbatim at two commits of
`immediately-run/grove` (R3-1349):

- `33391ef`: the shipped starter whose unquoted `description:` holds `nav: top` and
  `cover: lands` mid-line. That is a YAML error, so the host dropped its metadata row.
- `e017647`: the same file with the `description:` quoted. It parses to
  `layoutRole: root`, `nav: top`.

The sidecar test feeds both to `emitMdxMetadata` and checks the two outcomes the sandbox's
live scan gives for the same bytes (sandbox `src/bundler/frontmatterAdoption.test.ts`).
Frozen: the point is those exact bytes, not grove's current file.
