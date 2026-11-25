/*
 * The request guards of git-serve's browser class (GIT_SERVE_SPEC §10.1).
 *
 * These are NOT the dev server's guards. Two helpers are shared with it
 * (`isAllowedHost`, `admittedOrigins`); the order and the rules are this
 * file's own, and each difference is deliberate:
 *
 *  - the `Host` header must carry the port;
 *  - `Origin` is required. The dev server admits a request without one;
 *  - the token is read from `Authorization` only. There is no `?token=` form;
 *  - `OPTIONS` is answered after Host and Origin, without a token.
 *
 * Order, for every request: Host pin, then the path's class, then that class's
 * gate. A path in no class is 404. The function is pure: it reads the request
 * line and headers it is given and returns a verdict, so each rule is tested
 * without a socket.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { isAllowedHost } from '../devServer.js';

export type RequestClass = 'browser' | 'none';

/** The one method each browser-class path serves. */
export const BROWSER_ROUTES: Readonly<Record<string, 'GET' | 'POST'>> = Object.freeze({
  '/meta': 'GET',
  '/tree': 'GET',
  '/blob': 'GET',
});

export const classify = (pathname: string): RequestClass =>
  Object.prototype.hasOwnProperty.call(BROWSER_ROUTES, pathname) ? 'browser' : 'none';

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

export interface GuardInput {
  method: string | undefined;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
  localPort: number;
  allowedHosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  /** True when the presented bearer value is a live token. */
  isToken: (bearer: string) => boolean;
}

export type GuardVerdict =
  /** Serve the request. `cors` goes on the answer. */
  | { kind: 'serve'; cors: Record<string, string> }
  /** Answer the preflight and stop. */
  | { kind: 'preflight'; headers: Record<string, string> }
  /** Refuse. `reason` is one word; `cors` is set once the Origin is known good. */
  | { kind: 'refuse'; status: number; reason: string; cors: Record<string, string> };

const CORS_MAX_AGE = '600';

const corsFor = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
});

export const guardRequest = (input: GuardInput): GuardVerdict => {
  // 1. Host pin, before anything else (DNS rebinding). No CORS header is sent
  //    for a refused host or origin: the page must not read the answer.
  if (!isPinnedHost(input.host, input.localPort, input.allowedHosts)) {
    return { kind: 'refuse', status: 403, reason: 'host', cors: {} };
  }

  // 2. The path decides the class.
  if (classify(input.pathname) !== 'browser') {
    return { kind: 'refuse', status: 404, reason: 'not-found', cors: {} };
  }
  const routeMethod = BROWSER_ROUTES[input.pathname]!;

  // 3. Browser class: Origin is required, and must be an admitted one.
  if (input.origin === undefined || !input.origins.has(input.origin)) {
    return { kind: 'refuse', status: 403, reason: 'origin', cors: {} };
  }
  const cors = corsFor(input.origin);

  // 4. Preflight: after Host and Origin, without a token. It names the one
  //    method this path serves. Private-Network is answered for Chromium's
  //    public-to-local preflight, as the dev server answers it.
  if (input.method === 'OPTIONS') {
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
  if (input.method !== routeMethod) {
    return { kind: 'refuse', status: 405, reason: 'method', cors };
  }

  // 5. The token, from Authorization only.
  const bearer = bearerOf(input.authorization);
  if (bearer === null || !input.isToken(bearer)) {
    return { kind: 'refuse', status: 401, reason: 'token', cors };
  }
  return { kind: 'serve', cors };
};
