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
(`.tinkerable/contribute-manifest.json`) carrying the git blob SHAs the
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
CI), so a later headless / `immediately-run dev` / CI run boots with **no consent
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

**Security:** an over-broad (broad-elevated) or unknown capability makes the
backend refuse the **whole** policy (HTTP 422) and mint **nothing** — the command
prints each `{capability, reason}` and **exits non-zero**, so a CI step fails on a
bad policy. Exit codes: `0` applied · `1` refused / mint failed · `2` usage/auth
error · `3` rate-limited / server / network.
