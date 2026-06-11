/*
 * UI releases — authoring/resolution model for the `pin-release` command
 * (UI_RELEASES_SPEC §3, §5). Mirrors the runtime schema in
 * immediately-run-site-main/src/registry/releaseLock.ts; the CLI keeps its own
 * copy (like RepoManifest) so it has no cross-package dependency.
 *
 * Flow: read sparse authoring files (`<name>.json`, with an optional `extends`
 * base) → flatten → resolve each `repo@ref` to an immutable commit via
 * `git ls-remote` → emit a fully-pinned `<name>.lock.json` plus a registry
 * `index.json` carrying each lock's sha-256 (the integrity anchor, R1).
 *
 * Locks are DETERMINISTIC (no wall-clock field) so their sha-256 is reproducible
 * and "immutable by name" is enforceable: re-pinning a name to different content
 * is refused unless --republish.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RELEASE_SCHEMA_VERSION = 1 as const;

const COMMIT_RE = /^[0-9a-f]{40}$/i;

// ---- canonical binding id (mirror of site-main bindingId.ts) ---------------

export interface BindingId {
  provider: string;
  namespace: string;
  repository: string;
  ref?: string;
  commit?: string;
}

export const parseBindingId = (s: string): BindingId => {
  const colon = s.indexOf(':');
  if (colon <= 0) throw new Error(`bindingId: missing provider in "${s}"`);
  const provider = s.slice(0, colon);
  let rest = s.slice(colon + 1);
  let commit: string | undefined;
  let ref: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    commit = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (!COMMIT_RE.test(commit)) throw new Error(`bindingId: bad commit "${commit}"`);
  }
  const at = rest.indexOf('@');
  if (at >= 0) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!ref) throw new Error(`bindingId: empty ref in "${s}"`);
  }
  const path = rest.split('/').filter(Boolean);
  if (path.length < 2) throw new Error(`bindingId: need namespace/repository in "${s}"`);
  const repository = path.pop()!;
  const namespace = path.join('/');
  return { provider, namespace, repository, ref, commit };
};

/** Repo-scope id `provider:namespace/repository` (no ref/commit). */
export const appKey = (b: BindingId): string =>
  `${b.provider}:${b.namespace}/${b.repository}`;

// ---- authoring + lock schema ----------------------------------------------

/** A sparse authoring file: `<name>.json`. */
export interface ReleaseAuthoring {
  id: string;
  label?: string;
  /** Single-level base to inherit `apps` from (overlay wins per region). */
  extends?: string;
  /** region id → canonical id string `provider:ns/repo[@ref]`. */
  apps: Record<string, string>;
}

export interface ReleaseLockEntry {
  repo: string;
  ref?: string;
  commit: string;
}

export interface ReleaseLock {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  id: string;
  label?: string;
  apps: Record<string, ReleaseLockEntry>;
}

export interface ReleaseIndexEntry {
  label?: string;
  url: string;
  sha256: string;
  publishedAt?: number;
}

export interface ReleaseIndex {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  releases: Record<string, ReleaseIndexEntry>;
}

// ---- flatten + resolve -----------------------------------------------------

/**
 * Flatten an authoring file against its `extends` base (overlay wins per
 * region). Single-level only; a base that itself `extends` is an error.
 * `canonicalRegions` (the base release's region set) bounds every overlay — an
 * overlay may only repoint regions the base defines (R3 at authoring time).
 */
export const flattenAuthoring = (
  authoring: ReleaseAuthoring,
  bases: Map<string, ReleaseAuthoring>,
): Record<string, string> => {
  if (!authoring.extends) return { ...authoring.apps };
  const base = bases.get(authoring.extends);
  if (!base) {
    throw new Error(`release "${authoring.id}" extends unknown base "${authoring.extends}"`);
  }
  if (base.extends) {
    throw new Error(
      `release "${authoring.id}" extends "${base.id}", which itself extends "${base.extends}" (single-level only)`,
    );
  }
  const baseRegions = new Set(Object.keys(base.apps));
  for (const region of Object.keys(authoring.apps)) {
    if (!baseRegions.has(region)) {
      throw new Error(
        `release "${authoring.id}" overlays region "${region}" absent from base "${base.id}"`,
      );
    }
  }
  return { ...base.apps, ...authoring.apps };
};

// ── §5 step-3a publish-time lint (UI_RELEASES_SPEC §6.1b) ───────────────────
//
// Warn (never block) when a release entry repoints a region OFF its build-default
// repo scope whose ceiling carries first-party-only capabilities — those caps are
// STRIPPED at resolution (host §6.1b), so the region runs with reduced powers and
// the author should know. The build-default repo + first-party-only ceiling live
// in the host (`immediately-run-site-main`), so the CLI takes them as an injected
// manifest. Empty manifest ⇒ no warnings — the shipped registry's first-party-only
// set is empty as of R3-33d, so this is vacuous until a cap is first-party-only
// again (or the host exports its manifest to the CLI). Pure + unit-tested.

/** A region's build-default reference, for the strip lint. */
export interface BuildDefaultRef {
  /** Repo SCOPE (`provider:namespace/repository`) of the region's build default. */
  repo: string;
  /** The first-party-only capabilities in the region's build-default ceiling. */
  firstPartyOnlyCaps: string[];
}

