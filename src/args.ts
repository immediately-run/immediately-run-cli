/*
 * Minimal argv parser: splits a subcommand's args into positionals and flags.
 * Supports `--key value`, `--key=value`, and boolean `--key` / `-k`.
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
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
  'bundle-packages',
  'check',
  'republish',
  'origin-unsafe',
  'json',
]);

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(body) || i + 1 >= argv.length || argv[i + 1]!.startsWith('-')) {
        flags[body] = true;
      } else {
        flags[body] = argv[++i]!;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
};
