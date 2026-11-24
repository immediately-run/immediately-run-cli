/*
 * Prune bundled dependency CONTENT down to what the app can reach.
 *
 * WHY. `--bundle-packages` ships each resolved package as its whole `ICDNModule`: every
 * entry point of every `exports` condition, with content. That is the safe answer to "which
 * file will the runtime ask for" when nothing is known about the asker, and it is expensive
 * in the one place it is paid over and over: the zip is downloaded by every viewer, mounted
 * in the host's filesystem, and decoded again inside each sandbox frame. A measured tab held
 * react-dom's server, edge, bun, profiling and test-utils builds as bytes in two processes
 * and as decoded source in a third, and executed none of them.
 *
 * Here the asker IS known. The same build holds the app's own import list (the artifact
 * index records every specifier the transpiler collected) and each bundled file's
 * producer-computed require list (`d`). Walking from the first through the second gives the
 * set of files a boot can touch.
 *
 * WHAT PRUNING DOES — AND DOES NOT. A file outside that set is DEMOTED to its byte size,
 * never removed. A numeric entry is the CDN's own "listed, not inlined" form, which the
 * runtime already resolves against and fetches on demand (`RegistryFS.getContent`), so a
 * wrong demotion costs one network fetch at the moment the file is first required. It does
 * not cost a missing module. That asymmetry is what makes this safe to do from a static
 * walk, and every rule below is chosen to keep an error on that side:
 *
 *   · only JavaScript is demoted. A stylesheet or JSON file reached by a route this walk
 *     does not model (a CSS `@import`, a `fetch`) stays inlined, and so does every
 *     `package.json`, which the resolver reads before it knows what it wants;
 *   · a specifier resolves to EVERY file it could name, under any `exports` condition and
 *     any extension, exactly as `buildLocalPackage` does and for the reason written there;
 *   · a package this walk cannot reason about is left byte-for-byte as it arrived: no
 *     readable `package.json`, an entry that resolves to nothing, an internal `#import`, or
 *     no route to it at all;
 *   · the packages the PLATFORM enters are never pruned (see `neverPrune`).
 */
import { posix } from 'node:path';
import { decode as decodeMsgPack, encode as encodeMsgPack } from '@msgpack/msgpack';

import { bareDependencyName } from './closureConsistency.js';
import { MAIN_FIELDS, RUNTIME_EXTENSIONS, SKIP_CONDITIONS } from './localPackageSource.js';
import type { BundledPackage } from './lockset.js';

/**
 * Specifiers the PLATFORM requires from the app's own packages, whatever the app imports.
 *
 * The self-hosted SDK is fetched at boot rather than transpiled here, so its imports are in
 * no artifact index: it requires `react` and `react-dom/client` (and `react-error-boundary`,
 * which is platform-injected and never pruned). The sandbox's boot-default entry imports
 * `react-dom/client` too, and the automatic JSX runtime is what the transpiler emits for a
 * file edited in-session, which no build-time index can list. Seeding these always is the
 * difference between a pruned zip that boots from memory and one that fetches React's entry
 * from the network because this particular app happened to import only a subpath.
 */
export const PLATFORM_SPECIFIERS: readonly string[] = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
]);

/** Only JavaScript is ever demoted; see the header. */
const JS_RE = /\.(c|m)?js$/;

interface ContentEntry {
  c: string;
  d?: unknown;
  t?: unknown;
}
type FileEntry = ContentEntry | number;
interface DecodedModule {
  f: Record<string, FileEntry>;
  m?: unknown;
}

