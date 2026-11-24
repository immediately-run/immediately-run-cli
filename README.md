# @immediately-run/cli

Command-line tools for [immediately.run](https://immediately.run).

## Install

```sh
npm i -g @immediately-run/cli
# or run without installing:
npx @immediately-run/cli <command>
```

## `cache-zip`

Build a **cached repository zip** from a local git checkout. immediately.run can
load a repo from this zip instead of the GitHub REST API — which is faster and
avoids anonymous rate limits — and still contribute changes back to GitHub,
because the zip embeds a contribute-manifest sidecar
(`.immediately.run/contribute-manifest.json`) carrying the git blob SHAs the
contribute flow needs.

```sh
# From inside a checkout — everything is inferred from git:
npx @immediately-run/cli cache-zip

# Explicit (e.g. in CI, where the checkout may be shallow):
npx @immediately-run/cli cache-zip \
  --owner my-org \
  --repo my-app \
  --ref main \
  --default-branch main \
  --out cached_repositories/main.zip
```

| Option | Default | Description |
| --- | --- | --- |
| `[repo-path]` | cwd | Path to the local git checkout |
| `--owner` | from `origin` remote | Repository owner / namespace |
| `--repo` | from `origin` remote | Repository name |
| `--ref` | current branch | Ref to cache; also the default output filename |
| `--default-branch` | `origin/HEAD` | Repository default branch |
| `--out` | `public/cached_repositories/<owner>/<repo>/<ref>.zip` | Output zip path |
| `--bundle-packages` | off | Bundle the resolved dependency content into the zip (requires the lockset) |
| `--no-prune-packages` | pruning on | With `--bundle-packages`: ship every bundled package whole |

The zip's contents are exactly `git archive HEAD` (the tracked tree) plus the
manifest sidecar.

#### Bundled packages are pruned to what the app reaches

With `--bundle-packages`, a package file is inlined only if an import can reach
it: the walk starts at the specifiers the app's own sources import (plus the
ones the platform always requires, such as `react-dom/client`) and follows each
bundled file's own requires, across packages. Any other JavaScript file is
listed by its size instead of its content, which is the dependency CDN's own
form for a file it does not inline. The runtime still resolves such a file and
fetches it on demand, so the cost of a file the walk missed is one network
request when it is first required, not a missing module.

Pruning leaves a package untouched when it cannot reason about it, and the
summary line says so: the platform-injected packages (`core-js`,
`react-refresh`, `react-error-boundary`), a package with no readable
`package.json`, one that no import reaches, and one that uses `#imports`. It
stands down for the whole zip when the app's import list is incomplete: with
`--no-artifacts`, when a source file produced no artifact (a transform error or
a dynamic import with a computed specifier), or when the app mounts a library
through `resolveFromRegistry` or a git dependency. Pass `--no-prune-packages`
to ship every package whole.

### Hosting & discovery

immediately.run looks for a repo's cache zip on the repo's own **GitHub Pages**
at:

```
https://<owner>.github.io/<repo>/cached_repositories/<ref>.zip
```

