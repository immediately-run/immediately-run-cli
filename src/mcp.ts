/*
 * Minimal MCP (Model Context Protocol) server logic for the agent bridge
 * (R3-76 / LLM_AND_AGENTS_SPEC §3.4). Claude Code consumes MCP servers natively
 * over **stdio** (the v1-only transport — LA-5: no listening socket on the MCP
 * side, so there is nothing for a drive-by page or DNS-rebinding host to reach).
 *
 * The platform's catalog is already MCP-tool-shaped (§5.5/§5.10), so the adapter
 * is near-identity: `tools/list` echoes the host-published grant-filtered
 * catalog; `tools/call` enqueues a `{callId,tool,params}` on the bridge and
 * returns the browser host's `/agent/result`. A platform `forbidden` (over-reach,
 * T23) is relayed back as an MCP tool error — the catalog can never advertise a
 * tool the paired session's grants don't already permit.
 *
 * `handleMcpMessage` is a pure async function over one JSON-RPC message, so it
 * unit-tests without stdio or a real client; `runMcpStdio` is the thin
 * newline-delimited framing driver around it.
 */

import type { AgentBridge, CatalogEntry } from './bridge.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'immediately-run-bridge';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// MCP/Claude-Code tool names admit only [a-zA-Z0-9_-]; platform catalog names
// use a colon (`spaces:read`). Map the colon to a double underscore for the
// MCP-facing name, and recover the original by scanning the published catalog
// (so `tools/call` enqueues the exact platform tool name the host expects).
export const toMcpToolName = (catalogName: string): string => catalogName.replace(/:/g, '__');

const fromMcpToolName = (mcpName: string, catalog: readonly CatalogEntry[]): string | undefined =>
  catalog.find((e) => toMcpToolName(e.name) === mcpName)?.name;

const toMcpTool = (entry: CatalogEntry) => ({
  name: toMcpToolName(entry.name),
  description: entry.description ?? `Platform action ${entry.name}`,
  // MCP requires an object JSON-Schema; default to a permissive object when the
  // catalog entry carries no schema.
  inputSchema:
    entry.inputSchema && typeof entry.inputSchema === 'object'
      ? entry.inputSchema
      : { type: 'object' },
});

const ok = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});

const err = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/**
 * Handle one JSON-RPC message. Returns the response, or `null` for a
 * notification (no `id`) that takes no reply.
 */
export const handleMcpMessage = async (
  bridge: AgentBridge,
  msg: JsonRpcRequest,
): Promise<JsonRpcResponse | null> => {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1' },
      });
    case 'ping':
      return ok(msg.id, {});
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications: never answered
    case 'tools/list':
      return ok(msg.id, { tools: bridge.getCatalog().map(toMcpTool) });
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const catalog = bridge.getCatalog();
      const toolName =
        typeof params.name === 'string' ? fromMcpToolName(params.name, catalog) : undefined;
      if (!toolName) {
        // Unknown / not-in-catalog tool: the catalog is the grant-filtered
        // ceiling, so a tool outside it is reported as an error, not enqueued.
        return ok(msg.id, {
          content: [{ type: 'text', text: `unknown tool: ${String(params.name)}` }],
          isError: true,
        });
      }
      const outcome = await bridge.enqueueCall(toolName, params.arguments ?? {});
      if (outcome.error) {
        // Faithful relay of a platform error (e.g. `forbidden` over-reach, T23).
        return ok(msg.id, {
          content: [
            { type: 'text', text: `${outcome.error.code}: ${outcome.error.message}` },
          ],
          isError: true,
        });
      }
      const text =
        typeof outcome.result === 'string'
          ? outcome.result
          : JSON.stringify(outcome.result ?? null);
      return ok(msg.id, { content: [{ type: 'text', text }] });
    }
    default:
      // Unknown method: JSON-RPC "Method not found" (-32601), unless it was a
      // notification (then stay silent).
      return isNotification ? null : err(msg.id, -32601, `method not found: ${msg.method}`);
  }
};

/**
 * Drive `handleMcpMessage` over a newline-delimited JSON-RPC stdio transport
 * (MCP's stdio framing). Each inbound line is one JSON message; each response is
 * written as one line. Returns a stop fn.
 */
export const runMcpStdio = (
  bridge: AgentBridge,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout,
): (() => void) => {
  let buf = '';
  const onData = (chunk: Buffer | string) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line);
      } catch {
        // Unparseable line: a parse-error response with a null id (JSON-RPC).
        stdout.write(JSON.stringify(err(null, -32700, 'parse error')) + '\n');
        continue;
      }
      void handleMcpMessage(bridge, msg).then((resp) => {
        if (resp) stdout.write(JSON.stringify(resp) + '\n');
      });
    }
  };
  stdin.on('data', onData);
  return () => stdin.off('data', onData);
};
