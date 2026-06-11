import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ManifestEntry } from './manifest.js';

export const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;

export const git = (repo: string, args: string[]): string =>
  // stderr piped (not inherited) so expected failures — e.g. a missing
  // origin/HEAD in defaultBranchOf — don't leak to the terminal; on throw Node
  // still attaches stderr to the error.
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const isGitRepo = (repo: string): boolean =>
  existsSync(join(repo, '.git'));

// Strip embedded credentials from a git remote URL before it leaves loopback
// (LOCAL_DEVELOPMENT_SPEC §6.3, LD2-2). A remote can carry a token in its
// userinfo (`https://user:ghp_xxx@github.com/…`). Rule: if it parses as a URL
// with a userinfo component, remove the ENTIRE userinfo (username AND password);
// an scp-like `user@host:path` (no scheme → not a URL) carries only a bare
// username — no secret — and passes through; anything else passes unchanged. The
// raw string is never serialized onto a response.
export const stripRemoteCredentials = (remote: string): string => {
  let u: URL;
  try {
    u = new URL(remote);
  } catch {
    return remote; // scp-like or non-URL → no userinfo secret to strip
  }
  if (!u.username && !u.password) return remote;
  u.password = '';
  u.username = '';
  return u.href;
};

// Accepts git@github.com:owner/repo(.git) and https://github.com/owner/repo(.git)
export const parseOwnerRepo = (
  remoteUrl: string,
): { owner: string; repository: string } | null => {
  const m = remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1]!, repository: m[2]! };
};

// refs/remotes/origin/HEAD -> main. Absent on shallow CI checkouts; callers
// pass --default-branch explicitly there.
export const defaultBranchOf = (repo: string, fallback: string): string => {
  try {
    const ref = git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return ref.replace(/^refs\/remotes\/origin\//, '');
  } catch {
    return fallback;
  }
};

export const currentBranch = (repo: string): string =>
  git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);

export const headCommitSha = (repo: string): string =>
  git(repo, ['rev-parse', 'HEAD']);

export const headTreeSha = (repo: string): string =>
  git(repo, ['rev-parse', 'HEAD^{tree}']);

// Parse `git ls-tree -r -z --long HEAD` into manifest entries. -z disables path
// quoting; --long adds the object size. Submodules appear as type `commit`.
export const treeEntries = (repo: string): ManifestEntry[] =>
  git(repo, ['ls-tree', '-r', '-z', '--long', 'HEAD'])
    .split('\0')
    .filter(Boolean)
    .map((record): ManifestEntry => {
      const m = record.match(/^(\S+) (\S+) (\S+)\s+(\S+)\t(.*)$/s);
      if (!m) throw new Error(`Unparseable ls-tree record: ${JSON.stringify(record)}`);
      const [, mode, type, sha, sizeStr, entryPath] = m;
      const entry: ManifestEntry = {
        path: entryPath!,
        mode: mode!,
        type: type as ManifestEntry['type'],
        sha: sha!,
      };
      if (/^\d+$/.test(sizeStr!)) entry.size = Number(sizeStr);
      return entry;
    })
    .filter((e) => e.type === 'blob' || e.type === 'commit')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
