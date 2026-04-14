import path from "node:path";
import url from "node:url";
import fs from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  collectProtocolTranscript,
  collectSseParityTranscript,
  collectWebSocketParityTranscript,
  globalConfig,
  openSseSession,
  readSseEventsUntilIdle,
  resetProtocolV2ServerState,
  sendSessionCommand,
  startProtocolV2Server,
  TEST_API_URL,
} from "./utils.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let cleanupServer: (() => Promise<void>) | undefined;
const websocketIt =
  typeof WebSocket === "undefined" ? it.skip : it;

const projectStategraphParityTranscript = (transcript: any) => ({
  tree: {
    graph_name: transcript.tree?.graph_name,
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
        content_block:
          data.content_block == null
            ? undefined
            : {
                type: data.content_block.type,
                text: data.content_block.text,
              },
      };
    }),
});

const projectCreateAgentParityTranscript = (transcript: any) => ({
  tree: {
    graph_name: transcript.tree?.graph_name,
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
        content_block:
          data.content_block == null
            ? undefined
            : {
                type: data.content_block.type,
                text: data.content_block.text,
                name: data.content_block.name,
                args: data.content_block.args,
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
      graph_name: transcript.tree?.graph_name,
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
          graph_name: data.graph_name,
        };
      }),
  };
};

/**
 * clean up the .langgraph_api directory before each test
 */
beforeAll(async () => {
  await fs.rm(path.resolve(__dirname, "graphs", ".langgraph_api"), {
    recursive: true,
    force: true,
  });
});

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
  it("allows SSE cleanup after session.close", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());
    await resetProtocolV2ServerState();

    const { sessionId, eventsResponse } = await openSseSession({
      kind: "graph",
      id: "stategraph_text",
    });

    try {
      const closeResponse = await sendSessionCommand(sessionId, {
        id: 1,
        method: "session.close",
        params: {},
      });
      expect(closeResponse.type).toBe("success");

      const deleteResponse = await fetch(`${TEST_API_URL}/v2/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(204);
    } finally {
      await eventsResponse.body?.cancel();
    }
  });

  it("captures a stategraph transcript snapshot", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());
    await resetProtocolV2ServerState();

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
    await resetProtocolV2ServerState();

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
    await resetProtocolV2ServerState();

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

  it("routes interrupts over input.requested and resumes with input.respond", async () => {
    ({ cleanup: cleanupServer } = await startProtocolV2Server());
    await resetProtocolV2ServerState();

    const { sessionId, eventsResponse } = await openSseSession({
      kind: "graph",
      id: "interrupt_graph",
    });

    try {
      const subscribeResponse = await sendSessionCommand(sessionId, {
        id: 1,
        method: "subscription.subscribe",
        params: {
          channels: ["input", "values", "updates"],
        },
      });
      expect(subscribeResponse.type).toBe("success");

      const runResponse = await sendSessionCommand(sessionId, {
        id: 2,
        method: "run.input",
        params: {
          input: { request: "Send the rollout update." },
          config: {
            configurable: {
              ...globalConfig.configurable,
              thread_id: "protocol-v2-interrupt-thread",
            },
          },
        },
      });
      expect(runResponse).toMatchObject({
        type: "success",
        id: 2,
        result: { run_id: expect.any(String) },
      });

      const initialEvents = await readSseEventsUntilIdle(eventsResponse, 1_000);
      const inputEvent = initialEvents.find(
        (event) => event.event === "input.requested"
      );

      expect(inputEvent?.data).toMatchObject({
        type: "event",
        method: "input.requested",
        params: {
          namespace: [],
          data: {
            interrupt_id: expect.any(String),
            payload: {
              prompt: "Approve the outbound action?",
              request: "Send the rollout update.",
            },
          },
        },
      });
      expect(
        initialEvents
          .filter((event) => event.event === "values" || event.event === "updates")
          .every((event) => !JSON.stringify(event.data).includes("__interrupt__"))
      ).toBe(true);

      const interruptId = (
        inputEvent?.data as {
          params?: { data?: { interrupt_id?: string } };
        }
      )?.params?.data?.interrupt_id;
      expect(typeof interruptId).toBe("string");

      const respondResponse = await sendSessionCommand(sessionId, {
        id: 3,
        method: "input.respond",
        params: {
          namespace: [],
          interrupt_id: interruptId,
          response: {
            approved: true,
            reviewer: "protocol-v2",
          },
        },
      });
      expect(respondResponse).toMatchObject({
        type: "success",
        id: 3,
        result: {},
      });

      const resumedEvents = await readSseEventsUntilIdle(eventsResponse, 1_000);
      expect(
        resumedEvents
          .filter((event) => event.event === "values" || event.event === "updates")
          .every((event) => !JSON.stringify(event.data).includes("__interrupt__"))
      ).toBe(true);

      const stateResponse = await sendSessionCommand(sessionId, {
        id: 4,
        method: "state.get",
        params: {},
      });
      expect(stateResponse).toMatchObject({
        type: "success",
        id: 4,
        result: {
          values: {
            request: "Send the rollout update.",
            decision: {
              approved: true,
              reviewer: "protocol-v2",
            },
            completed: true,
          },
        },
      });
    } finally {
      await eventsResponse.body?.cancel();
    }
  });

  websocketIt(
    "matches the finalized stategraph transcript over websocket and SSE",
    async () => {
      ({ cleanup: cleanupServer } = await startProtocolV2Server());
      await resetProtocolV2ServerState();

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
      await resetProtocolV2ServerState();

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
      await resetProtocolV2ServerState();

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
