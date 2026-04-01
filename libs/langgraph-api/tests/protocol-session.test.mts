import { describe, expect, it } from "vitest";

import { RunProtocolSession } from "../src/protocol/session.mjs";
import type { Run } from "../src/storage/types.mjs";

const createRun = (overrides?: Partial<Run>): Run =>
  ({
    run_id: "00000000-0000-7000-8000-000000000001",
    thread_id: "00000000-0000-7000-8000-000000000002",
    assistant_id: "nested",
    created_at: new Date("2026-04-01T00:00:00.000Z"),
    updated_at: new Date("2026-04-01T00:00:00.000Z"),
    status: "running",
    metadata: {},
    multitask_strategy: "reject",
    kwargs: {
      config: { configurable: { graph_id: "nested" } },
      resumable: true,
    },
    ...overrides,
  }) satisfies Run;

const createSession = (
  sent: unknown[],
  runOverrides?: Partial<Run>
): RunProtocolSession => {
  const run = createRun(runOverrides);
  return new RunProtocolSession({
    runId: run.run_id,
    threadId: run.thread_id,
    initialRun: run,
    getRun: async () => run,
    send: (payload) => {
      sent.push(JSON.parse(payload));
    },
  });
};

describe("RunProtocolSession", () => {
  it("replays buffered events that match a later subscription", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "updates|gp_two|p_two",
      data: { c_one: { messages: ["Entered c_one node"] } },
    });

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["updates"], namespaces: [["gp_two"]] },
      })
    );

    expect(sent).toEqual([
      {
        type: "success",
        id: 1,
        result: {
          subscriptionId: expect.any(String),
          replayedEvents: 1,
        },
      },
      {
        type: "event",
        eventId: expect.any(String),
        seq: expect.any(Number),
        method: "updates",
        params: {
          namespace: ["gp_two", "p_two"],
          timestamp: expect.any(Number),
          node: "c_one",
          data: { messages: ["Entered c_one node"] },
        },
      },
    ]);
  });

  it("filters live events by channel, namespace prefix, and depth", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: {
          channels: ["values"],
          namespaces: [["gp_two"]],
          depth: 1,
        },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "values|gp_two",
      data: { messages: ["parent"] },
    });
    await session.ingestSourceEvent({
      id: "2",
      event: "values|gp_two|p_two",
      data: { messages: ["child"] },
    });
    await session.ingestSourceEvent({
      id: "3",
      event: "values|gp_two|p_two|c_two",
      data: { messages: ["grandchild"] },
    });
    await session.ingestSourceEvent({
      id: "4",
      event: "tools|gp_two",
      data: { event: "on_tool_start", name: "weather", input: {} },
    });

    const streamedEvents = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(streamedEvents).toHaveLength(2);
    expect(streamedEvents.map((event) => event.method)).toEqual([
      "values",
      "values",
    ]);
    expect(streamedEvents.map((event) => event.params)).toEqual([
      {
        namespace: ["gp_two"],
        timestamp: expect.any(Number),
        data: { messages: ["parent"] },
      },
      {
        namespace: ["gp_two", "p_two"],
        timestamp: expect.any(Number),
        data: { messages: ["child"] },
      },
    ]);
  });

  it("normalizes legacy message events into protocol message lifecycle events", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["messages"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "messages/metadata",
      data: {
        message_1: {
          metadata: { langgraph_node: "agent", model_name: "fake" },
        },
      },
    });
    await session.ingestSourceEvent({
      id: "2",
      event: "messages/partial",
      data: [{ id: "message_1", type: "ai", content: "Hel" }],
    });
    await session.ingestSourceEvent({
      id: "3",
      event: "messages/partial",
      data: [{ id: "message_1", type: "ai", content: "Hello" }],
    });
    await session.ingestSourceEvent({
      id: "4",
      event: "messages/complete",
      data: [{ id: "message_1", type: "ai", content: "Hello" }],
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events.map((event) => event.params)).toEqual([
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "message-start",
          messageId: "message_1",
          metadata: { langgraph_node: "agent", model_name: "fake" },
        },
      },
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "text", text: "" },
        },
      },
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "Hel" },
        },
      },
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "lo" },
        },
      },
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-finish",
          index: 0,
          contentBlock: { type: "text", text: "Hello" },
        },
      },
      {
        namespace: [],
        timestamp: expect.any(Number),
        data: {
          event: "message-finish",
          reason: "stop",
        },
      },
    ]);
  });

  it("returns an agent tree built from observed namespaces", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "values|gp_two|p_two",
      data: { messages: ["child"] },
    });
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 7,
        method: "agent.getTree",
        params: {},
      })
    );

    expect(sent).toEqual([
      {
        type: "success",
        id: 7,
        result: {
          tree: {
            namespace: [],
            status: "running",
            graphName: "nested",
            children: [
              {
                namespace: ["gp_two"],
                status: "spawned",
                graphName: "gp_two",
                children: [
                  {
                    namespace: ["gp_two", "p_two"],
                    status: "spawned",
                    graphName: "p_two",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
  });
});
