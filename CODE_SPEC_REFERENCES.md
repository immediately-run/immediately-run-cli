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
