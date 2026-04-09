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

const projectStategraphParityTranscript = (transcript: any) => ({
  tree: {
    graphName: transcript.tree?.graphName,
    status: transcript.tree?.status,
  },
  finalAiContent: [...(transcript.values?.messages ?? [])]
    .reverse()
    .find((message: any) => message.type === "ai")?.content,
  messageEvents: (transcript.events ?? [])
    .filter((event: any) => event.method === "messages")
    .map((event: any) => {
      const data = event.params?.data ?? {};
      return {
        event: data.event,
        index: data.index,
        reason: data.reason,
        contentBlock:
          data.contentBlock == null
            ? undefined
            : {
                type: data.contentBlock.type,
                text: data.contentBlock.text,
              },
      };
    }),
});

const projectCreateAgentParityTranscript = (transcript: any) => ({
  tree: {
    graphName: transcript.tree?.graphName,
    status: transcript.tree?.status,
  },
  finalAiContent: [...(transcript.values?.messages ?? [])]
    .reverse()
    .find((message: any) => message.type === "ai")?.content,
  messageEvents: (transcript.events ?? [])
    .filter((event: any) => event.method === "messages")
    .map((event: any) => {
      const data = event.params?.data ?? {};
      return {
        event: data.event,
        index: data.index,
        reason: data.reason,
        contentBlock:
          data.contentBlock == null
            ? undefined
            : {
                type: data.contentBlock.type,
                text: data.contentBlock.text,
                name: data.contentBlock.name,
                args: data.contentBlock.args,
              },
      };
    }),
});

const projectDeepAgentParityTranscript = (transcript: any) => {
  const messages = transcript.values?.messages ?? [];
  const orchestratorMessage = messages.find(
    (message: any) =>
      message.type === "ai" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
  );

  return {
    tree: {
      graphName: transcript.tree?.graphName,
      status: transcript.tree?.status,
    },
    finalAiContent: [...messages]
      .reverse()
      .find((message: any) => message.type === "ai")?.content,
    orchestratorToolCalls: (orchestratorMessage?.tool_calls ?? []).map(
      (toolCall: any) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: {
          description: toolCall.args?.description,
          subagent_type: toolCall.args?.subagent_type,
        },
      })
    ),
    lifecycleEvents: (transcript.events ?? [])
      .filter((event: any) => event.method === "lifecycle")
      .map((event: any) => {
        const data = event.params?.data ?? {};
        return {
          namespace: event.params?.namespace ?? [],
          event: data.event,
          graphName: data.graphName,
        };
      }),
  };
};

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

      expect(projectStategraphParityTranscript(websocketTranscript)).toEqual(
        projectStategraphParityTranscript(sseTranscript)
      );
    }
  );

  websocketIt(
    "matches the finalized createAgent transcript over websocket and SSE",
    async () => {
      ({ cleanup: cleanupServer } = await startProtocolV2Server());

      const target = { kind: "agent" as const, id: "create_agent" };
      const channels = ["messages", "tools", "values"];
      const input = {
        messages: [
          { type: "human", content: "What is the weather in San Francisco?" },
        ],
      };

      const sseTranscript = await collectSseParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-create-agent-sse-parity-thread",
      });
      const websocketTranscript = await collectWebSocketParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-create-agent-websocket-parity-thread",
      });

      expect(projectCreateAgentParityTranscript(websocketTranscript)).toEqual(
        projectCreateAgentParityTranscript(sseTranscript)
      );
    }
  );

  websocketIt(
    "matches the finalized createDeepAgent transcript over websocket and SSE",
    async () => {
      ({ cleanup: cleanupServer } = await startProtocolV2Server());

      const target = { kind: "agent" as const, id: "deep_agent" };
      const channels = ["messages", "tools", "lifecycle", "values", "updates"];
      const input = {
        messages: [
          {
            type: "human",
            content: "Research protocol risks and inspect the sample dataset.",
          },
        ],
      };

      const sseTranscript = await collectSseParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-deep-agent-sse-parity-thread",
      });
      const websocketTranscript = await collectWebSocketParityTranscript({
        target,
        channels,
        input,
        threadId: "protocol-v2-deep-agent-websocket-parity-thread",
      });

      expect(projectDeepAgentParityTranscript(websocketTranscript)).toEqual(
        projectDeepAgentParityTranscript(sseTranscript)
      );
    }
  );
});
