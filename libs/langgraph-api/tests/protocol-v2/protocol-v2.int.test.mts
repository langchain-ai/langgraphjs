import { afterEach, describe, expect, it } from "vitest";

import {
  collectProtocolTranscript,
  collectSseParityTranscript,
  collectWebSocketParityTranscript,
  startProtocolV2Server,
} from "./utils.mjs";

let cleanupServer: (() => Promise<void>) | undefined;
const websocketIt =
  typeof WebSocket === "undefined" ? it.skip : it;

afterEach(async () => {
  if (cleanupServer != null) {
    await Promise.race([
      cleanupServer(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  cleanupServer = undefined;
});

describe("protocol v2 snapshots", () => {
  it("captures a stategraph transcript snapshot", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());

    const transcript = await collectProtocolTranscript({
      target: { kind: "graph", id: "stategraph_text" },
      channels: ["messages", "values"],
      input: {
        messages: [
          { type: "human", content: "Summarize the protocol draft." },
        ],
      },
      threadId: "protocol-v2-stategraph-thread",
    });

    expect(transcript).toMatchSnapshot();
  });

  it("captures a createAgent ReAct transcript snapshot", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());

    const transcript = await collectProtocolTranscript({
      target: { kind: "agent", id: "create_agent" },
      channels: ["messages", "tools", "values"],
      input: {
        messages: [
          { type: "human", content: "What is the weather in San Francisco?" },
        ],
      },
      threadId: "protocol-v2-create-agent-thread",
    });

    expect(transcript).toMatchSnapshot();
  });

  it("captures a createDeepAgent transcript snapshot", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());

    const transcript = await collectProtocolTranscript({
      target: { kind: "agent", id: "deep_agent" },
      channels: ["messages", "tools", "lifecycle", "values", "updates"],
      input: {
        messages: [
          {
            type: "human",
            content: "Research protocol risks and inspect the sample dataset.",
          },
        ],
      },
      threadId: "protocol-v2-deep-agent-thread",
    });

    expect(transcript).toMatchSnapshot();
  });

  websocketIt(
    "matches the finalized stategraph transcript over websocket and SSE",
    async () => {
      ({ cleanup: cleanupServer } = await startProtocolV2Server());

      const target = { kind: "graph" as const, id: "stategraph_text" };
      const channels = ["messages", "values"];
      const input = {
        messages: [
          { type: "human", content: "Summarize the protocol draft." },
        ],
      };

      const sseTranscript = await collectSseParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-sse-parity-thread",
      });
      const websocketTranscript = await collectWebSocketParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-websocket-parity-thread",
      });

      expect(websocketTranscript).toEqual(sseTranscript);
    }
  );
});
