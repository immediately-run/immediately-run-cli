/*
 * Minimal argv parser: splits a subcommand's args into positionals and flags.
 * Supports `--key value`, `--key=value`, and boolean `--key` / `-k`.
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
  /** Values of value-bearing flags that appear MORE than once, in argv order
   * (R3-785: `--header name=value` repeats). The LAST occurrence also lands in
   * `flags` as before, so single-use callers are unchanged. */
  repeated: Record<string, string[]>;
}

// A value-bearing flag (`--key value`). Bare boolean flags (`--key`) yield
// undefined, so they don't get mistaken for an option value.
export const flagValue = (
  flags: ParsedArgs['flags'],
  name: string,
): string | undefined => (typeof flags[name] === 'string' ? flags[name] : undefined);

const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'open',
  'no-lockset',
  'no-bake',
  'bundle-packages',
  'check',
  'republish',
  'origin-unsafe',
  'json',
  'fresh',
]);

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const values: Record<string, string[]> = {};
  const noteValue = (key: string, value: string) => {
    (values[key] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        const k = body.slice(0, eq);
        const v = body.slice(eq + 1);
        noteValue(k, v);
        flags[k] = v;
      } else if (BOOLEAN_FLAGS.has(body) || i + 1 >= argv.length || argv[i + 1]!.startsWith('-')) {
        flags[body] = true;
      } else {
        const v = argv[++i]!;
        noteValue(body, v);
        flags[body] = v;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  // Only genuinely repeated keys surface here — a single --key value stays flags-only.
  const repeated: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(values)) if (list.length > 1) repeated[k] = list;
  return { positionals, flags, repeated };
};
