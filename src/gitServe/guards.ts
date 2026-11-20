/*
 * The request router and guards of git-serve (GIT_SERVE_SPEC §10.1).
 *
 * Every request passes Host pinning first, with the port required. Then the
 * PATH decides the class, and each class has one gate:
 *
 *   browser   /meta /tree /blob /commit (and /pair on a tailnet)
 *             Origin allowlist; on a tailnet, peer identity; then the token,
 *             or for /pair the pairing code.
 *   git       /<repo>.git/…      (tailnet only; filled in by the smart-HTTP item)
 *             no browser headers; peer identity. No token.
 *   none      everything else: 404.
 *
 * No path is in both classes: a repository name cannot contain a dot.
 *
 * These are NOT the dev server's guards. Two helpers are shared with it
 * (`isAllowedHost`, `admittedOrigins`); the order and the rules are this
 * file's own, and each difference is deliberate:
 *
 *  - the `Host` header must carry the port;
 *  - `Origin` is required on the browser class. The dev server admits a
 *    request without one;
 *  - the token is read from `Authorization` only. There is no `?token=` form;
 *  - `OPTIONS` is answered after Host and Origin, without a token.
 *
 * The peer gate needs the daemon, so it cannot run inside a pure function. The
 * guard is therefore two pure steps with the peer gate between them:
 *
 *   admit()      Host, class, Origin          → refuse | browser | git
 *   (the caller runs the peer gate here, on a tailnet)
 *   authorize()  preflight, method, bearer    → refuse | preflight | serve
 *
 * `guardRequest` composes the two for a bind that has no peer gate.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { isAllowedHost } from '../devServer.js';

export type RequestClass = 'browser' | 'git' | 'none';
export type BrowserMethod = 'GET' | 'POST';
export type RouteTable = Readonly<Record<string, BrowserMethod>>;

/** The read routes: served on every bind. */
export const READ_ROUTES: RouteTable = Object.freeze({
  '/meta': 'GET',
  '/tree': 'GET',
  '/blob': 'GET',
});

/** What a loopback server serves: the reads, and the commit route (which is
 *  refused unless the server was started with `--allow-commit`). */
export const LOOPBACK_ROUTES: RouteTable = Object.freeze({
  ...READ_ROUTES,
  '/commit': 'POST',
});

/** A tailnet server also exchanges pairing codes. Loopback has no connections,
 *  so `/pair` does not exist there. */
export const TAILNET_ROUTES: RouteTable = Object.freeze({
  ...LOOPBACK_ROUTES,
  '/pair': 'POST',
});

/** A path under `/<something>.git/` (or exactly `/<something>.git`). */
const GIT_PATH_RE = /^\/[^/]+\.git(?:\/|$)/;

export const classify = (pathname: string, routes: RouteTable = READ_ROUTES): RequestClass => {
  if (Object.prototype.hasOwnProperty.call(routes, pathname)) return 'browser';
  if (GIT_PATH_RE.test(pathname)) return 'git';
  return 'none';
};

/** Host pinning with the port required (§10.1): the name must be one the server
 *  is bound as, and the port must be written and be the accepting socket's. */
export const isPinnedHost = (
  hostHeader: string | undefined,
  localPort: number,
  allowedHosts: ReadonlySet<string>,
): boolean => {
  if (!hostHeader) return false;
  // `[::1]` alone and `name` alone carry no port; `[::1]:7701` and `name:7701` do.
  const hasPort = hostHeader.startsWith('[')
    ? /\]:\d+$/.test(hostHeader)
    : /:\d+$/.test(hostHeader);
  return hasPort && isAllowedHost(hostHeader, localPort, allowedHosts);
};

/** Compares two secrets in time that does not depend on where they differ. */
export const sameSecret = (presented: string, expected: string): boolean => {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
};

/** The bearer value of an `Authorization` header, or null. */
export const bearerOf = (authorization: string | undefined): string | null => {
  if (authorization === undefined) return null;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(authorization);
  return m ? m[1]! : null;
};

