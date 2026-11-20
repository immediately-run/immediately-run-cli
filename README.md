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

The zip's contents are exactly `git archive HEAD` (the tracked tree) plus the
manifest sidecar.

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
| `--bind` | `localhost` | `tailscale` serves HTTPS on this node's tailnet address to your own devices (below) |
| `--host` | this node's MagicDNS name | Hostname for `--bind tailscale` |
| `--cert` | `<host>.crt` beside the root, else minted by `tailscale cert` | TLS certificate for `--bind tailscale`; its `.key` sibling is the key |
| `--allow-login` | none | With `--bind tailscale`, also serve devices of this tailnet user (repeatable) |
| `--allow-push` | off | With `--bind tailscale`, let git clients push (fast-forward only, no branch deletes) |
| `--origin` | `https://immediately.run` | Allowed browser origin and deep-link base; the site's local-development mediator origin is admitted with it |
| `--origin-unsafe` | off | Allow an `--origin` outside the recognized set |
| `--json` | off | One JSON line on stdout: `{ endpoint, namespace, port, protocol, allowPush, allowCommit, links: [{ repo, url }] }`, plus `token` on `localhost` only |

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

### On your tailnet

```sh
# On the machine that holds the repositories:
npx @immediately-run/cli git-serve ~/repos --bind tailscale

# In a second terminal, to connect a browser on any of your devices:
npx @immediately-run/cli git-serve pair ~/repos
```

`pair` prints a one-time code. In the browser, open Settings, Local endpoints,
and enter the endpoint the server printed and the code. The link for a
repository then opens on every device you have connected; it carries no
endpoint and no credential.

- **Only your own devices are served.** For every request the server asks the
  local Tailscale daemon who owns the connecting address, and serves it only if
  that device is signed in as the same tailnet user as this machine (or one
  named with `--allow-login`). A tagged node, an address the daemon does not
  know, the machine's own address and a daemon that does not answer are each
  refused. Do not put `tailscale serve`, Funnel or another proxy in front: every
  request would then arrive from this machine itself and be refused.
- **A device is not enough for a browser.** A browser request also needs the
  token its pairing produced. The server prints no token on a tailnet.
- **A code** works once, for ten minutes, and dies after five wrong guesses from
  anyone. `pair --scope write` grants the `write` scope; the default is `read`.
- **`git-serve connections <root>`** lists the browsers that have paired, and
  `--revoke <id>` removes one: its next request fails. Tokens are stored hashed
  in `<root>/.git-serve/`.
- The namespace on a tailnet is derived from the endpoint
  (`<machine>-<20 hex>` over `https://<machine>.<tailnet>.ts.net:<port>`), so
  changing the port or the machine name makes a new one.
- Peer identity is device identity: every process and every OS user on a device
  signed in as you can reach the server.

### Plain git against the same server

On a tailnet the server also answers git's own HTTP protocol, so stock git
works from any of your devices, with no credential helper to set up:

```sh
git clone https://<machine>.<tailnet>.ts.net:7701/notes.git
```

- `git clone` and `git fetch` are always on for your own devices (the peer
  check above is the whole gate; there is no token on these routes).
- `git push` needs the server started with `--allow-push`. A push must be a
  fast-forward and cannot delete a branch. Rewriting a branch means doing it on
  the serving machine's disk.
- A repository's own config cannot turn push on, or force-pushes and deletes
  back on: the server sets `http.receivepack`, `receive.denyNonFastForwards`
  and `receive.denyDeletes` itself for every request.
- Only `/<name>.git/info/refs?service=…`, `/<name>.git/git-upload-pack` and
  `/<name>.git/git-receive-pack` are served. The file routes of the older
  "dumb" protocol are not.
- Nothing is created by pushing to a name that does not exist. Use
  `git-serve init`.
- A browser cannot use these routes: a request that carries an `Origin` or a
  `Sec-Fetch-*` header is refused, and no CORS header is ever sent.
- On `localhost` these routes do not exist: the repository is on the same disk,
  so push to its path.

## Verify (the CI/deploy gate)

`npm run verify` runs this repo's full CI gate in one command — `test` (build +
sidecar-literal check + the `node --test` suite) → `build`. Run it before pushing; it is
the same set of checks CI enforces, so a local green equals a green CI. (Ways of working
§4: the local verify gate must equal the deploy gate — one `npm run verify` per repo.)
