/*
 * Dependency resolution and package content from the RUNNER'S OWN `node_modules`
 * (R3-567), instead of from the dependency CDN.
 *
 * WHY. `cache-zip` asks `sandpack-cdn` for both halves of what makes a cached zip
 * self-sufficient — the lockset (`/dep_tree/`) and, under `--bundle-packages`, the module
 * content (`/package/`). So the one artifact that could cover a CDN outage is itself gated
 * on the CDN. On 2026-09-08 that closed the last door: `@immediately-run/omnibox@0.3.0` was
 * published, merged and deployed; the CDN's npm mirror had not ingested it; `cache-zip`
 * fail-softed to `lockset: omitted`; and immediately.run's front door stayed blank for
 * hours AFTER the bug was fixed.
 *
 * The runner already holds the answer. npm resolved that tree — correctly, against the real
 * registry rather than a mirror — before any of this ran. `node_modules` is a complete,
 * exact, already-verified resolution; asking a third party to redo it, and accepting a
 * blank page when it cannot, is the defect.
 *
 * WHAT IS REPRODUCED, AND HOW IT IS KNOWN TO BE RIGHT. The runtime consumes a bundled
 * package through the SAME `ICDNModule` shape a live fetch returns (`{f, m}`), so this
 * builds that shape rather than a convenient one. The inclusion policy is not guessed from
 * the CDN's internals — it is derived from what the CONSUMER needs
 * (`module-registry/index.ts` `_writePrecompiledModule`):
 *
 *   · a precompiled module is constructed with `isCompiled = true`, so `transformModule`
 *     short-circuits and the bundler NEVER scans it. `file.d` is therefore the only source
 *     of that module's dependency graph, and it must be exact — this is the question
 *     R3-567 said to settle experimentally rather than assume, and that is the answer.
 *   · so: every file in the transitive `require()` closure of the CJS entry carries
 *     content + its own `d`; everything else is recorded as a SIZE only, exactly as the
 *     CDN does for the ESM build, the maps and the `.d.cts` files.
 *
 * `buildLocalPackage` is differential-tested against the CDN's own response for a package
 * the CDN still resolves — the only way to be sure a reconstruction matches a producer
 * whose source you cannot read.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';
import { encode as encodeMsgPack } from '@msgpack/msgpack';

import type { DepMap } from './lockset.js';
import type { ResolvedDependency } from './lockset.js';

/** A package file that ships with content: source, its `require()` specifiers, and whether
 *  it is already transpiled (true for anything the bundler must not re-transform). */
export interface LocalModuleFile {
  c: string;
  d: string[];
  t: boolean;
}

/** The `ICDNModule` shape the sandbox decodes — `f` files, `m` transient dependencies. */
export interface LocalModule {
  f: Record<string, LocalModuleFile | number>;
  m: string[];
}

/**
 * Does `version` satisfy `range`? Deliberately NARROW: exact, `^`, `~`, `>=` and `*`/`""`
 * only, and it returns TRUE for anything it does not understand.
 *
 * A permissive fallback is the right default here because the cost of the two errors is not
 * symmetric. Rejecting wrongly means falling back to the CDN — today's behaviour. Accepting
 * wrongly means a version mismatch enters the lockset. So this refuses only what it is sure
 * about, and a range shape it cannot parse is left to the CDN's own resolution rather than
 * guessed at. A full semver implementation is not worth a dependency in a CLI that runs on
 * a bare CI runner; if this ever needs to be exact, use one rather than growing this.
 */
