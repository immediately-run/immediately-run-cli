// Unit tests for the agent bridge queue + MCP message handler (R3-76). Runs
// against compiled dist/ (npm test builds first). No test-framework dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentBridge } from '../dist/bridge.js';
import { handleMcpMessage, toMcpToolName, MCP_PROTOCOL_VERSION } from '../dist/mcp.js';

// --- bridge queue ------------------------------------------------------------

test('enqueueCall resolves when a matching /agent/result arrives', async () => {
  const bridge = new AgentBridge();
  let delivered;
  bridge.subscribe((call) => (delivered = call));
  const p = bridge.enqueueCall('spaces:read', { path: '/x' });
  assert.equal(delivered.tool, 'spaces:read');
  assert.deepEqual(delivered.params, { path: '/x' });
  assert.equal(bridge.pendingCount, 1);
  assert.equal(bridge.resolveCall(delivered.callId, { result: { content: 'hi' } }), true);
  assert.deepEqual(await p, { result: { content: 'hi' } });
  assert.equal(bridge.pendingCount, 0);
});

test('buffered calls drain to a subscriber that connects later (host reconnect)', async () => {
  const bridge = new AgentBridge();
  const p = bridge.enqueueCall('spaces:list', {}); // no subscriber yet
  assert.equal(bridge.bufferedCount, 1);
  let delivered;
  bridge.subscribe((call) => (delivered = call));
  assert.equal(bridge.bufferedCount, 0);
  assert.equal(delivered.tool, 'spaces:list');
  bridge.resolveCall(delivered.callId, { result: 'ok' });
  assert.deepEqual(await p, { result: 'ok' });
});

test('resolveCall returns false for an unknown / duplicate callId', () => {
  const bridge = new AgentBridge();
  assert.equal(bridge.resolveCall('nope', { result: 1 }), false);
  assert.equal(bridge.resolveCall(123, { result: 1 }), false);
});

test('a call times out with a typed error rather than hanging forever', async () => {
  const bridge = new AgentBridge(20); // 20ms
  bridge.subscribe(() => {});
  const out = await bridge.enqueueCall('spaces:read', {});
  assert.equal(out.error.code, 'timeout');
  assert.equal(bridge.pendingCount, 0);
});

// --- MCP handler -------------------------------------------------------------

test('initialize advertises tools capability + protocol version', async () => {
  const bridge = new AgentBridge();
  const resp = await handleMcpMessage(bridge, { id: 1, method: 'initialize' });
  assert.equal(resp.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(resp.result.capabilities, { tools: {} });
});

test('notifications (no id) get no response', async () => {
  const bridge = new AgentBridge();
  assert.equal(await handleMcpMessage(bridge, { method: 'notifications/initialized' }), null);
});

test('tools/list echoes the published grant-filtered catalog (colon → mcp-safe name)', async () => {
  const bridge = new AgentBridge();
  bridge.setCatalog([{ name: 'spaces:read', description: 'read a file' }]);
  const resp = await handleMcpMessage(bridge, { id: 2, method: 'tools/list' });
  assert.equal(resp.result.tools.length, 1);
  assert.equal(resp.result.tools[0].name, 'spaces__read');
  assert.equal(resp.result.tools[0].description, 'read a file');
  assert.deepEqual(resp.result.tools[0].inputSchema, { type: 'object' });
  assert.equal(toMcpToolName('spaces:read'), 'spaces__read');
});

test('tools/call enqueues by the ORIGINAL catalog name and returns the result text', async () => {
  const bridge = new AgentBridge();
  bridge.setCatalog([{ name: 'spaces:read' }]);
  let delivered;
  bridge.subscribe((call) => (delivered = call));
  const callP = handleMcpMessage(bridge, {
    id: 3,
    method: 'tools/call',
    params: { name: 'spaces__read', arguments: { path: '/a' } },
  });
  // the bridge sees the platform name, not the mcp-safe one
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(delivered.tool, 'spaces:read');
  bridge.resolveCall(delivered.callId, { result: 'file body' });
  const resp = await callP;
  assert.equal(resp.result.isError, undefined);
  assert.equal(resp.result.content[0].text, 'file body');
});

test('tools/call relays a platform forbidden (over-reach, T23) as an MCP error', async () => {
  const bridge = new AgentBridge();
  bridge.setCatalog([{ name: 'spaces:admin' }]);
  let delivered;
  bridge.subscribe((call) => (delivered = call));
  const callP = handleMcpMessage(bridge, {
    id: 4,
    method: 'tools/call',
    params: { name: 'spaces__admin', arguments: {} },
  });
  await new Promise((r) => setTimeout(r, 0));
  bridge.resolveCall(delivered.callId, { error: { code: 'forbidden', message: 'not granted' } });
  const resp = await callP;
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /forbidden: not granted/);
});

test('tools/call for a tool OUTSIDE the catalog is an error, never enqueued', async () => {
  const bridge = new AgentBridge();
  bridge.setCatalog([{ name: 'spaces:read' }]); // admin not granted → not advertised
  const resp = await handleMcpMessage(bridge, {
    id: 5,
    method: 'tools/call',
    params: { name: 'spaces__admin', arguments: {} },
  });
  assert.equal(resp.result.isError, true);
  assert.equal(bridge.pendingCount, 0, 'must not enqueue an uncatalogued tool');
});

test('unknown method → JSON-RPC method-not-found', async () => {
  const bridge = new AgentBridge();
  const resp = await handleMcpMessage(bridge, { id: 6, method: 'frobnicate' });
  assert.equal(resp.error.code, -32601);
});
