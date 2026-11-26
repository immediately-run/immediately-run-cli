# CODE_SPEC_REFERENCES — `immediately-run-cli`

Durable index of **non-trivial** code↔spec mappings for the developer-side CLI.
Seeded by the code-verification pass (docs `plans/code-verification/06-cli.md`,
roadmap R3-124 / R3-123). The CLI runs on the developer's machine — it is neither an
App nor the Host; its loopback security model (per-session bearer token +
DNS-rebinding/Origin guards) is its own, but it upholds the
tokens-never-reach-the-sandbox invariant at the fragment handoff (LOCAL_DEV §6.4,
core_concepts §9).

## Findings log (dim 1 + 5)

| Area | Finding | Disposition |
|---|---|---|
| LOCAL_DEVELOPMENT §6.3/§8 — `/blob` gitignore filter | **C1 (CRIT) — VERIFIED CLOSED-WITH-TEST 2026-06-22.** `devServer.ts` `case '/blob'` calls `isHiddenPath(root, rel, inGitRepo)` (→ `isVcsNoise` for `.git/`/`node_modules` + `isGitIgnored` via `git check-ignore` for `.gitignore`'d files like `.env`) **before** `statSync`/stream, and returns the **same 404** as an absent file (no existence/size oracle). Path jail `resolveSafe` runs first. Test: `test/dev.test.mjs` `LD-5: /blob 404s a gitignored file even with a valid token` (+ `.git/`, `node_modules` cases). All 45 `dev.test.mjs` tests green. | **Reclassified open-CRIT → fixed-with-test.** Spec §6.3, status, SUMMARY C1 row, validation D4.2 reconciled. |
| LOCAL_DEVELOPMENT §6.3 — non-git tree | **Residual R1 (not CRIT).** In a **non-git** working tree, `/tree` falls back to `walkFiles` (skips only `.git`/`node_modules`) and `/blob`'s `isHiddenPath` skips `isGitIgnored` (`inGitRepo === false`). There is no `.gitignore`, so a `.env`/dotfile in a non-git tree **is served** to a token-holder. `/tree` and `/blob` stay consistent (no read-through past the listing). The gitignore mechanism is inherently git-dependent. | **RECORD.** Whether to filter dotfiles/`.env` in a non-git tree is a product/spec decision, not a clear bug — do not change behavior unilaterally. |
| LOCAL_DEVELOPMENT §8 — `isGitIgnored` | **Residual R2 (defense-in-depth, not CRIT).** The per-request `isGitIgnored` (`devServer.ts`) returns `false` on **any** `git check-ignore` exception, not only exit 1 (= not ignored). A transient git failure in a confirmed git repo therefore **fails open** (serves the file). A fail-closed variant (treat only `err.status === 1` as not-ignored, else 404) would instead 404 all blobs if git breaks — an availability/secrecy trade. The `batchGitIgnored` `/watch` helper documents the same fail-open as acceptable (informational; `/blob` is the real gate). | **RECORD.** Deliberate trade; flag for a follow-up decision before flipping to fail-closed. |

## Non-trivial code↔spec mappings (seed)

- **`src/devServer.ts` `isHiddenPath` / `isGitIgnored` / `isVcsNoise` / `batchGitIgnored`**
  — the single source of the §6.3/§8 "`/blob` 404s what `/tree` hides" invariant
  (LD-5). `/blob` (per-request, line ~557) and `/watch` (batched, line ~651) share
  it. `resolveSafe` is the path jail (T4-equivalent: rejects `..`/absolute/NUL).
- **`src/commands/dev.ts` `buildDeepLink`** — puts `ir-endpoint`/`ir-token` in the URL
  **fragment** (never sent to a server) with a fresh per-session token (`randomBytes(24)`).
  The §6.4 "consume-and-strip + tokens-never-reach-the-sandbox" host-side obligation
  is **site-main's** (`stripIrParams`/`localLocator.ts` before the iframe handoff); the
  transient host-page fragment-retention residual is a `01-site-main.md` finding, not a
  CLI one. The CLI's obligation is just: mint fresh + hand off in the fragment.
- **`src/git.ts` `stripRemoteCredentials`** — LD2-2 `/meta` userinfo strip before a
  remote URL leaves loopback (a remote may embed a token).
- **`src/mcp.ts` `tools/list`** — the grant-filtered method catalog IS the agent's tool
  list (core_concepts §6 Service surface; UI_AS_APPS §5.5/§5.9). Don't hand-roll tools
  around the SDK catalog.
- **`src/gitServe/`** — `immediately-run git-serve` (GIT_SERVE_SPEC §4, §5.1, §9, §10.1).
  `repoName.ts` is R-GS-6 (a repository is a name), `refs.ts` R-GS-3 (exact ref lookup,
  no revision expression; a name that is both a branch and a tag is refused 400
  `ambiguous` rather than read as the branch, a deviation from R-GS-3's stated order that
  awaits a spec amendment), `readRoutes.ts` the five read answers with R-GS-2's one
  resolution (`/tree` answers 500 for a tree with a `.`, `..` or `.git` path segment), `namespace.ts` R-GS-8 (held equal to site-main by
  `test/fixtures/git-serve-namespace-vectors.json`), `guards.ts` the browser-class guards
  of §10.1. The guards are deliberately not `devServer.ts`'s: `Origin` is required, the
  token rides in `Authorization` only, and the Host header must carry the port.
- **`src/deepLink.ts`** — the one place the `ir-endpoint`/`ir-token` fragment and the
  `/edit/<provider>/…` route are written; `dev`, `agent`, `llm` and `git-serve` build their
  links through it, a tailnet `git-serve` link through `buildProviderLink` (no fragment).
  Verified on 2026-11-25.
- **`src/gitServe/peerGate.ts`** — R-GS-16, the tailnet peer gate: stable user ids only,
  fail closed, tagged nodes and the node's own address refused. Pure over an injected
  `whois`; `tailscaleWhois.ts` reads `tailscale whois --json` and `status --json`. The
  field names come from recordings made on a live tailnet (roadmap R3-1356,
  `test/fixtures/tailscale-whois/`). Verified on 2026-11-25.
- **`src/gitServe/pairing.ts` / `connections.ts`** — R-GS-24: a 40-bit one-time code that
  dies on success, on the fifth failure from any caller, or at ten minutes; 256-bit
  connection tokens stored hashed and revocable at the next request. One lock file guards
  every read-modify-write of the state files across processes. The commands wait for it
  (`withStateLock`); the server waits asynchronously (`withStateLockAsync`). A takeover
  pins the candidate lock with a hard link so it can check the same inode before removal.
- **`src/gitServe/smartHttp.ts`** — R-GS-14/15/17: git's HTTP protocol through
  `git http-backend`, with the CLI deciding what is served. `matchGitRoute` admits four
  shapes from the raw request line; the child's `PATH_INFO`/`QUERY_STRING` are rebuilt from
  the parsed parts; push is the `--allow-push` flag's alone (`forcedConfig`, through
  `GIT_CONFIG_COUNT`, which outranks the repository's config), and it forces
  `receive.fsckObjects` so a pushed tree cannot hold `..` or `.git`; browser headers are
  refused before the peer gate. The child's environment is built from an allowlist (no
  inherited CGI variable reaches it). `server.ts` sets `requestTimeout = 0` on the tailnet
  server so a long pack upload is not cut; the git routes carry an idle bound instead.
  Verified on 2026-11-25.
- **`src/gitServe/commit.ts`** — `POST /commit`, R-GS-18 to R-GS-22. `planCommit` is the
  pure check against the parent tree; `applyCommit` builds the tree in a private index
  (`update-index --index-info`, `core.protectHFS`/`core.protectNTFS` forced on, never
  `mktree`) and moves the branch with `update-ref <ref> <new> <old>`. git keeps a refused
  path out of the index by SKIPPING it with exit 0, so `applyCommit` reads the index back
  and refuses the request unless every planned path is there as planned. A new branch
  under an existing tag's name is refused; `withConnectionTrailer` adds the connection
  trailer to the message's own trailer block when it ends in one. The two gates of
  R-GS-23 (`--allow-commit`, the `write` scope) are checked in `server.ts` on every request. A path at or
  under a parent symlink or submodule is refused under every spelling that folds to it
  (`foldPath`: case, NFC, HFS-ignorable code points, NTFS trailing dots/spaces and stream
  suffixes). The repository is opened with `readRoutes.openRepo`, so a SHA-256 repository
  is a 400 as on the read routes. The body read has an idle bound (`COMMIT_BODY_IDLE_MS`,
  408 `idle`), which the spec's error table does not list.
