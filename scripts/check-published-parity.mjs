#!/usr/bin/env node
/*
 * If this version is ALREADY on npm, what we would publish must declare the same
 * install surface as what IS published.
 *
 * `ci.yml`'s publish step skips when `package.json`'s version already exists, and says so
 * with a `::notice::` — not a failure. That skip is correct (a re-run of an old commit
 * must not try to republish) and it is also how `main` and the published package drifted
 * apart for weeks without a single red build in a consumer repo (grove): an SDK pin moved
 * from `^0.52.0` to `^0.65.0` on `main`, the version was never bumped, so the published
 * package kept declaring the old pin. Every consumer installing it got the OLD pin, npm
 * nested a second copy, and R3-556 — which composes that package — was blocked by it with
 * nothing anywhere reporting a problem.
 *
 * The invariant this restores: a skip is benign only when it is a NO-OP. Same version,
 * different declarations, means the version number is a lie and the fix is to bump it.
 *
 * ## What is compared, and what cannot be
 *
 * The dependency blocks, plus `main` and `exports`: the parts of the manifest a
 * consumer's install and resolution actually read, so a difference there changes what is
 * on a consumer's disk or which file they get when they import. `devDependencies` is
 * excluded because it is never on a consumer's disk. `files` is excluded because it
 * CANNOT be compared — npm does not keep it in the packument, so the registry has no
 * answer to compare against. Comparing whole tarballs would fail on every timestamp and
 * prove nothing.
 *
 * ## Where it runs, and why in two places
 *
 * `verify` (through `check:published`), where it catches a pin that moves without a
 * version bump ON THE PULL REQUEST that does it — which is the only moment the fix is one
 * line. A version not yet published is the ordinary state there, so that is exit 0, not a
 * failure. And again in the publish job, where a drift means the release about to be
 * skipped would silently no-op.
 *
 * Usage: node scripts/check-published-parity.mjs [--self-test] [--offline-ok]
 * Exit:  0 parity, or this version is not published yet (nothing to compare)
 *        1 drift — same version, different declarations
 *        2 cannot answer (registry unreadable, offline, malformed reply)
 *          …unless --offline-ok, which downgrades ONLY that case to 0.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The dependency blocks a consumer's install resolves against. */
const BLOCKS = ["dependencies", "peerDependencies", "optionalDependencies"];
/** Non-block fields that decide WHICH FILE a consumer's import lands on. */
const FIELDS = ["main", "exports"];

