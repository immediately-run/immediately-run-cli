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
 * the `ICDNModule` msgpack (`f` files, `m` externals) — for local-built and
 * CDN-fetched packages alike (`encodeLocalPackage` produces the CDN's shape
 * verbatim), so there is one reader and no source special-casing. A file
 * entry's `.d` is the producer-computed require list: a bare specifier there
 * is a require the runtime WILL execute, and it is a hard failure when the
 * resolved set holds neither it nor an exemption. A name only in `.m` is
 * declared-but-unimported — peers and lazily-required optionals live there —
 * so it warns, never fails.
 */

/** One dependency the resolved set (and the exempt set) does not cover. */
export interface ClosureFinding {
  /** The bundled package whose shipped content names the dependency. */
  name: string;
  version: string;
  /** The bare dependency name the content requires (or declares). */
  dependency: string;
  /** `import` — a `.d` require the runtime will execute (fails the build);
   *  `declared` — an `.m`-only name (warns). */
  source: 'import' | 'declared';
}

/**
 * The bare package name a specifier resolves to, or null when it is not a
 * bare specifier: relative (`./x`, `../x`), absolute (`/x`), and URL-scheme
 * (`https://…`, `node:…`) forms never name a registry package. A subpath
 * (`react/jsx-runtime`) resolves to the package root the runtime preloads;
 * a scope takes two segments (`@scope/pkg/sub` → `@scope/pkg`).
 */
export function bareDependencyName(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return null;
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
 * resolved set nor the exempt set holds.
 *
 * `resolvedNames` is the lockset's resolved package names. `exemptNames` is
 * the other-rail set the venue provides by another route: the app's
 * `registryResolved` self-hosted names and `github:`-pinned deps (both
 * resolve from mounts at boot, never from the lockset). Node builtins are
 * exempt here — the `node:` prefix and `builtinModules` alike, because the
 * runtime stubs them (R3-411).
 */
export function closureFindings(
  packages: readonly BundledPackage[],
  resolvedNames: ReadonlySet<string>,
  exemptNames: ReadonlySet<string> = new Set(),
): ClosureFinding[] {
  const findings: ClosureFinding[] = [];
  for (const pkg of packages) {
    let decoded: DecodedModule;
    try {
      decoded = decodeMsgPack(pkg.bytes) as DecodedModule;
    } catch (err) {
      // Undecodable bytes are a finding about the package, not a skip: the
      // runtime would fail the same decode at preload.
      findings.push({
        name: pkg.name,
        version: pkg.version,
        dependency: `<undecodable content: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}>`,
        source: 'import',
      });
      continue;
    }
    // Pass 1 — the requires the runtime WILL execute (file entries' `.d`).
    const imported = new Set<string>();
    for (const entry of Object.values(decoded.f ?? {})) {
      if (entry === null || typeof entry === 'number') continue; // size-only entry
      for (const specifier of asStringArray(entry.d)) {
        const bare = bareDependencyName(specifier);
        if (bare === null || isExempt(bare, exemptNames)) continue;
        imported.add(bare);
        if (!resolvedNames.has(bare)) {
          findings.push({ name: pkg.name, version: pkg.version, dependency: bare, source: 'import' });
        }
      }
    }
    // Pass 2 — declared-but-unimported externals (`.m`): warn-only, and a
    // name pass 1 already covered as an import stays an import finding.
    for (const name of asStringArray(decoded.m)) {
      const bare = bareDependencyName(name) ?? name;
      if (imported.has(bare) || resolvedNames.has(bare) || isExempt(bare, exemptNames)) continue;
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

/** Node builtins arrive bare (`fs`) and prefixed (`node:fs`); both are
 *  stubbed by the runtime, so both are exempt regardless of the caller's
 *  set. */
const isExempt = (bare: string, exemptNames: ReadonlySet<string>): boolean =>
  exemptNames.has(bare) || exemptNames.has(`node:${bare}`) || builtinModules.includes(bare);

/** The one-line failure message for an `import`-source finding, exactly as
 *  the item prescribes: package, version, missing dependency, remediation. */
export const closureFailureMessage = (finding: ClosureFinding): string =>
  `closure inconsistency: ${finding.name}@${finding.version} content imports ${finding.dependency}, but the resolved dependency set does not include it — pin ${finding.dependency} in the app's package.json or refresh the CDN mirror`;
