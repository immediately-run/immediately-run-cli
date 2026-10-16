import { builtinModules } from 'node:module';
import { decode as decodeMsgPack } from '@msgpack/msgpack';

import type { BundledPackage } from './lockset.js';

/**
 * Closure consistency (R3-1204): the zip must not ship content that imports a
 * dependency the resolved set omits.
 *
 * The build holds both halves in one function's hands — the `/dep_tree`
 * resolution (metadata-derived) and the bundled package content (what the
 * runtime will actually execute). @codemirror/language@6.13.0 published a
 * dist that imports `@codemirror/streamparser` while its package.json omits
 * the dependency (R3-1203): every editor verification on the venue broke,
 * and the cache-zip build shipped the disagreement as a working zip because
 * nothing compared the halves. This module is the comparison.
 *
 * Content evidence is read from the SAME wire format the runtime decodes —
 * the `ICDNModule` msgpack (`f` files, `m` the package-level dependency
 * list; only the SHAPE is shared across rails — a CDN package's `m` is the
 * producer's dist scan, a local build's is its declared deps + peers) —
 * for local-built and CDN-fetched packages alike (`encodeLocalPackage`
 * produces the CDN's shape verbatim), so there is one reader and no source
 * special-casing. A file entry's `.d` is the producer-computed require list:
 * a bare specifier there is a require the runtime WILL execute, and it is a
 * hard failure when the resolved set holds neither it nor an exemption. A
 * name in `.m` but no file's `.d` is warn-only: the sandbox's boot-time
 * rescue (R3-1203's fix) reconciles exactly the `m` list, so an `m`-named
 * miss degrades at boot while a `.d`-only miss the rescue never sees is the
 * one the build must refuse (the rescue partition, not a declared/imported
 * distinction, is what separates the two tiers).
 */

/** One dependency the resolved set (and the exemptions) does not cover. */
export interface ClosureFinding {
  /** The bundled package whose shipped content names the dependency. */
  name: string;
  version: string;
  /** The bare dependency name the content requires (or the undecodable
   *  marker, see below). */
  dependency: string;
  /** `import` — a `.d` require the runtime will execute (fails the build);
   *  `declared` — an `m`-only name (warns). */
  source: 'import' | 'declared';
}

/**
 * The bare package name a specifier resolves to, or null when it is not a
 * bare specifier: relative (`./x`, `../x`), absolute (`/x`), URL-scheme
 * (`https://…`, `node:…`) and Node-internal (`#internal`) forms never name a
 * registry package. A subpath (`react/jsx-runtime`) resolves to the package
 * root the runtime preloads; a scope takes two segments
 * (`@scope/pkg/sub` → `@scope/pkg`).
 */
export function bareDependencyName(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) return null; // node:fs, https://…, data:…
  if (specifier.startsWith('@')) {
    const [scope, pkg] = specifier.split('/');
    return pkg === undefined ? null : `${scope}/${pkg}`;
  }
  const [name] = specifier.split('/');
  return name === '' ? null : name;
}

/** The `ICDNModule` shape as decoded here — file entries are content objects
 *  or size-only numbers. Kept local and structural: the runtime's own type
 *  lives in the sandbox; this reader needs exactly these two fields. */
interface DecodedModule {
  f: Record<string, { d?: unknown } | number> | undefined;
  m: unknown | undefined;
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Report every bare dependency named by shipped content that neither the
 * resolved set nor an exemption holds.
 *
 * `resolvedNames` is the lockset's resolved package names. `exemptNames` is
 * the app-level other-rail set: the app's `registryResolved` self-hosted
 * names and `github:`-pinned deps (both resolve from mounts at boot, never
 * from the lockset). `peerImports` carries each locally-built package's OWN
 * peer dependencies, keyed by package name: a peer resolves against its
 * consumer's environment (the app's own react for the injected
 * react-error-boundary), so a package's import of its own peer is exempt FOR
 * THAT PACKAGE ONLY — a name-keyed global set would let one package's peer
 * mask a genuine miss inside another.
 *
 * Node builtins are exempt here — bare and `node:`-prefixed alike, because
 * the runtime stubs them (R3-411).
 */