export function satisfies(version: string, range: string | undefined): boolean {
  if (!range || range === '*' || range === 'latest') return true;
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const r = /^([\^~]|>=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!v || !r) return true; // not a shape we judge — let the CDN decide
  const [vm, vn, vp] = [Number(v[1]), Number(v[2]), Number(v[3])];
  const [op, rm, rn, rp] = [r[1], Number(r[2]), Number(r[3]), Number(r[4])];
  const atLeast = vm > rm || (vm === rm && (vn > rn || (vn === rn && vp >= rp)));
  if (op === '^') return vm === rm && atLeast;
  if (op === '~') return vm === rm && vn === rn && atLeast;
  if (op === '>=') return atLeast;
  return vm === rm && vn === rn && vp === rp;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Resolve `name` the way node would from `from`, walking up `node_modules` — but NEVER
 * above `stopAt` (the repo root).
 *
 * THE BOUND IS THE POINT. Without it the walk runs to the filesystem root, so a repo with
 * no `node_modules` of its own, nested anywhere under a directory that has one, resolves a
 * FOREIGN package — and it lands in that repo's lockset at the version the neighbour
 * happens to have. Review reproduced exactly that: a declared `^3.0.0` resolved to
 * `0.0.9-FOREIGN` at depth 0 and shipped, and the runtime applied it, because the echo it
 * matches on is the RANGE map, which still matched.
 *
 * Deliberately not `require.resolve`: that resolves against THIS process's paths, and the
 * tree being described is the target repo's, not the CLI's own — the same class of bug
 * one level up.
 */
export function resolvePackageDir(name: string, from: string, stopAt?: string): string | null {
  const root = stopAt ? resolvePath(stopAt) : null;
  let dir = resolvePath(from);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (root && dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The installed tree as `{n, v, d}` records — the lockset's `resolved`, without a network
 * call. Breadth-first from the root's runtime dependencies, so `d` is the true depth and a
 * package reachable at two depths gets the shallower one, matching `/dep_tree/`.
 *
 * `wanted` is the SAME input DepMap the lockset echoes and the runtime recomputes; a
 * package it names but the tree does not contain is left out, so the caller's
 * `assertDependenciesResolved` fails loudly rather than a hole shipping silently.
 */
export function resolveFromInstalledTree(repoPath: string, wanted: DepMap): ResolvedDependency[] {
  const out = new Map<string, ResolvedDependency>();
  let frontier = Object.keys(wanted).map((name) => ({ name, from: repoPath }));
  for (let depth = 0; frontier.length > 0 && depth < 64; depth++) {
    const next: { name: string; from: string }[] = [];
    for (const { name, from } of frontier) {
      if (out.has(name)) continue;
      // `repoPath` is the floor for EVERY lookup, including a transitive one: a nested
      // dependency's own deps resolve within the repo or not at all.
      const dir = resolvePackageDir(name, from, repoPath);
      if (!dir) continue;
      const pkg = readJson(join(dir, 'package.json'));
      const version = typeof pkg?.version === 'string' ? pkg.version : null;
      if (!version) continue;
      // The DECLARED range still has to hold. The walk bound stops a NEIGHBOUR's copy from
      // being found; it does nothing about a copy inside this repo that is simply the wrong
      // version — and the runtime cannot catch that either, because the echo it matches on
      // is the range map, which still matches. Round 1 asked for both halves and I shipped
      // only the bound while reporting it fixed.
      if (depth === 0 && !satisfies(version, wanted[name])) continue;
      out.set(name, { n: name, v: version, d: depth });
      const deps = (pkg?.dependencies ?? {}) as Record<string, string>;
      for (const child of Object.keys(deps)) next.push({ name: child, from: dir });
    }
    frontier = next;
  }
  // Sorted so two runs over the same tree produce byte-identical locksets — a cache
  // artifact that differs run-to-run is one nobody can diff.
  return [...out.values()].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
}

// --- package content ---------------------------------------------------------

/**
 * Merge the resolution sources into one lockset list, NEAREST SOURCE WINS.
 *
 * The sources are ordered, not pooled: the dependency CDN, then the app's own installed
 * tree, then the platform-provided tree this CLI carries. A name already resolved is never
 * resolved again.
 *
 * This is a function rather than three spreads because concatenating them was wrong and the
 * wrongness was invisible: `react-error-boundary` is injected by the platform AND hoisted
 * into landing-page's `node_modules`, so the union emitted it twice at two versions, and
 * `assertDependenciesResolved` — which checks that every wanted name is PRESENT — passed.
 * A lockset with two entries for one name does not fail; it makes the runtime pick one,
 * unpredictably, and `--bundle-packages` then ships content for whichever version the
 * OTHER lookup found. Caught on the live acceptance, not by the suite.
 */
export function mergeResolved(...sources: readonly (readonly ResolvedDependency[])[]): ResolvedDependency[] {
  const seen = new Set<string>();
  const out: ResolvedDependency[] = [];
  for (const source of sources) {
    for (const r of source) {
      if (seen.has(r.n)) continue;
      seen.add(r.n);
      out.push(r);
    }
  }
  return out;
}

/** Extensions the bundler treats as JS it may need to evaluate. */
const JS_RE = /\.(c|m)?js$/;

/**
 * The extension list the RUNTIME resolves relative specifiers with, in its order.
 *
 * Single-sourced from `sandbox/src/bundler/bundler.ts` (the `extensions` default that
 * `resolveFromCdnLayout` receives) and checked against it by
 * `scripts/check-scanner-drift.mjs`, because a private copy of someone else's resolution
 * order is exactly the kind of thing that silently stops matching.
 */
export const RUNTIME_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mdx'];

/**
 * EVERY file a relative specifier could name, under any resolution the runtime might apply.
 *
 * ⚠ THIS RETURNS ALL CANDIDATES, NOT THE FIRST, AND THAT IS THE POINT. An earlier cut
 * returned one, picked with node's importer-aware extension order (`.cjs` first from a CJS
 * file). That order is node's; the runtime's is a single fixed list, `.js` before `.cjs`,
 * the same for every importer (`bundler.ts` `extensions`, consumed by
 * `resolveFromCdnLayout`). Picking either one is a bet on which resolver runs — the fast
 * path, the general resolver, or an `exports` map choosing a different entry build — and a
 * lost bet leaves a file the runtime DOES load sitting in the zip as a bare size, which is a
 * blocking unpkg fetch at boot.
 *
 * There is nothing to gain by choosing. A dual-published package ships `x.js` and `x.cjs`
 * for the same specifier; carrying both costs bytes (measured: omnibox 3.85x the CDN's
 * payload, react 1.79x) and removes the guess. Over-inclusion is the safe direction — the
 * asymmetry the whole suite is built on.
 */
function resolveRelativeAll(dir: string, fromFile: string, spec: string): string[] {
  const base = resolvePath(dirname(join(dir, fromFile)), spec);
  const exts = ['', ...RUNTIME_EXTENSIONS];
  // Phase A (the path itself) and phase B (a directory index), the runtime's two phases.
  const candidates = [...exts.map((e) => `${base}${e}`), ...exts.map((e) => join(base, `index${e}`))];

  // The general resolver's directory step, which the fast path has no equivalent of. A
  // nested `package.json` can re-point `./sub` at a file no extension guess would reach.
  try {
    if (statSync(base).isDirectory()) {
      const own = readJson(join(base, 'package.json'));
      for (const v of [own?.module, own?.main]) {
        if (typeof v === 'string') candidates.push(resolvePath(base, v));
      }
    }
  } catch {
    /* not a directory */
  }

  const out: string[] = [];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) out.push(relative(dir, c).split('\\').join('/'));
    } catch {
      /* not this one */
    }
  }
  return [...new Set(out)];
}