GitHub Pages serves with permissive CORS, so the client can fetch it
cross-origin. The [new-project-template](https://github.com/immediately-run/new-project-template)
ships a GitHub Action that runs `cache-zip` on every push to `main` and deploys
the result to Pages. A `404` (no cache) transparently falls back to the GitHub
API.

Requires the `git` and `zip` binaries on `PATH` (both present on GitHub-hosted
runners).

## `preauth`

Apply an **M1 pre-authorization policy** to an app from the terminal (operator /
CI), so a later headless / `immediately.run dev` / CI run boots with **no consent
prompt** (UI_AS_APPS_SPEC §8.15 M1 / §8.9). It is a thin token-authenticated HTTP
client of the backend `POST /api/v1/preauth` executor, which runs the **same**
§8.9 target check + grant-mint path the in-browser surface uses — the CLI holds no
credentials and no grant logic of its own.

```bash
# pre-grant net:fetch + a host for an app, for the signed-in user behind <idToken>
npx @immediately-run/cli preauth github__acme__headless-runner \
  --capabilities net:fetch \
  --net-fetch https://api.example.com \
  --token "$IMMEDIATELY_RUN_ID_TOKEN"

# or drive it from a policy file: { appKey?, capabilities[], mounts?, netFetchHosts? }
npx @immediately-run/cli preauth github__acme__headless-runner --policy preauth.json
```

The ID token may be passed with `--token` or the `IMMEDIATELY_RUN_ID_TOKEN`
environment variable. The endpoint is `https://immediately.run` by default
(`--origin` to override; non-immediately.run/loopback/preview origins need
`--origin-unsafe`).

**The operator principal** (decided 2026-10-01, TRUST_AND_SAFETY TS-13): the
token is the **operator's own** ID token. Once the backend enforces the operator
gate (`PREAUTH_OPERATOR_REQUIRED=1`), the account behind the token must carry
the `operator` Firebase custom claim or the backend answers 403. An operator
mints the claim on their own account once, in the
[`immediately-run-backend`](https://github.com/immediately-run/immediately-run-backend)
repo: `npm run set-operator-claim -- --uid=<operatorUid>`. See
`preauth --help` for the same note in the command itself.

**Security:** an over-broad (broad-elevated) or unknown capability makes the
backend refuse the **whole** policy (HTTP 422) and mint **nothing** — the command
prints each `{capability, reason}` and **exits non-zero**, so a CI step fails on a
bad policy. Exit codes: `0` applied · `1` refused / mint failed · `2` usage/auth
error · `3` rate-limited / server / network.

## `git-serve`

Serve a directory of **bare git repositories** on this machine to hosted
immediately.run. The page mounts a repository read-only at a real commit, with
no GitHub and no forge in between. Only committed objects are served; no
working tree is read (that is `dev`'s job).

```sh
# Create a repository under a root directory, then push to it with plain git:
npx @immediately-run/cli git-serve init ~/repos notes
git -C ~/code/notes push ~/repos/notes.git main

# Serve every repository under the root and print a link for each:
npx @immediately-run/cli git-serve ~/repos
```

| Option | Default | Description |
| --- | --- | --- |
| `<root>` | required | Directory holding the repositories, each `<root>/<name>.git` |
| `--port` | `7701` | Port to listen on (differs from `dev`'s, so both can run) |
| `--bind` | `localhost` | `tailscale` is not available yet |
| `--origin` | `https://immediately.run` | Allowed browser origin and deep-link base; the site's local-development mediator origin is admitted with it |
| `--origin-unsafe` | off | Allow an `--origin` outside the recognized set |
| `--json` | off | One JSON line on stdout: `{ endpoint, namespace, port, protocol, allowPush, allowCommit, token, links: [{ repo, url }] }` |

What it serves, to a request that carries the session token:

```
GET /meta                          the repositories under the root
GET /meta?repo=<r>                 default branch, branches, tags
GET /meta?repo=<r>&ref=<ref>       the commit and tree a ref names
GET /tree?repo=<r>&ref=<ref>       that commit's whole tree: path, mode, blob SHA, size
GET /blob?repo=<r>&sha=<blobSha>   one blob's bytes
```

- A **repository is a name**, never a path: letters, digits, `_` and `-`. A
  symlinked repository, a nested one, and one that borrows objects through
  `objects/info/alternates` are not served.
- A **ref is a branch, a tag or a 40-hex commit**, looked up exactly. No
  revision expression (`HEAD~1`, `a..b`, `x^{tree}`) is evaluated.
- The **namespace** in the link (`localhost-<20 hex>`) is derived from an id
  kept in `<root>/.git-serve/`. Deleting that directory gives the root's
  repositories a new namespace on the host, with new grants and a fresh overlay.
- Every request must come from the allowed origin (an `Origin` header is
  required), name the server's own host and port, and carry the token in
  `Authorization`. The token is minted per start and is not accepted in a URL.
- A blob stays readable by its SHA for as long as git keeps the object, even
  after the branch that held it moved on. A secret that was ever committed is
  served to a token holder.

## Verify (the CI/deploy gate)

`npm run verify` runs this repo's full CI gate in one command — `test` (build +
sidecar-literal check + the `node --test` suite) → `build`. Run it before pushing; it is
the same set of checks CI enforces, so a local green equals a green CI. (Ways of working
§4: the local verify gate must equal the deploy gate — one `npm run verify` per repo.)
