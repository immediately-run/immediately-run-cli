/*
 * `immediately.run llm` proxy core (R3-77 / P3-75; LLM_AND_AGENTS_SPEC §2.4/§3.4,
 * D3 — Approach 4; LOCAL_DEV_AUTHED_SERVER_SPEC). The CLI extends the SAME
 * authenticated localhost server as the agent bridge (it does NOT stand up a
 * second server) with a `POST /llm/...` route that forwards to a SINGLE,
 * user-configured OpenAI-compatible upstream, injecting the user's key
 * server-side (on the user's own machine) so the key never leaves it.
 *
 * This module is the transport-free security CORE (ways_of_working §5): the
 * not-an-open-relay PIN (`resolveUpstreamTarget`) and the server-side key
 * INJECTION (`buildUpstreamHeaders`) are pure functions, unit-tested without a
 * server. The devServer route is the thin glue that streams bytes through them.
 */

import type { IncomingHttpHeaders } from 'node:http';

/** The single configured upstream the proxy forwards to. The key is injected
 *  server-side and is never accepted from, nor echoed to, the caller. */
export interface LlmUpstream {
  /** The one OpenAI-compatible base URL (e.g. `http://127.0.0.1:11434` for
   * Ollama, or a user's gateway). EVERY `/llm` request is pinned to its origin. */
  baseUrl: string;
  /** The user's key, injected server-side. Optional — local models often need
   * none. Never read from the request, never written to a response. */
  apiKey?: string;
  /** Header the key is injected into (default `authorization`). */
  authHeader?: string;
  /** Scheme prefix for the injected header (default `Bearer`; empty = raw value,
   * e.g. some gateways want `x-api-key: <key>`). */
  authScheme?: string;
  /** R3-785 — extra upstream headers the row/gateway demands, declared as
   * `--header name=value` on the CLI (the catalogue row's `requestHeaders`
   * vocabulary: a value of exactly {@link CONNECTION_ID_PLACEHOLDER} is
   * substituted with {@link LlmUpstream.connectionId}). Example: OpenCode's
   * gateway 400s any POST without `x-opencode-session`, so its transport runs
   * with `--header 'x-opencode-session=$connectionId'`. */
  extraHeaders?: Record<string, string>;
  /** The id {@link CONNECTION_ID_PLACEHOLDER} substitutes to. Minted once per
   * proxy process in `runLlm` (one process, one pinned upstream, one routing
   * identity — the transport's reading of "per connection"; site-main's
   * adapterFor rotates per chat request, both satisfy the gateway's
   * routing-affinity ask). Tests may inject a fixed value. */
  connectionId?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Request-body cap (bytes); defaults to {@link DEFAULT_LLM_BODY_BYTES}. */
  maxBodyBytes?: number;
}

/** `/llm` request-body cap — chat completions are small JSON; a stated bound must
 *  exist at this trust boundary (cf. the bridge's MAX_BRIDGE_BODY_BYTES). */
export const DEFAULT_LLM_BODY_BYTES = 4 * 1024 * 1024;

/** The route prefix the proxy owns. */
export const LLM_ROUTE_PREFIX = '/llm';

export type TargetResolution =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Pin a caller's `/llm` request to the configured upstream (the §9 D3 exit —
 * **not an open relay**). The caller names only a SUBPATH under `/llm` (e.g.
 * `/llm/v1/chat/completions` → `<baseUrl>/v1/chat/completions`); it may NOT name
 * a host or scheme. Any attempt to carry a target — an absolute URL, a
 * protocol-relative `//host`, a backslash/NUL — is REFUSED, and the constructed
 * target's origin is re-asserted to equal the configured origin (defense in
 * depth). PURE.
 */