/** Stable stringify, so key ORDER is not reported as a difference. */
const stable = (v) => {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(",")}}`;
};

/**
 * Compare two manifests' install surface.
 *
 * Returns the differences as `{ block, name, published, local }` rows — empty means
 * parity. A missing block on either side is the empty object, never a reason to skip the
 * comparison: dropping `peerDependencies` wholesale is exactly the kind of change that
 * must not ride an unbumped version.
 */
export function dependencyDrift(published, local) {
  const rows = [];
  for (const block of BLOCKS) {
    const p = published?.[block] ?? {};
    const l = local?.[block] ?? {};
    for (const name of [
      ...new Set([...Object.keys(p), ...Object.keys(l)]),
    ].sort()) {
      if (p[name] !== l[name]) {
        rows.push({
          block,
          name,
          published: p[name] ?? "(absent)",
          local: l[name] ?? "(absent)",
        });
      }
    }
  }
  for (const field of FIELDS) {
    const p = stable(published?.[field]);
    const l = stable(local?.[field]);
    if (p !== l)
      rows.push({
        block: "(root)",
        name: field,
        published: p ?? "(absent)",
        local: l ?? "(absent)",
      });
  }
  return rows;
}

/**
 * What the registry's answer MEANS — pure, so every branch is testable without a
 * network. `npm view <spec> … --json` has three shapes worth telling apart, and the
 * first two both exit non-zero, which is why the exit code alone is not the answer:
 *
 *  - **absent** — the version is not published. npm prints `{"error":{"code":"E404"}}`
 *    to STDOUT and exits non-zero. There is nothing to compare, and on a pull request
 *    this is the ordinary state, so it is a pass.
 *  - **unreadable** — no network, a private-registry auth failure, a malformed reply.
 *    Never a pass on its own: the publish job only reaches this once `npm view` has
 *    already said the version EXISTS, so failing to read it there is a real problem.
 *  - **published** — a JSON object of the requested fields. EMPTY stdout is this case
 *    too, and means a manifest declaring none of them.
 */
export function classifyRegistryReply({ stdout, failed }) {
  const text = (stdout ?? "").trim();
  if (text === "")
    return failed
      ? { kind: "unreadable", reason: "empty reply" }
      : { kind: "published", manifest: {} };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "reply was not JSON" };
  }
  if (parsed && typeof parsed === "object" && parsed.error) {
    return parsed.error.code === "E404"
      ? { kind: "absent" }
      : {
          kind: "unreadable",
          reason: parsed.error.summary ?? parsed.error.code ?? "registry error",
        };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "reply was not an object" };
  }
  return { kind: "published", manifest: parsed };
}

function selfTest() {
  let ok = 0;
  let total = 0;
  const check = (label, cond) => {
    total += 1;
    if (cond) ok += 1;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  };
  const dep = (o) => ({ dependencies: o });

  // ── the comparison ─────────────────────────────────────────────────────────
  check(
    "identical manifests have no drift",
    dependencyDrift(dep({ a: "1.0.0" }), dep({ a: "1.0.0" })).length === 0,
  );
  // The R3-556 case, verbatim.
  const moved = dependencyDrift(
    dep({ "@immediately-run/sdk": "^0.52.0" }),
    dep({ "@immediately-run/sdk": "^0.65.0" }),
  );
  check("a moved pin is drift", moved.length === 1);
  check(
    "…and names both sides",
    moved[0].published === "^0.52.0" && moved[0].local === "^0.65.0",
  );
  check(
    "an ADDED dependency is drift",
    dependencyDrift(dep({}), dep({ a: "1.0.0" }))[0]?.local === "1.0.0",
  );
  check(
    "a REMOVED dependency is drift",
    dependencyDrift(dep({ a: "1.0.0" }), dep({}))[0]?.local === "(absent)",
  );
  check(
    "a peer moved while the dependency stayed is still drift",
    dependencyDrift(
      { dependencies: { a: "1.0.0" }, peerDependencies: { a: "^1.0.0" } },
      { dependencies: { a: "1.0.0" }, peerDependencies: { a: "^2.0.0" } },
    ).length === 1,
  );
  check(
    "dropping peerDependencies entirely is drift, not an excuse to skip",
    dependencyDrift({ peerDependencies: { a: "^1.0.0" } }, {}).length === 1,
  );
  check(
    "devDependencies are not compared — they are not on a consumer disk",
    dependencyDrift(
      { devDependencies: { a: "1" } },
      { devDependencies: { a: "2" } },
    ).length === 0,
  );
  check(
    "order does not matter",
    dependencyDrift(dep({ a: "1", b: "2" }), dep({ b: "2", a: "1" })).length ===
      0,
  );
  // `main`/`exports` decide which FILE an import lands on, so they are the same class of
  // change as a moved pin — and an exports map is nested, hence the stable compare.
  check(
    "a moved `main` is drift",
    dependencyDrift({ main: "src/a.tsx" }, { main: "src/b.tsx" }).length === 1,
  );
  check(
    "a changed `exports` subpath is drift",
    dependencyDrift(
      { exports: { ".": "./a.ts" } },
      { exports: { ".": "./b.ts" } },
    ).length === 1,
  );
  check(
    "an ADDED `exports` subpath is drift",
    dependencyDrift(
      { exports: { ".": "./a.ts" } },
      { exports: { ".": "./a.ts", "./x": "./x.ts" } },
    ).length === 1,
  );
  check(
    "the same exports map in a different key order is NOT drift",
    dependencyDrift(
      { exports: { ".": "./a.ts", "./x": "./x.ts" } },
      { exports: { "./x": "./x.ts", ".": "./a.ts" } },
    ).length === 0,
  );

  // ── what the registry's answer means ───────────────────────────────────────
  // The E404 body is the REAL one, captured from
  // `npm view @immediately-run/cli@0.0.0-nonexistent dependencies --json` — not a
  // hand-written approximation of it.
  const e404 = JSON.stringify({
    error: {
      code: "E404",
      summary: "No match found for version 0.0.0-nonexistent",
      detail:
        "The requested resource '@immediately-run/cli@0.0.0-nonexistent' could not be found or you do not have permission to access it.\n\nNote that you can also install from a\ntarball, folder, http url, or git url.",
    },
  });
  check(
    "an E404 body is ABSENT, not unreadable",
    classifyRegistryReply({ stdout: e404, failed: true }).kind === "absent",
  );
  // The published body is equally real: the SAME argv this script sends (`BLOCKS` +
  // `FIELDS`), against @immediately-run/cli@0.9.0, captured 2026-09-21. This package
  // declares no `main` and no peer deps, so a narrower fixture would not exercise the
  // "absent blocks read as empty, never as an excuse" half of the comparison.
  const real = JSON.stringify({
    dependencies: {
      "@immediately-run/platform-constants": "0.2.0",
      "@immediately-run/transpiler": "0.9.0",
      "@msgpack/msgpack": "^3.1.3",
      "core-js": "3.22.7",
      "react-error-boundary": "^6.1.0",
      "react-refresh": "^0.11.0",
    },
    exports: {
      "./package.json": "./package.json",
    },
  });
  const pub = classifyRegistryReply({ stdout: real, failed: false });
  check("a real packument reply is PUBLISHED", pub.kind === "published");
  check(
    "an absent-blocks manifest is published-with-nothing, not unreadable",
    classifyRegistryReply({ stdout: "", failed: false }).kind === "published",
  );
  check(
    "…which then reads every local block as ADDED",
    dependencyDrift(
      classifyRegistryReply({ stdout: "", failed: false }).manifest,
      dep({ a: "1" }),
    ).length === 1,
  );
  check(
    "an empty reply that FAILED is unreadable",
    classifyRegistryReply({ stdout: "", failed: true }).kind === "unreadable",
  );
  check(
    "a non-E404 registry error is unreadable, never absent",
    classifyRegistryReply({
      stdout: JSON.stringify({ error: { code: "E401", summary: "auth" } }),
      failed: true,
    }).kind === "unreadable",
  );
  check(
    "a non-JSON reply is unreadable",
    classifyRegistryReply({ stdout: "<html>502</html>", failed: true }).kind ===
      "unreadable",
  );
  check(
    "a JSON ARRAY reply is unreadable, not an empty manifest",
    classifyRegistryReply({ stdout: '["0.1.1","0.1.2"]', failed: false })
      .kind === "unreadable",
  );

  console.log(`\n${ok}/${total} self-test cases.`);
  return ok === total ? 0 : 1;
}

if (process.argv.includes("--self-test")) process.exit(selfTest());

const offlineOk = process.argv.includes("--offline-ok");
const local = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const spec = `${local.name}@${local.version}`;

let stdout = "";
let failed = false;
try {
  stdout = execFileSync("npm", ["view", spec, ...BLOCKS, ...FIELDS, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
} catch (e) {
  failed = true;
  stdout = typeof e?.stdout === "string" ? e.stdout : "";
}

const reply = classifyRegistryReply({ stdout, failed });

if (reply.kind === "absent") {
  console.log(`✓ ${spec} is not published yet — nothing to compare.`);
  process.exit(0);
}

if (reply.kind === "unreadable") {
  console.error(
    offlineOk
      ? `⚠ could not read ${spec} from the registry (${reply.reason}) — parity was NOT checked. ` +
          `Not failing the build (--offline-ok); the publish job checks this strictly.`
      : `✗ cannot read ${spec} from the registry (${reply.reason}) — not answering is not a pass.`,
  );
  process.exit(offlineOk ? 0 : 2);
}

const rows = dependencyDrift(reply.manifest, local);
if (rows.length === 0) {
  console.log(
    `✓ ${spec} on npm declares the same install surface as this tree.`,
  );
  process.exit(0);
}

console.error(
  `::error::${spec} is already published, and this tree declares a DIFFERENT install surface. ` +
    `Publishing would be skipped, so the change would never reach npm — bump the version.`,
);
for (const r of rows) {
  console.error(
    `  ${r.block}.${r.name}: published ${r.published} · here ${r.local}`,
  );
}
process.exit(1);
