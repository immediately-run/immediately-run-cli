/*
 * `immediately.run preauth` — apply an M1 pre-authorization policy headlessly
 * (UI_AS_APPS_SPEC §8.15 M1 / §8.9; roadmap R3-51d, plan
 * docs/plans/cli-preauth-shared-core.md, Phase 3).
 *
 * An operator/CI runs this to pre-grant an app's capabilities + net:fetch hosts
 * (and mounts) so a later headless/`immediately.run dev`/CI run boots with NO
 * consent modal. It is a THIN token-authenticated HTTP client: it POSTs the
 * policy to the backend `POST /api/v1/preauth` executor, which runs the ONE §8.9
 * target check + mint path site-main's in-browser M1 uses. The CLI holds no
 * Firestore creds and no grant logic of its own — it cannot mint anything the
 * in-browser gate would refuse, because it only asks the backend, which can only
 * mint through the shared `applyPreAuth`.
 *
 * Security posture: an over-broad/unknown capability makes the backend refuse the
 * WHOLE policy (HTTP 422) and mint NOTHING; this command then prints every
 * refusal and exits NON-ZERO, so a CI step fails on a bad policy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flagValue, type ParsedArgs } from '../args.js';
import { DEFAULT_ORIGIN, isRecognizedOrigin } from './dev.js';

// The backend mounts the executor under the shared API prefix (backend config.ts).
const API_PREFIX = '/api/v1';

/** The env var an operator/CI sets to supply the Firebase ID token (the backend
 *  verifies it like `/net-fetch`), as an alternative to `--token`. */
export const ID_TOKEN_ENV = 'IMMEDIATELY_RUN_ID_TOKEN';

export const PREAUTH_USAGE = `Usage: immediately.run preauth <app> [options]

Apply an M1 pre-authorization policy to an app headlessly: pre-grant its
capabilities + net:fetch hosts (and mounts) so a later headless/CI run boots
with no consent prompt. This is a thin client of the backend's policy executor —
the same §8.9 target check + mint path the in-browser surface uses. An over-broad
or unknown capability makes the backend refuse the WHOLE policy and mint nothing;
this command then prints the refusals and exits non-zero.

Arguments:
  <app>                     The app key to pre-authorize (provider-qualified, e.g.
                            github__acme__headless-runner). Overrides any appKey
                            in --policy.

Options:
  --policy <file.json>      A JSON policy: { appKey?, capabilities[], mounts?,
                            netFetchHosts? }. Merged with the flags below.
  --capabilities <a,b,c>    Comma-separated capability names (overrides the
                            policy file's capabilities). app-scoped caps
                            (net:fetch, task:invoke, contribute:self) are
                            grantable; broad-elevated/unknown caps are refused.
  --net-fetch <o1,o2>       Comma-separated net:fetch host ORIGINS to pre-grant
                            (overrides the policy file's netFetchHosts).
  --token <idToken>         Firebase ID token of the signed-in user the grant is
                            minted for (or set ${ID_TOKEN_ENV}).
  --origin <url>            immediately.run origin to POST to and attest as
                            (default: ${DEFAULT_ORIGIN}). Only immediately.run,
                            loopback, and preview origins are accepted without
                            --origin-unsafe.
  --origin-unsafe           Allow an --origin outside the recognized set.
  --json                    Print one machine-readable JSON line of the outcome.
  -h, --help                Show this help

Exit codes: 0 applied; 1 refused by the §8.9 gate (nothing minted) or mint
failed; 2 usage/auth error (bad args, missing token, 400/401/403/404);
3 rate-limited / server / network error.`;

export interface ConsentSelection {
  uri: string;
  mode: 'ro' | 'rw';
  kind: 'create' | 'pick';
  spaceId?: string;
  name?: string;
}
export interface NetFetchHost {
  origin: string;
  paths?: string[];
  methods?: string[];
}
export interface PreAuthPolicy {
  appKey?: string;
  capabilities?: string[];
  mounts?: ConsentSelection[];
  netFetchHosts?: NetFetchHost[];
}
export interface PreAuthBody {
  appKey: string;
  capabilities: string[];
  mounts: ConsentSelection[];
  netFetchHosts: NetFetchHost[];
}
export interface Refusal {
  capability: string;
  reason: string;
}