export function closureFindings(
  packages: readonly BundledPackage[],
  resolvedNames: ReadonlySet<string>,
  exemptNames: ReadonlySet<string> = new Set(),
  peerImports: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ClosureFinding[] {
  const findings: ClosureFinding[] = [];
  for (const pkg of packages) {
    let decoded: unknown;
    try {
      decoded = decodeMsgPack(pkg.bytes);
    } catch (err) {
      findings.push(undecodableFinding(pkg, err));
      continue;
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      findings.push(undecodableFinding(pkg, new Error(`decoded to ${Array.isArray(decoded) ? 'an array' : String(decoded)}`)));
      continue;
    }
    const module = decoded as DecodedModule;
    const ownPeers = peerImports.get(pkg.name);
    // Pass 1 — the requires the runtime WILL execute (file entries' `.d`).
    const imported = new Set<string>();
    for (const entry of Object.values(module.f ?? {})) {
      if (entry === null || typeof entry === 'number') continue; // size-only entry
      for (const specifier of asStringArray(entry.d)) {
        if (specifier.startsWith('node:')) continue;
        const bare = bareDependencyName(specifier);
        if (bare === null || resolvedNames.has(bare) || isExempt(bare, exemptNames)) continue;
        if (ownPeers?.has(bare)) continue; // this package's own peer — npm semantics
        imported.add(bare);
      }
    }
    for (const bare of imported) {
      findings.push({ name: pkg.name, version: pkg.version, dependency: bare, source: 'import' });
    }
    // Pass 2 — the package-level import list (`m`) outside every file's `.d`:
    // warn-only, per the boot-rescue partition above. Non-bare entries
    // (`node:fs`, relative forms) are skipped by the same extraction pass 1
    // uses — they name nothing the lockset could hold.
    for (const name of asStringArray(module.m)) {
      const bare = bareDependencyName(name);
      if (bare === null) continue;
      if (imported.has(bare) || resolvedNames.has(bare) || isExempt(bare, exemptNames)) continue;
      if (ownPeers?.has(bare)) continue;
      findings.push({ name: pkg.name, version: pkg.version, dependency: bare, source: 'declared' });
    }
  }
  // One finding per (package, dependency): a `.d` and an `.m` naming the
  // same miss reports once, as the import it is.
  const seen = new Map<string, ClosureFinding>();
  for (const finding of findings) {
    const key = `${finding.name}|${finding.dependency}`;
    const prior = seen.get(key);
    if (!prior || (prior.source === 'declared' && finding.source === 'import')) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

const undecodableFinding = (pkg: BundledPackage, err: unknown): ClosureFinding => ({
  name: pkg.name,
  version: pkg.version,
  dependency: `<undecodable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}>`,
  source: 'import',
});

/** Node builtins arrive bare (`fs`) and prefixed (`node:fs`); both are
 *  stubbed by the runtime, so both are exempt regardless of the caller's
 *  set. */
const isExempt = (bare: string, exemptNames: ReadonlySet<string>): boolean =>
  exemptNames.has(bare) || exemptNames.has(`node:${bare}`) || builtinModules.includes(bare);

/** The one-line failure message for an `import`-source finding: package,
 *  version, missing dependency, remediation — or, for undecodable content,
 *  the fact the runtime would fail the same decode at preload. */
export const closureFailureMessage = (finding: ClosureFinding): string =>
  finding.dependency.startsWith('<undecodable')
    ? `closure inconsistency: ${finding.name}@${finding.version} bundled content is not decodable ICDNModule msgpack (${finding.dependency.slice('<undecodable: '.length, -1)}) — at preload the runtime would silently replace it with a live CDN fetch, defeating the zip; pin ${finding.name} to a version whose content serves, or refresh the CDN mirror`
    : `closure inconsistency: ${finding.name}@${finding.version} content imports ${finding.dependency}, but the resolved dependency set does not include it — pin ${finding.dependency} in the app's package.json or refresh the CDN mirror`;
