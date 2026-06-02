#!/usr/bin/env node
/*
 * @immediately-run/cli — command-line tools for immediately.run.
 *
 * Subcommand dispatcher. v1 ships a single command, `cache-zip`; the structure
 * is deliberately extensible so future commands slot in alongside it.
 */

import { parseArgs } from './args.js';
import { runCacheZip } from './commands/cacheZip.js';

const COMMANDS: Record<string, (args: ReturnType<typeof parseArgs>) => number> = {
  'cache-zip': runCacheZip,
};

const USAGE = `immediately-run — command-line tools for immediately.run

Usage: immediately-run <command> [options]

Commands:
  cache-zip   Build a cached repository zip (with a contribute manifest sidecar)

Run 'immediately-run <command> --help' for command-specific options.`;

const main = (): number => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    return 1;
  }
  return handler(parseArgs(rest));
};

try {
  process.exit(main());
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
