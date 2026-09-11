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
