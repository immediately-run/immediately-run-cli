/*
 * Deep links into hosted immediately.run, in one place (R3-1357).
 *
 * Every serving command hands the page its connection locator the same way: the
 * endpoint and the per-session token ride the URL FRAGMENT, which a browser
 * never sends to any server (LOCAL_DEVELOPMENT_SPEC §6.4). The host reads the two
 * values out of the hash and strips them before any sandbox frame is created.
 * `dev`, `agent`, `llm` and `git-serve` each build a different path in front of
 * that fragment; the fragment itself is written here and nowhere else, so its
 * two parameter names cannot drift between commands.
 */

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, '');

/** The connection locator: `#ir-endpoint=…&ir-token=…`, both values encoded. */
export const locatorFragment = (endpoint: string, token: string): string =>
  `#ir-endpoint=${encodeURIComponent(endpoint)}&ir-token=${encodeURIComponent(token)}`;

/**
 * A link to `<origin>/<path>` carrying the locator. `path` has no leading slash
 * and may be empty (the host's default landing).
 */
export const buildLocatorLink = (
  origin: string,
  path: string,
  endpoint: string,
  token: string,
): string => `${trimOrigin(origin)}/${path}${locatorFragment(endpoint, token)}`;

/** The editor route of a provider mount, with no leading slash. */
const providerPath = (provider: string, namespace: string, repository: string, ref: string): string =>
  `edit/${provider}/${namespace}/${repository}/${encodeURIComponent(ref)}`;

/**
 * A provider link with NO fragment, for a server that hands the page no
 * locator: on a tailnet the host finds the endpoint and credential in the
 * connection the user made (GIT_SERVE_SPEC R-GS-9).
 */
export const buildProviderLink = (
  origin: string,
  provider: string,
  namespace: string,
  repository: string,
  ref: string,
): string => `${trimOrigin(origin)}/${providerPath(provider, namespace, repository, ref)}`;

/**
 * A link that opens a provider mount in the editor:
 * `<origin>/edit/<provider>/<namespace>/<repository>/<ref>`. The ref is
 * percent-encoded, as the host's route parser expects (a branch may hold `/`).
 */
export const buildProviderDeepLink = (
  origin: string,
  provider: string,
  namespace: string,
  repository: string,
  ref: string,
  endpoint: string,
  token: string,
): string =>
  buildLocatorLink(origin, providerPath(provider, namespace, repository, ref), endpoint, token);