/** One lint warning: a repoint that will strip first-party-only caps at resolve. */
export interface StripWarning {
  release: string;
  region: string;
  strippedCaps: string[];
  fromRepo: string;
  toRepo: string;
}

/**
 * The §6.1b strip warnings for a set of flattened releases (`release id → region →
 * binding id`), given the host's build-default manifest. A warning fires when an
 * entry repoints a region (different repo SCOPE) whose build-default ceiling has
 * first-party-only caps. Pure.
 */
export const firstPartyStripWarnings = (
  flattened: Record<string, Record<string, string>>,
  buildDefaults: Record<string, BuildDefaultRef>,
): StripWarning[] => {
  const warnings: StripWarning[] = [];
  for (const [release, regions] of Object.entries(flattened)) {
    for (const [region, id] of Object.entries(regions)) {
      const def = buildDefaults[region];
      if (!def || def.firstPartyOnlyCaps.length === 0) continue;
      let toRepo: string;
      try {
        toRepo = appKey(parseBindingId(id));
      } catch {
        continue; // unparseable ids are caught by the structural validator
      }
      if (toRepo === def.repo) continue; // same repo scope → not a repoint, no strip
      warnings.push({
        release,
        region,
        strippedCaps: [...def.firstPartyOnlyCaps],
        fromRepo: def.repo,
        toRepo,
      });
    }
  }
  return warnings;
};

/** Resolve a single mutable ref to an immutable commit via `git ls-remote`. */
export const resolveRemoteCommit = (binding: BindingId): string => {
  if (binding.commit) return binding.commit.toLowerCase();
  if (binding.provider !== 'github') {
    throw new Error(
      `pin-release: provider "${binding.provider}" is not supported yet (only github)`,
    );
  }
  const ref = binding.ref ?? 'main';
  if (COMMIT_RE.test(ref)) return ref.toLowerCase();
  const url = `https://github.com/${binding.namespace}/${binding.repository}.git`;
  let out: string;
  try {
    out = execFileSync('git', ['ls-remote', url, ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pin-release: git ls-remote failed for ${url} ${ref}: ${msg}`);
  }
  const lines = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, name] = l.split('\t');
      return { sha: sha!, name: name ?? '' };
    });
  const pick =
    // annotated tag → its dereferenced commit
    lines.find((l) => l.name === `refs/tags/${ref}^{}`) ??
    // branch
    lines.find((l) => l.name === `refs/heads/${ref}`) ??
    // lightweight tag
    lines.find((l) => l.name === `refs/tags/${ref}`) ??
    // exact ref or single result
    lines.find((l) => l.name === ref) ??
    (lines.length === 1 ? lines[0] : undefined);
  if (!pick || !COMMIT_RE.test(pick.sha)) {
    throw new Error(
      `pin-release: could not resolve ${binding.namespace}/${binding.repository}@${ref} to a commit`,
    );
  }
  return pick.sha.toLowerCase();
};

/** Resolve a flattened authoring app-map into a fully-pinned lock. */
export const resolveLock = (
  authoring: ReleaseAuthoring,
  flatApps: Record<string, string>,
  resolver: (b: BindingId) => string = resolveRemoteCommit,
): ReleaseLock => {
  const apps: Record<string, ReleaseLockEntry> = {};
  for (const region of Object.keys(flatApps).sort()) {
    const binding = parseBindingId(flatApps[region]!);
    const commit = resolver(binding);
    apps[region] = {
      repo: appKey(binding),
      ...(binding.ref ? { ref: binding.ref } : {}),
      commit,
    };
  }
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    id: authoring.id,
    ...(authoring.label ? { label: authoring.label } : {}),
    apps,
  };
};

// ---- serialization + integrity --------------------------------------------

/** Deterministic JSON for a lock: stable key order, 2-space indent, trailing \n. */
export const serializeLock = (lock: ReleaseLock): string => {
  const ordered: ReleaseLock = {
    schemaVersion: lock.schemaVersion,
    id: lock.id,
    ...(lock.label ? { label: lock.label } : {}),
    apps: Object.fromEntries(
      Object.keys(lock.apps)
        .sort()
        .map((region) => {
          const e = lock.apps[region]!;
          return [region, { repo: e.repo, ...(e.ref ? { ref: e.ref } : {}), commit: e.commit }];
        }),
    ),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
};

export const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Build the registry index from a set of {name → {lockText, label}} entries. */
export const buildIndex = (
  locks: { id: string; lockText: string; label?: string; publishedAt?: number }[],
): ReleaseIndex => {
  const releases: Record<string, ReleaseIndexEntry> = {};
  for (const { id, lockText, label, publishedAt } of locks.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    releases[id] = {
      ...(label ? { label } : {}),
      url: `${id}.lock.json`,
      sha256: sha256Hex(lockText),
      ...(publishedAt ? { publishedAt } : {}),
    };
  }
  return { schemaVersion: RELEASE_SCHEMA_VERSION, releases };
};

export const serializeIndex = (index: ReleaseIndex): string =>
  JSON.stringify(index, null, 2) + '\n';