/** Every file under `dir`, repo-relative with forward slashes, `node_modules` excluded. */
function walkFiles(dir: string, sub = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, sub))) {
    if (name === 'node_modules' || name === '.bin') continue;
    const rel = sub ? `${sub}/${name}` : name;
    const full = join(dir, rel);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...walkFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Conditions not to seed from. `types`/`typings` are declarations; `react-server` is a
 * server-only condition a browser bundler never takes.
 *
 * `import` and `module` are DELIBERATELY ABSENT, and that is the round-2 correction. They
 * were skipped on the theory that the runtime evaluates the CJS side — it does not. The
 * resolver's field priority is `['module', 'browser', 'main', 'jsnext:main']`
 * (`sandbox/src/resolver/utils/pkg-json.ts`), so `module` is PREFERRED, and a package with
 * no `exports` at all (lucide-react) is loaded entirely from its ESM build. Skipping ESM
 * left 1,803 of its files size-only — a blocking unpkg fetch each, at boot. They are seeded
 * now because `transpileToCjs` makes them safe to inline.
 */
const SKIP_CONDITIONS = new Set(['types', 'typings', 'react-server']);

/** The main-ish fields the resolver tries, IN ITS ORDER. All are seeded: which one the
 *  runtime picks depends on which files exist, and guessing wrong leaves an entry point
 *  size-only, which is the boot-time unpkg fetch this module exists to prevent. */
const MAIN_FIELDS = ['module', 'browser', 'main', 'jsnext:main'];

/** The CJS entry a bundler would load for this package, repo-relative. */
export function cjsEntry(pkg: Record<string, unknown>): string {
  const main = typeof pkg.main === 'string' ? pkg.main : null;
  return (main ?? 'index.js').replace(/^\.\//, '');
}

/**
 * Every entry point a consumer can reach, repo-relative: each `MAIN_FIELDS` value plus
 * every `exports` target, with `./*` patterns expanded against the files present.
 *
 * WILDCARDS ARE NOT OPTIONAL. `"./icons/*": "./dist/esm/icons/*.mjs"` is how a package with
 * a thousand entry points declares them, and emitting the literal `dist/esm/icons/*.mjs`
 * drops all of them silently — which is most of lucide-react. The runtime expands them
 * (`resolver/utils/exports.ts`), so this must too.
 */
export function entryPoints(pkg: Record<string, unknown>, files: readonly string[] = []): string[] {
  const out = new Set<string>();
  const add = (target: string): void => {
    const rel = target.replace(/^\.\//, '');
    if (!rel.includes('*')) {
      out.add(rel);
      return;
    }
    // Expanded against what is actually on disk, rather than inventing paths.
    const [before, after = ''] = rel.split('*');
    for (const f of files) if (f.startsWith(before) && f.endsWith(after)) out.add(f);
  };

  for (const field of MAIN_FIELDS) {
    const v = pkg[field];
    if (typeof v === 'string') add(v);
  }
  if (!MAIN_FIELDS.some((f) => typeof pkg[f] === 'string')) add('index.js');

  const visit = (node: unknown, condition: string | null): void => {
    if (typeof node === 'string') {
      if (condition === null || !SKIP_CONDITIONS.has(condition)) add(node);
      return;
    }
    // An ARRAY is a fallback list: its numeric keys are neither subpaths nor conditions, so
    // the inherited condition must carry through. Treating "0" as a condition is how the
    // old `import` skip leaked an untranspiled ESM file into the bundle.
    if (Array.isArray(node)) {
      for (const item of node) visit(item, condition);
      return;
    }
    if (!node || typeof node !== 'object') return; // a `null` target means "blocked"
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      visit(value, key.startsWith('.') ? condition : key);
    }
  };
  visit(pkg.exports, null);
  return [...out];
}

/** What a file contributes: its shipped source and the specifiers to walk. */
export interface TranspileResult {
  code: string;
  deps: string[];
}

/** Transpile a non-CJS module to CJS. Injected so this file stays dependency-free and the
 *  caller supplies `@immediately-run/transpiler`'s `transformFile`. */
export type Transpiler = (input: { path: string; code: string }) => Promise<{ code?: string; deps?: string[]; error?: { message: string } }>;

/**
 * Build the `ICDNModule` for an installed package.
 *
 * ⚠ AN ESM FILE MUST BE TRANSPILED BEFORE IT IS INLINED, AND THAT IS NOT AN OPTIMISATION.
 * `_writePrecompiledModule` constructs every content-carrying file as
 * `new Module(path, file.c, true, …)` — `isCompiled`, unconditionally — and nothing on the
 * consume side reads `file.t`. So shipping raw ESM does not cost bytes and does not fall
 * back to anything: the bundler treats `import …` as finished CJS, and the app breaks at
 * boot. The CDN transpiles before inlining, and so does the sandbox's own esm.sh fallback;
 * this does too, via the same `@immediately-run/transpiler` the runtime uses — which also
 * hands back the dependency list, so `d` comes from the real producer rather than a scan.
 *
 * Content is carried for the transitive closure of EVERY entry point (see `entryPoints`),
 * because a bundled module is never scanned and an entry left size-only is a blocking unpkg
 * fetch at boot. Everything else is recorded as a byte SIZE, which is what the CDN does and
 * what keeps a package's sourcemaps and typings out of the zip.
 */
export async function buildLocalPackage(
  packageDir: string,
  scan: (source: string) => { requires: string[]; isEsm: boolean },
  transpile: Transpiler,
): Promise<LocalModule> {
  const pkg = readJson(join(packageDir, 'package.json')) ?? {};
  const files = walkFiles(packageDir);
  const f: Record<string, LocalModuleFile | number> = {};

  for (const rel of files) {
    try {
      f[rel] = statSync(join(packageDir, rel)).size;
    } catch {
      /* vanished between walk and stat — leave it out entirely */
    }
  }

  const name = typeof pkg.name === 'string' ? pkg.name : 'pkg';
  const queue = [...entryPoints(pkg, files), 'package.json'].filter((p) => f[p] !== undefined);
  const seen = new Set<string>();
  const failures: string[] = [];

  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let source: string;
    try {
      source = readFileSync(join(packageDir, rel), 'utf8');
    } catch {
      continue;
    }

    if (!JS_RE.test(rel)) {
      // An asset the closure reached (a stylesheet, a JSON): shipped verbatim, no deps.
      f[rel] = { c: source, d: [], t: false };
      continue;
    }

    const scanned = scan(source);
    let content = source;
    let deps = scanned.requires;
    if (scanned.isEsm) {
      // `path` is what the transpiler keys its transform chain on, so it must look like the
      // module's real location — a bare basename picks a different chain.
      const result = await transpile({ path: `/node_modules/${name}/${rel}`, code: source });
      if (result.error || typeof result.code !== 'string') {
        // Leave it as a SIZE rather than ship ESM as if it were compiled. That costs an
        // unpkg fetch for this file; shipping it raw costs the whole app. Recorded so the
        // caller can refuse the package outright rather than ship a quiet hole.
        failures.push(`${rel}: ${result.error?.message ?? 'no output'}`);
        continue;
      }
      content = result.code;
      deps = result.deps ?? [];
    }

    f[rel] = { c: content, d: deps, t: true };
    for (const spec of deps) {
      if (!spec.startsWith('.')) continue; // a bare specifier is another PACKAGE
      for (const target of resolveRelativeAll(packageDir, rel, spec)) {
        if (f[target] !== undefined) queue.push(target);
      }
    }
  }

  if (failures.length) {
    throw new Error(`could not transpile ${failures.length} file(s): ${failures.slice(0, 3).join('; ')}`);
  }

  // `m` is the package's own EXTERNAL dependencies — the names the runtime must have
  // resolved elsewhere. Taken from the manifest rather than the scan, because a conditional
  // or lazy require would otherwise silently drop a real dependency.
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const peer = (pkg.peerDependencies ?? {}) as Record<string, string>;
  const m = [...new Set([...Object.keys(deps), ...Object.keys(peer)])].sort();

  return { f, m };
}

/** The verbatim msgpack bytes the runtime decodes, identical in shape to a live fetch. */
export const encodeLocalPackage = (module: LocalModule): Uint8Array => encodeMsgPack(module);
