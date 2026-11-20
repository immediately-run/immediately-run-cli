/*
 * The namespace of a `git` mount, bound to the endpoint (GIT_SERVE_SPEC R-GS-8).
 *
 *   <label>-<hash20>     hash20 = first 20 lowercase hex chars of SHA-256(identity input)
 *
 *   Loopback   label `localhost`                 input: the server's instanceId
 *   Tailnet    label = first label of the host   input: the origin, lowercase,
 *                                                       port always written
 *
 * Grants key on the app's four-part name, which includes this namespace, so the
 * namespace must not be a name a second machine can pick. It is derived, never
 * chosen, and the host recomputes it from the endpoint it actually reached.
 *
 * The same function exists in site-main (`src/filesystem/gitNamespace.ts`). The
 * two are held together by one vectors file, copied byte for byte between the
 * repositories: `test/fixtures/git-serve-namespace-vectors.json`.
 */

import { createHash } from 'node:crypto';

export type NamespaceInput =
  | { kind: 'loopback'; instanceId: string }
  | { kind: 'tailnet'; origin: string };

export const LOOPBACK_LABEL = 'localhost';
export const NAMESPACE_HASH_CHARS = 20;

const hash20 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, NAMESPACE_HASH_CHARS);

/**
 * The identity input of a tailnet endpoint: `https://<host>:<port>`, lowercase,
 * with the port written even when it is 443. Throws on anything that is not an
 * https origin (a path, a query, credentials, another scheme).
 */
export const canonicalTailnetOrigin = (origin: string): string => {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`Not an origin: ${origin}`);
  }
  if (u.protocol !== 'https:') throw new Error(`A tailnet endpoint is https: ${origin}`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error(`Not an origin: ${origin}`);
  }
  // URL lowercases the host and drops a default port; write the port back.
  return `https://${u.hostname}:${u.port === '' ? '443' : u.port}`;
};

export const gitServeNamespace = (input: NamespaceInput): string => {
  if (input.kind === 'loopback') {
    return `${LOOPBACK_LABEL}-${hash20(input.instanceId)}`;
  }
  const canonical = canonicalTailnetOrigin(input.origin);
  const label = new URL(canonical).hostname.split('.')[0]!;
  return `${label}-${hash20(canonical)}`;
};