/** Injectable boundaries so the command is unit-tested without real I/O. */
export interface PreAuthDeps {
  fetchImpl: typeof fetch;
  readFile: (path: string) => string;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  errorLog: (msg: string) => void;
}

const defaultDeps = (): PreAuthDeps => ({
  fetchImpl: globalThis.fetch,
  readFile: (p) => readFileSync(resolve(p), 'utf8'),
  env: process.env,
  log: (m) => console.log(m),
  errorLog: (m) => console.error(m),
});

const splitList = (v: string): string[] =>
  v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

/** Build the executor URL for `origin` (trailing slashes normalized). */
export const preAuthUrl = (origin: string): string =>
  `${origin.replace(/\/+$/, '')}${API_PREFIX}/preauth`;

/**
 * Combine the positional app key, an optional `--policy` file, and the flag
 * overrides into a validated `PreAuthBody`. Fail-closed: a missing app key, a
 * non-array `capabilities`, or a malformed mount/host shape is an error (we never
 * coerce — the backend's §8.9 gate validates cap NAMES, but a structurally broken
 * policy should fail here, before any network call).
 */
export function buildPreAuthBody(
  args: ParsedArgs,
  deps: Pick<PreAuthDeps, 'readFile'>,
): { ok: true; body: PreAuthBody } | { ok: false; error: string } {
  let policy: PreAuthPolicy = {};
  const policyPath = flagValue(args.flags, 'policy');
  if (policyPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.readFile(policyPath));
    } catch (err) {
      return { ok: false, error: `cannot read --policy ${policyPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: `--policy ${policyPath} must be a JSON object` };
    }
    policy = parsed as PreAuthPolicy;
  }

  const appKey = args.positionals[0] ?? policy.appKey;
  if (typeof appKey !== 'string' || appKey.length === 0) {
    return { ok: false, error: 'an app key is required (positional <app> or "appKey" in --policy)' };
  }

  const capFlag = flagValue(args.flags, 'capabilities');
  const capabilities = capFlag !== undefined ? splitList(capFlag) : policy.capabilities ?? [];
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    return { ok: false, error: 'capabilities must be an array of strings' };
  }

  const netFlag = flagValue(args.flags, 'net-fetch');
  const netFetchHosts =
    netFlag !== undefined ? splitList(netFlag).map((origin) => ({ origin })) : policy.netFetchHosts ?? [];
  if (
    !Array.isArray(netFetchHosts) ||
    !netFetchHosts.every((h) => typeof h === 'object' && h !== null && typeof h.origin === 'string')
  ) {
    return { ok: false, error: 'netFetchHosts must be an array of { origin, … }' };
  }

  const mounts = policy.mounts ?? [];
  if (
    !Array.isArray(mounts) ||
    !mounts.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        typeof m.uri === 'string' &&
        (m.mode === 'ro' || m.mode === 'rw') &&
        (m.kind === 'create' || (m.kind === 'pick' && typeof m.spaceId === 'string')),
    )
  ) {
    return { ok: false, error: 'mounts must be an array of mount selections (use --policy for mounts)' };
  }

  if (capabilities.length === 0 && netFetchHosts.length === 0 && mounts.length === 0) {
    return { ok: false, error: 'the policy is empty: provide --capabilities, --net-fetch, or mounts' };
  }

  return { ok: true, body: { appKey, capabilities, mounts, netFetchHosts } };
}

export interface PreAuthOutcome {
  status: number;
  /** Parsed JSON body, or undefined if the response wasn't JSON. */
  json?: { ok?: boolean; code?: string; reason?: string; refused?: Refusal[]; mint?: unknown };
}

/** POST the policy to the executor. Sets the `Origin` header (the backend's
 *  host-origin attestation) and the bearer ID token, exactly as the in-browser
 *  host's `/net-fetch` call does. Throws only on a network/transport failure. */
export async function postPreAuth(
  deps: Pick<PreAuthDeps, 'fetchImpl'>,
  opts: { origin: string; token: string; body: PreAuthBody },
): Promise<PreAuthOutcome> {
  const res = await deps.fetchImpl(preAuthUrl(opts.origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token}`,
      origin: opts.origin.replace(/\/+$/, ''),
    },
    body: JSON.stringify(opts.body),
  });
  let json: PreAuthOutcome['json'];
  try {
    json = (await res.json()) as PreAuthOutcome['json'];
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/**
 * Map an executor outcome to printed output + an exit code. Pure (no I/O beyond
 * the injected loggers) so it is unit-tested.
 *   200 → applied (exit 0); 422 → refused, prints each {capability, reason} (exit 1);
 *   400/401/403/404 → usage/auth error (exit 2); 429/5xx/other → exit 3.
 */
export function reportOutcome(
  outcome: PreAuthOutcome,
  body: PreAuthBody,
  deps: Pick<PreAuthDeps, 'log' | 'errorLog'>,
  asJson: boolean,
): number {
  const { status, json } = outcome;
  if (asJson) {
    (status === 200 ? deps.log : deps.errorLog)(JSON.stringify({ status, ...json }));
  }
  if (status === 200 && json?.ok) {
    if (!asJson) {
      deps.log(`Applied pre-auth for ${body.appKey}: ${body.capabilities.length} capabilit${body.capabilities.length === 1 ? 'y' : 'ies'}, ${body.netFetchHosts.length} net:fetch host(s), ${body.mounts.length} mount(s).`);
    }
    return 0;
  }
  if (status === 422) {
    const refused = json?.refused ?? [];
    if (!asJson) {
      deps.errorLog(`Refused: the policy names ${refused.length} capabilit${refused.length === 1 ? 'y' : 'ies'} the §8.9 target check rejects — NOTHING was minted.`);
      for (const r of refused) deps.errorLog(`  - ${r.capability}: ${r.reason}`);
    }
    return 1;
  }
  if (status === 500 && json?.code === 'mint-failed') {
    if (!asJson) deps.errorLog('A store write failed mid-mint (not a policy error); retry.');
    return 1;
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    if (!asJson) deps.errorLog(`Request rejected (HTTP ${status})${json?.reason ? `: ${json.reason}` : json?.code ? `: ${json.code}` : ''}.`);
    return 2;
  }
  if (!asJson) deps.errorLog(`Pre-auth failed (HTTP ${status})${json?.reason ? `: ${json.reason}` : ''}.`);
  return 3;
}

export const runPreAuth = async (args: ParsedArgs, depsOverride?: Partial<PreAuthDeps>): Promise<number> => {
  const deps: PreAuthDeps = { ...defaultDeps(), ...depsOverride };

  if (args.flags.help || args.flags.h) {
    deps.log(PREAUTH_USAGE);
    return 0;
  }

  const origin = flagValue(args.flags, 'origin') ?? DEFAULT_ORIGIN;
  if (!isRecognizedOrigin(origin) && args.flags['origin-unsafe'] !== true) {
    deps.errorLog(
      `Refusing --origin ${origin}: not a recognized immediately.run, loopback, or preview origin. ` +
        `Re-run with --origin-unsafe to allow it.`,
    );
    return 2;
  }

  const token = flagValue(args.flags, 'token') ?? deps.env[ID_TOKEN_ENV];
  if (!token) {
    deps.errorLog(`No ID token: pass --token <idToken> or set ${ID_TOKEN_ENV}.`);
    return 2;
  }

  const built = buildPreAuthBody(args, deps);
  if (!built.ok) {
    deps.errorLog(`Invalid policy: ${built.error}`);
    return 2;
  }

  let outcome: PreAuthOutcome;
  try {
    outcome = await postPreAuth(deps, { origin, token, body: built.body });
  } catch (err) {
    deps.errorLog(`Network error reaching ${preAuthUrl(origin)}: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  return reportOutcome(outcome, built.body, deps, args.flags.json === true);
};
