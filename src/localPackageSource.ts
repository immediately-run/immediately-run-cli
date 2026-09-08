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

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Resolve `name` the way node would from `from`, walking up `node_modules`. Deliberately
 * not `require.resolve`: that resolves against THIS process's paths, and the tree being
 * described is the target repo's, which may not be the CLI's own.
 */
export function resolvePackageDir(name: string, from: string): string | null {
  let dir = resolvePath(from);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
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
      const dir = resolvePackageDir(name, from);
      if (!dir) continue;
      const pkg = readJson(join(dir, 'package.json'));
      const version = typeof pkg?.version === 'string' ? pkg.version : null;
      if (!version) continue;
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

/** Extensions the bundler treats as JS it may need to evaluate. */
const JS_RE = /\.(c|m)?js$/;

/** Resolve a relative `require()` specifier to a file inside `dir`, node-style. */
function resolveRelative(dir: string, fromFile: string, spec: string): string | null {
  const base = resolvePath(dirname(join(dir, fromFile)), spec);
  const candidates = [
    base,
    `${base}.cjs`,
    `${base}.js`,
    `${base}.json`,
    join(base, 'index.cjs'),
    join(base, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return relative(dir, c).split('\\').join('/');
    } catch {
      /* not this one */
    }
  }
  return null;
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

/** The CJS entry a bundler would load for this package, repo-relative. */
export function cjsEntry(pkg: Record<string, unknown>): string {
  const main = typeof pkg.main === 'string' ? pkg.main : null;
  return (main ?? 'index.js').replace(/^\.\//, '');
}

/**
 * Build the `ICDNModule` for an installed package.
 *
 * `scan` is injected (the sandbox's `scanCjsModule`, or any equivalent) rather than
 * imported, so this module stays dependency-free and the test can drive the REAL scanner
 * the runtime uses instead of a second implementation that agrees with itself.
 *
 * Content is carried for the transitive `require()` closure of the CJS entry, because the
 * runtime marks those modules precompiled and never scans them (see the file header);
 * every other file is recorded as a byte SIZE, which is what the CDN does and what keeps
 * the zip from carrying a package's ESM build, sourcemaps and typings for nothing.
 */
export function buildLocalPackage(
  packageDir: string,
  scan: (source: string) => { requires: string[] },
): LocalModule {
  const pkg = readJson(join(packageDir, 'package.json')) ?? {};
  const files = walkFiles(packageDir);
  const f: Record<string, LocalModuleFile | number> = {};

  // Size-only for everything first; the closure below upgrades what it reaches.
  for (const rel of files) {
    try {
      f[rel] = statSync(join(packageDir, rel)).size;
    } catch {
      /* vanished between walk and stat — leave it out entirely */
    }
  }

  const entry = cjsEntry(pkg);
  const queue = [entry, 'package.json'].filter((p) => f[p] !== undefined);
  const seen = new Set<string>();
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
    const isJs = JS_RE.test(rel);
    const requires = isJs ? scan(source).requires : [];
    f[rel] = { c: source, d: requires, t: isJs };
    for (const spec of requires) {
      if (!spec.startsWith('.')) continue; // a bare specifier is another PACKAGE, not our file
      const target = resolveRelative(packageDir, rel, spec);
      if (target && f[target] !== undefined) queue.push(target);
    }
  }

  // `m` is the package's own EXTERNAL dependencies — the names the runtime must have
  // resolved elsewhere. Taken from its manifest rather than from the scan, because a
  // conditional or lazy require would otherwise silently drop a real dependency.
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const peer = (pkg.peerDependencies ?? {}) as Record<string, string>;
  const m = [...new Set([...Object.keys(deps), ...Object.keys(peer)])].sort();

  return { f, m };
}

/** The verbatim msgpack bytes the runtime decodes, identical in shape to a live fetch. */
export const encodeLocalPackage = (module: LocalModule): Uint8Array => encodeMsgPack(module);
