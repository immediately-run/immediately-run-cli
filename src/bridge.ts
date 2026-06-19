/*
 * In-memory agent bridge queue (R3-76 / LLM_AND_AGENTS_SPEC §3.4,
 * LOCAL_DEV_AUTHED_SERVER_SPEC §2.1). The CLI runs an MCP server that a local
 * Claude Code connects to; a browser page cannot accept inbound sockets, so the
 * in-browser host **kernel connects OUT** to the localhost server and services
 * the tool calls. This module is the queue that sits between the two:
 *
 *   Claude Code --tools/call--> MCP server --enqueueCall--> [bridge]
 *                                                              |
 *     browser host (SSE /agent/pending) <--- takeForSubscriber|
 *     browser host (POST /agent/result) ---> resolveCall ------+
 *
 * It is deliberately transport-agnostic (no http/stdio here) so it unit-tests
 * without a server or a real MCP client — the enforcement-shaped seam stays a
 * plain function boundary (ways_of_working §5).
 */

import { randomUUID } from 'node:crypto';

/** A tool invocation handed to the browser host over `/agent/pending`. */
export interface BridgeCall {
  callId: string;
  tool: string;
  params: unknown;
}

/** What the browser host posts back to `/agent/result`. Exactly one of
 *  `result` / `error` is meaningful; a platform `forbidden` (over-reach, T23)
 *  arrives as an `error` and is relayed faithfully to the MCP caller. */
export interface BridgeResult {
  result?: unknown;
  error?: { code: string; message: string };
}

/** A grant-filtered catalog entry the browser host publishes via
 *  `/agent/catalog`; advertised verbatim to Claude Code as the MCP tool set, so
 *  the tools can never exceed the paired session's grants. */
export interface CatalogEntry {
  name: string;
  description?: string;
  /** JSON-Schema for the tool arguments; defaulted to `{type:'object'}`. */
  inputSchema?: unknown;
}

/** Default time a `tools/call` waits for the browser host before failing — a
 *  disconnected or wedged host must not hang Claude Code forever. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

type Pending = {
  call: BridgeCall;
  resolve: (r: BridgeResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The bridge state machine. Single-process, in-memory, one bridge per
 * `immediately.run agent` run.
 */
export class AgentBridge {
  /** call timeout, overridable for tests */
  private readonly timeoutMs: number;
  /** callId → in-flight call awaiting a /agent/result */
  private readonly inflight = new Map<string, Pending>();
  /** calls enqueued but not yet delivered to a live SSE subscriber */
  private readonly buffer: BridgeCall[] = [];
  /** live SSE writers (the browser host kernel); normally exactly one */
  private readonly subscribers = new Set<(call: BridgeCall) => void>();
  /** the grant-filtered catalog the host last published */
  private catalog: CatalogEntry[] = [];

  constructor(timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** Enqueue a tool call from the MCP side; resolves when the browser host
   *  posts the matching `/agent/result` (or rejects via a `timeout` error). */
  enqueueCall(tool: string, params: unknown): Promise<BridgeResult> {
    const callId = randomUUID();
    const call: BridgeCall = { callId, tool, params };
    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(callId);
        resolve({ error: { code: 'timeout', message: `no result for ${tool} within ${this.timeoutMs}ms` } });
      }, this.timeoutMs);
      this.inflight.set(callId, { call, resolve, timer });
      this.buffer.push(call);
      this.flush();
    });
  }

  /** Resolve an in-flight call from `/agent/result`. Returns false for an
   *  unknown/duplicate/timed-out callId (the server answers 404 then). */
  resolveCall(callId: unknown, payload: BridgeResult): boolean {
    if (typeof callId !== 'string') return false;
    const pending = this.inflight.get(callId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.inflight.delete(callId);
    pending.resolve(payload);
    return true;
  }

  /** Register an SSE subscriber (the browser host). Immediately drains any
   *  buffered calls to it. Returns an unsubscribe fn. */
  subscribe(send: (call: BridgeCall) => void): () => void {
    this.subscribers.add(send);
    this.flush();
    return () => {
      this.subscribers.delete(send);
    };
  }

  /** Replace the advertised catalog (`/agent/catalog`). */
  setCatalog(entries: CatalogEntry[]): void {
    this.catalog = entries;
  }

  getCatalog(): readonly CatalogEntry[] {
    return this.catalog;
  }

  /** test/inspection helpers */
  get pendingCount(): number {
    return this.inflight.size;
  }
  get bufferedCount(): number {
    return this.buffer.length;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  // Deliver buffered calls to one live subscriber (only the kernel connects, so
  // there is normally exactly one). Each call is delivered once; if no
  // subscriber is connected the calls wait in the buffer until one is.
  private flush(): void {
    if (this.subscribers.size === 0 || this.buffer.length === 0) return;
    const [send] = this.subscribers; // first subscriber
    const draining = this.buffer.splice(0, this.buffer.length);
    for (const call of draining) {
      try {
        send(call);
      } catch {
        // A dead writer: requeue and stop so the next subscribe re-drains.
        this.buffer.unshift(call);
        break;
      }
    }
  }
}