const hasContent = (entry: FileEntry | undefined): entry is ContentEntry =>
  typeof entry === 'object' && entry !== null && typeof entry.c === 'string';

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Every string target under an `exports`/`imports` node, in any condition worth seeding. */
function collectTargets(node: unknown, condition: string | null, out: string[]): void {
  if (typeof node === 'string') {
    if (condition === null || !SKIP_CONDITIONS.has(condition)) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectTargets(item, condition, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // A nested condition inside a skipped one stays skipped, as in `entryPoints`.
    collectTargets(value, SKIP_CONDITIONS.has(condition ?? '') ? condition : key, out);
  }
}

/** One decoded package, with the walk's state. */
class PackageState {
  readonly files: Record<string, FileEntry>;
  readonly manifest: Record<string, unknown> | null;
  /** Content-carrying files the walk reached. */
  readonly kept = new Set<string>();
  /** Set when the package must ship exactly as it arrived. */
  verbatim = false;

  constructor(
    readonly pkg: BundledPackage,
    readonly decoded: DecodedModule,
  ) {
    this.files = decoded.f;
    const manifest = this.files['package.json'];
    let parsed: Record<string, unknown> | null = null;
    if (hasContent(manifest)) {
      try {
        const value = JSON.parse(manifest.c) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    this.manifest = parsed;
  }

  /**
   * EVERY listed file a package-relative path could name: itself, with each runtime
   * extension, as a directory index, or through a nested `package.json`. Listed, not just
   * inlined: a size-only hit still counts as "this resolves", which is what tells a real
   * entry point from a specifier this walk has misread.
   */
  candidates(rel: string): string[] {
    const base = posix.normalize(rel).replace(/^\.\//, '').replace(/\/$/, '');
    if (base === '' || base === '.' || base.startsWith('..')) return [];
    const exts = ['', ...RUNTIME_EXTENSIONS];
    const names = [...exts.map((e) => `${base}${e}`), ...exts.map((e) => `${base}/index${e}`)];
    const nested = this.files[`${base}/package.json`];
    if (hasContent(nested)) {
      try {
        const own = JSON.parse(nested.c) as Record<string, unknown>;
        for (const field of MAIN_FIELDS) {
          const v = own[field];
          if (typeof v === 'string') names.push(...this.candidateNames(posix.join(base, v)));
        }
      } catch {
        /* an unparseable nested manifest names nothing */
      }
    }
    return [...new Set(names)].filter((name) => this.files[name] !== undefined);
  }

  private candidateNames(rel: string): string[] {
    const base = posix.normalize(rel).replace(/^\.\//, '');
    const exts = ['', ...RUNTIME_EXTENSIONS];
    return [...exts.map((e) => `${base}${e}`), ...exts.map((e) => `${base}/index${e}`)];
  }

  /**
   * The files `import "<name>/<subpath>"` could load, or null when none can be named.
   * `subpath` is `''` for the package root.
   */
  entryFiles(subpath: string): string[] | null {
    const manifest = this.manifest;
    if (!manifest) return null;
    const targets: string[] = [];
    const exportsField = manifest.exports;
    const keyed =
      exportsField !== null &&
      typeof exportsField === 'object' &&
      !Array.isArray(exportsField) &&
      Object.keys(exportsField as object).some((key) => key.startsWith('.'));

    if (subpath === '') {
      for (const field of MAIN_FIELDS) {
        const v = manifest[field];
        if (typeof v === 'string') targets.push(v);
      }
      if (!MAIN_FIELDS.some((field) => typeof manifest[field] === 'string')) targets.push('index.js');
      if (keyed) collectTargets((exportsField as Record<string, unknown>)['.'], null, targets);
      else collectTargets(exportsField, null, targets);
    } else {
      // The path itself is always tried: the resolver's general path reaches a file a
      // subpath names directly, with or without an `exports` map in the way.
      targets.push(subpath);
      if (keyed) {
        const wanted = `./${subpath}`;
        for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
          if (key === wanted) {
            collectTargets(value, null, targets);
          } else if (key.includes('*')) {
            // `"./icons/*": "./dist/icons/*.js"` — the captured segment substitutes into
            // every target under the key.
            const [before, after = ''] = key.split('*');
            if (wanted.startsWith(before) && wanted.endsWith(after) && wanted.length >= before.length + after.length) {
              const captured = wanted.slice(before.length, wanted.length - after.length);
              const patterns: string[] = [];
              collectTargets(value, null, patterns);
              for (const pattern of patterns) targets.push(pattern.split('*').join(captured));
            }
          } else if (key.endsWith('/') && wanted.startsWith(key)) {
            // The legacy directory form: `"./lib/": "./dist/lib/"`.
            const prefixes: string[] = [];
            collectTargets(value, null, prefixes);
            for (const prefix of prefixes) targets.push(posix.join(prefix, wanted.slice(key.length)));
          }
        }
      }
    }

    const found = new Set<string>();
    for (const target of targets) for (const file of this.candidates(target)) found.add(file);
    return found.size ? [...found] : null;
  }

  /**
   * The `browser` field as a REPLACEMENT MAP (`{"./node.js": "./browser.js"}`) redirects
   * files after resolution, by rules this walk does not reproduce. Its targets are few, so
   * every one of them is kept whenever the package is entered at all.
   */
  browserReplacements(): string[] {
    const browser = this.manifest?.browser;
    if (!browser || typeof browser !== 'object' || Array.isArray(browser)) return [];
    const out = new Set<string>();
    for (const value of Object.values(browser as Record<string, unknown>)) {
      if (typeof value === 'string') for (const file of this.candidates(value)) out.add(file);
    }
    return [...out];
  }
}

export interface PruneOptions {
  /**
   * Bare specifiers the app's own sources import, or null when they are not known. Null
   * prunes nothing: without the app's side of the graph there is no walk to do.
   */
  appSpecifiers: readonly string[] | null;
  /**
   * Package names that ship exactly as they arrived, and whose every file is treated as
   * reachable when following edges into other packages. This is how the platform-injected
   * set is handled: `react-refresh`, `core-js` and `react-error-boundary` are required by
   * the transpiler's OUTPUT and by the sandbox runtime, including for files transpiled live
   * in a session, so no build-time import list bounds what they are asked for.
   */
  neverPrune?: ReadonlySet<string>;
}

export interface PruneResult {
  packages: BundledPackage[];
  bytesBefore: number;
  bytesAfter: number;
  /** Packages that had at least one file demoted. */
  prunedPackages: number;
  /** Files demoted from content to a size. */
  demotedFiles: number;
  /** Why nothing was attempted, when nothing was. */
  skippedReason?: string;
}

const totalBytes = (packages: readonly BundledPackage[]): number =>
  packages.reduce((sum, p) => sum + p.bytes.byteLength, 0);

/**
 * Demote every JavaScript file no route from the app reaches. Pure: the same packages and
 * the same specifiers produce the same bytes, and a package with nothing to demote is
 * returned as the very object it came in as.
 */
export function pruneBundledPackages(packages: readonly BundledPackage[], opts: PruneOptions): PruneResult {
  const bytesBefore = totalBytes(packages);
  const untouched = (skippedReason: string): PruneResult => ({
    packages: [...packages],
    bytesBefore,
    bytesAfter: bytesBefore,
    prunedPackages: 0,
    demotedFiles: 0,
    skippedReason,
  });
  if (opts.appSpecifiers === null) return untouched('the app import list is not known');

  const states = new Map<string, PackageState>();
  for (const pkg of packages) {
    let decoded: unknown;
    try {
      decoded = decodeMsgPack(pkg.bytes);
    } catch {
      continue; // undecodable content is the closure check's finding, not ours to rewrite
    }
    const module = decoded as DecodedModule | null;
    if (!module || typeof module !== 'object' || Array.isArray(module)) continue;
    if (!module.f || typeof module.f !== 'object' || Array.isArray(module.f)) continue;
    // One state per NAME. Two versions of one name is a lockset the runtime resolves
    // unpredictably (`mergeResolved`); with no way to say which a specifier means, neither
    // is touched.
    if (states.has(pkg.name)) {
      states.get(pkg.name)!.verbatim = true;
      continue;
    }
    states.set(pkg.name, new PackageState(pkg, module));
  }

  const queue: Array<[PackageState, string]> = [];
  const keep = (state: PackageState, file: string): void => {
    if (state.kept.has(file) || !hasContent(state.files[file])) return;
    state.kept.add(file);
    queue.push([state, file]);
  };
  const keepWhole = (state: PackageState): void => {
    if (state.verbatim) return;
    state.verbatim = true;
    for (const [file, entry] of Object.entries(state.files)) if (hasContent(entry)) keep(state, file);
  };
  const enter = (specifier: string): void => {
    const name = bareDependencyName(specifier);
    if (name === null) return;
    const state = states.get(name);
    if (!state) return; // not bundled: another rail's package, or one the lockset omits
    if (state.verbatim) return;
    const entries = state.entryFiles(specifier.slice(name.length + 1));
    if (entries === null) {
      // The specifier names nothing this walk can find. The package is still wanted, so it
      // is kept whole rather than pruned around an entry point that was never located.
      keepWhole(state);
      return;
    }
    for (const file of entries) keep(state, file);
    for (const file of state.browserReplacements()) keep(state, file);
  };

  for (const state of states.values()) {
    if (opts.neverPrune?.has(state.pkg.name) || state.manifest === null) keepWhole(state);
  }
  for (const specifier of [...PLATFORM_SPECIFIERS, ...opts.appSpecifiers]) enter(specifier);

  for (;;) {
    while (queue.length) {
      const [state, file] = queue.shift()!;
      const entry = state.files[file];
      if (!hasContent(entry)) continue;
      for (const specifier of asStringArray(entry.d)) {
        if (specifier.startsWith('.')) {
          for (const target of state.candidates(posix.join(posix.dirname(file), specifier))) keep(state, target);
        } else if (specifier.startsWith('#')) {
          // A package-internal `imports` alias. Resolving it needs the `imports` map and the
          // runtime's condition order; keeping the package whole needs neither.
          keepWhole(state);
        } else {
          enter(specifier);
        }
      }
    }
    // A package nothing reached is not evidence that nothing uses it: a declared dependency
    // can be entered by a route no static list shows. It ships as it arrived, and because
    // all of it ships, its own requires are followed like any other kept file's.
    const unreached = [...states.values()].filter((state) => !state.verbatim && state.kept.size === 0);
    if (!unreached.length) break;
    for (const state of unreached) keepWhole(state);
  }

  let prunedPackages = 0;
  let demotedFiles = 0;
  const out = packages.map((pkg) => {
    const state = states.get(pkg.name);
    if (!state || state.pkg !== pkg || state.verbatim) return pkg;
    let demoted = 0;
    const files: Record<string, FileEntry> = {};
    for (const [file, entry] of Object.entries(state.files)) {
      if (hasContent(entry) && JS_RE.test(file) && !state.kept.has(file)) {
        files[file] = Buffer.byteLength(entry.c, 'utf8');
        demoted++;
      } else {
        files[file] = entry;
      }
    }
    if (!demoted) return pkg;
    prunedPackages++;
    demotedFiles += demoted;
    return { ...pkg, bytes: encodeMsgPack({ ...state.decoded, f: files }) };
  });

  return { packages: out, bytesBefore, bytesAfter: totalBytes(out), prunedPackages, demotedFiles };
}
