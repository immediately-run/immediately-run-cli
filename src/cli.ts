#!/usr/bin/env node
/*
 * @immediately-run/cli — command-line tools for immediately.run.
 *
 * Subcommand dispatcher. v1 ships a single command, `cache-zip`; the structure
 * is deliberately extensible so future commands slot in alongside it.
 */

import { parseArgs } from './args.js';
import { runAgent } from './commands/agent.js';
import { runCacheZip } from './commands/cacheZip.js';
import { runDev } from './commands/dev.js';
import { runLlm } from './commands/llm.js';
import { runPinRelease } from './commands/pinRelease.js';
import { runPreAuth } from './commands/preauth.js';

// Handlers may be synchronous (cache-zip) or long-running async (dev/agent/llm,
// which resolve only on shutdown).
const COMMANDS: Record<string, (args: ReturnType<typeof parseArgs>) => number | Promise<number>> = {
  agent: runAgent,
  'cache-zip': runCacheZip,
  dev: runDev,
  llm: runLlm,
  'pin-release': runPinRelease,
  preauth: runPreAuth,
};

const USAGE = `immediately.run — command-line tools for immediately.run

Usage: immediately.run <command> [options]

Commands:
  agent       Bridge a local Claude Code to the in-browser host (MCP over stdio)
  cache-zip   Build a cached repository zip (with a contribute manifest sidecar)
  dev         Serve the current project to hosted immediately.run over localhost
  llm         Localhost LLM proxy to a single configured upstream (local models)
  pin-release Resolve UI release authoring files into pinned lock artifacts
  preauth     Apply an M1 pre-authorization policy to an app (headless/CI)

Run 'immediately.run <command> --help' for command-specific options.`;

const main = async (): Promise<number> => {
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
  return await handler(parseArgs(rest));
};

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