export type Refusal = { kind: 'refuse'; status: number; reason: string; cors: Record<string, string> };

export interface AdmitInput {
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  localPort: number;
  allowedHosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  /** The browser-class routes this bind serves. */
  routes: RouteTable;
  /** Whether the git-client class exists on this bind (tailnet only, R-GS-17). */
  gitClass: boolean;
}

export type Admission =
  | Refusal
  | { kind: 'browser'; cors: Record<string, string>; routeMethod: BrowserMethod }
  | { kind: 'git' };

const CORS_MAX_AGE = '600';

const corsFor = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
});

/** Step one: Host, then the path's class, then (browser class) the Origin. */
export const admit = (input: AdmitInput): Admission => {
  // Host pin, before anything else (DNS rebinding). No CORS header is sent for
  // a refused host or origin: the page must not read the answer.
  if (!isPinnedHost(input.host, input.localPort, input.allowedHosts)) {
    return { kind: 'refuse', status: 403, reason: 'host', cors: {} };
  }
  const requestClass = classify(input.pathname, input.routes);
  if (requestClass === 'git' && input.gitClass) return { kind: 'git' };
  if (requestClass !== 'browser') {
    return { kind: 'refuse', status: 404, reason: 'not-found', cors: {} };
  }
  // Browser class: Origin is required, and must be an admitted one.
  if (input.origin === undefined || !input.origins.has(input.origin)) {
    return { kind: 'refuse', status: 403, reason: 'origin', cors: {} };
  }
  return {
    kind: 'browser',
    cors: corsFor(input.origin),
    routeMethod: input.routes[input.pathname]!,
  };
};

export type Authorization =
  | Refusal
  /** Answer the preflight and stop. */
  | { kind: 'preflight'; headers: Record<string, string> }
  /** The request carries a bearer value; the caller decides whether it is live. */
  | { kind: 'serve'; cors: Record<string, string>; bearer: string };

/** Step two, browser class only: preflight, method, and the bearer value. */
export const authorize = (
  admission: Extract<Admission, { kind: 'browser' }>,
  method: string | undefined,
  authorization: string | undefined,
): Authorization => {
  const { cors, routeMethod } = admission;
  // Preflight: after Host and Origin, without a token. It names the one method
  // this path serves. Private-Network is answered for Chromium's public-to-local
  // preflight, as the dev server answers it.
  if (method === 'OPTIONS') {
    return {
      kind: 'preflight',
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': routeMethod,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': CORS_MAX_AGE,
      },
    };
  }
  if (method !== routeMethod) return { kind: 'refuse', status: 405, reason: 'method', cors };
  // The credential, from Authorization only.
  const bearer = bearerOf(authorization);
  if (bearer === null) return { kind: 'refuse', status: 401, reason: 'token', cors };
  return { kind: 'serve', cors, bearer };
};

export interface GuardInput extends Omit<AdmitInput, 'routes' | 'gitClass'> {
  method: string | undefined;
  authorization: string | undefined;
  routes?: RouteTable;
  /** True when the presented bearer value is a live token. */
  isToken: (bearer: string) => boolean;
}

export type GuardVerdict =
  | Refusal
  | { kind: 'preflight'; headers: Record<string, string> }
  | { kind: 'serve'; cors: Record<string, string> };

/** Both steps, for a bind with no peer gate and no git class (loopback). */
export const guardRequest = (input: GuardInput): GuardVerdict => {
  const admission = admit({ ...input, routes: input.routes ?? READ_ROUTES, gitClass: false });
  if (admission.kind === 'refuse') return admission;
  if (admission.kind === 'git') return { kind: 'refuse', status: 404, reason: 'not-found', cors: {} };
  const authorization = authorize(admission, input.method, input.authorization);
  if (authorization.kind !== 'serve') return authorization;
  if (!input.isToken(authorization.bearer)) {
    return { kind: 'refuse', status: 401, reason: 'token', cors: authorization.cors };
  }
  return { kind: 'serve', cors: authorization.cors };
};
