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
