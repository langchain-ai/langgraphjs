import { afterEach, describe, expect, it, vi } from "vitest";

const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
const hasGlobalWebSocket =
  nodeMajor >= 22 && typeof globalThis.WebSocket === "function";

import { Client } from "../../index.js";
import {
  startMockProtocolServer,
  type MockProtocolEvent,
  type MockProtocolServer,
} from "./mock-protocol-server.js";

const TEST_EVENTS: MockProtocolEvent[] = [
  {
    type: "event",
    method: "values",
    event_id: "evt_1",
    seq: 1,
    params: { namespace: [], data: { step: 1 } },
  },
  {
    type: "event",
    method: "values",
    event_id: "evt_2",
    seq: 2,
    params: { namespace: [], data: { step: 2 } },
  },
  {
    type: "event",
    method: "values",
    event_id: "evt_3",
    seq: 3,
    params: { namespace: [], data: { step: 3 } },
  },
  {
    type: "event",
    method: "values",
    event_id: "evt_4",
    seq: 4,
    params: { namespace: [], data: { step: 4 } },
  },
];

function collectSeqsFromThread(
  thread: ReturnType<Client["threads"]["stream"]>
): { seqs: number[]; off: () => void } {
  const seqs: number[] = [];
  const off = thread.onEvent((event) => {
    if (event.type === "event" && typeof event.seq === "number") {
      seqs.push(event.seq);
    }
  });
  return { seqs, off };
}

describe.skipIf(!hasGlobalWebSocket)(
  "client.threads.stream reconnection (mock langgraph-api)",
  () => {
    let server: MockProtocolServer;

    afterEach(async () => {
      await server?.close();
    });

    it("SSE: run.start streams all values after the server drops the connection", async () => {
      server = await startMockProtocolServer({
        threadId: "thread_sse_client_reconnect",
        events: TEST_EVENTS,
        failSseAfterDelivered: 2,
      });

      const onReconnect = vi.fn();
      const client = new Client({ apiUrl: server.apiUrl, apiKey: null });
      const thread = client.threads.stream(server.threadId, {
        assistantId: "assistant_mock",
        transport: "sse",
        maxReconnectAttempts: 3,
        reconnectDelayMs: () => 0,
        onReconnect,
      });

      const { seqs, off } = collectSeqsFromThread(thread);
      try {
        const run = await thread.run.start({ input: { prompt: "hi" } });
        expect(run).toBeDefined();

        await vi.waitFor(
          () => {
            expect(onReconnect).toHaveBeenCalledTimes(1);
            expect(server.sseConnectionCount()).toBeGreaterThanOrEqual(2);
            expect(thread.ordering.lastSeenSeq).toBe(4);
          },
          { timeout: 10_000 }
        );

        expect([...new Set(seqs)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      } finally {
        off();
        await thread.close();
      }
    });

    it("WebSocket: run.start streams all values after the server drops the connection", async () => {
      server = await startMockProtocolServer({
        threadId: "thread_ws_client_reconnect",
        events: TEST_EVENTS,
        failWsAfterDelivered: 2,
      });

      const onReconnect = vi.fn();
      const client = new Client({ apiUrl: server.apiUrl, apiKey: null });
      const thread = client.threads.stream(server.threadId, {
        assistantId: "assistant_mock",
        transport: "websocket",
        maxReconnectAttempts: 3,
        reconnectDelayMs: () => 0,
        onReconnect,
      });

      const { seqs, off } = collectSeqsFromThread(thread);
      try {
        const run = await thread.run.start({ input: { prompt: "hi" } });
        expect(run).toBeDefined();

        await vi.waitFor(
          () => {
            expect(onReconnect).toHaveBeenCalledTimes(1);
            expect(server.wsConnectionCount()).toBeGreaterThanOrEqual(2);
            expect(thread.ordering.lastSeenSeq).toBe(4);
          },
          { timeout: 10_000 }
        );

        // Replay on reconnect may redeliver early seqs; unique set is enough.
        expect([...new Set(seqs)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      } finally {
        off();
        await thread.close();
      }
    });
  }
);