export function resolveUpstreamTarget(
  baseUrl: string,
  requestPath: string,
  search: string,
): TargetResolution {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'misconfigured upstream base URL' };
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return { ok: false, reason: 'upstream must be an http(s) URL' };
  }
  if (requestPath !== LLM_ROUTE_PREFIX && !requestPath.startsWith(LLM_ROUTE_PREFIX + '/')) {
    return { ok: false, reason: 'not an /llm route' };
  }
  let sub = requestPath.slice(LLM_ROUTE_PREFIX.length); // '' | '/v1/...'
  if (sub === '') sub = '/';
  // A caller may name only a path under the pinned upstream — never a host/scheme.
  if (sub.includes('\0') || sub.includes('\\')) {
    return { ok: false, reason: 'invalid path' };
  }
  if (sub.includes('://') || sub.startsWith('//')) {
    return { ok: false, reason: 'target is pinned to the configured upstream' };
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  let target: URL;
  try {
    target = new URL(base.origin + basePath + sub + search);
  } catch {
    return { ok: false, reason: 'invalid target path' };
  }
  // Defense in depth: a path can never move the host, but assert it anyway —
  // the pin is the load-bearing guarantee, so prove it rather than trust it.
  if (target.origin !== base.origin) {
    return { ok: false, reason: 'target is pinned to the configured upstream' };
  }
  return { ok: true, url: target.toString() };
}

/**
 * R3-785 — the ONE placeholder a `--header` value may carry (the same token
 * site-main's catalogue declares in `requestHeaders`); buildUpstreamHeaders
 * substitutes it with the process-minted connection id. Exported so the help
 * text and the guard cannot drift from the substitution.
 */
export const CONNECTION_ID_PLACEHOLDER = '$connectionId';

/**
 * R3-785 — assemble the extra upstream headers from the parsed CLI args, LOUDLY.
 * Pure (transport-free, per this module's core/glue split). Throws on:
 *  - a valueless `--header` (a trailing or flag-adjacent `--header` parses as
 *    boolean `true` and would otherwise silently ship nothing);
 *  - a value without `name=`;
 *  - a `$`-bearing value that is not exactly {@link CONNECTION_ID_PLACEHOLDER}
 *    (the typo class that would ship verbatim upstream as a silent routing
 *    failure — the same guard site-main's catalogue validator applies to rows).
 */
export function collectHeaderFlags(args: {
  flags: Record<string, string | true>;
  repeated: Record<string, string[]>;
}): Record<string, string> {
  if (args.flags['header'] === true) {
    throw new Error("--header expects name=value (a value must follow; last flag wins when repeated)");
  }
  const values = [
    ...(args.repeated['header'] ?? []),
    ...(typeof args.flags['header'] === 'string' ? [args.flags['header']] : []),
  ];
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new Error(`--header expects name=value, got "${raw}"`);
    const value = raw.slice(eq + 1);
    if (value.includes('$') && value !== CONNECTION_ID_PLACEHOLDER) {
      throw new Error(
        `--header ${raw.slice(0, eq)}: a '$'-bearing value must be exactly '${CONNECTION_ID_PLACEHOLDER}'`,
      );
    }
    out[raw.slice(0, eq)] = value;
  }
  return out;
}

/**
 * Build the headers for the forwarded upstream request. Forwards ONLY the
 * caller's content-negotiation headers (`content-type`, `accept`) and injects
 * the user's key server-side. The caller's `Authorization` (the localhost bearer
 * token, NOT the upstream key), `Host`, `Origin`, and `Cookie` are deliberately
 * dropped — the key is the host's to inject, never the caller's to supply or
 * override. PURE.
 */
export function buildUpstreamHeaders(
  clientHeaders: IncomingHttpHeaders,
  upstream: LlmUpstream,
): Record<string, string> {
  const out: Record<string, string> = {};
  const ct = clientHeaders['content-type'];
  if (typeof ct === 'string') out['content-type'] = ct;
  const accept = clientHeaders['accept'];
  if (typeof accept === 'string') out['accept'] = accept;
  for (const [name, value] of Object.entries(upstream.extraHeaders ?? {})) {
    out[name.toLowerCase()] =
      value === CONNECTION_ID_PLACEHOLDER ? (upstream.connectionId ?? '') : value;
  }
  if (upstream.apiKey) {
    const header = (upstream.authHeader ?? 'authorization').toLowerCase();
    const scheme = upstream.authScheme ?? 'Bearer';
    out[header] = scheme ? `${scheme} ${upstream.apiKey}` : upstream.apiKey;
  }
  return out;
}
