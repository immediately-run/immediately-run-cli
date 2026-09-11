/** The known providers: the prefix/spelling a user may type, and the URL host
 *  that names the same provider. A second provider is a row here (FRONT_DOOR_IA
 *  §5.1 — the chip renders one static option per row). */
declare const PROVIDERS: Readonly<Record<string, string>>;
type Launch = {
    kind: 'location';
    provider: string;
    namespace: string;
    repository: string;
    ref?: string;
    /** What the results row shows, e.g. `github:acme/todo@feat/x`. */
    display: string;
    /** A root-relative platform path, e.g. `/present/github/acme/todo/feat%2Fx`. */
    presentPath: string;
} | {
    kind: 'platform-url';
    path: string;
} | {
    kind: 'unknown-provider';
    provider: string;
} | {
    kind: 'text';
    query: string;
};
declare function parseLaunch(input: string, defaultProvider?: string): Launch;

export { type Launch, PROVIDERS, parseLaunch };
