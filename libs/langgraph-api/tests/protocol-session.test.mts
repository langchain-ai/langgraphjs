import { describe, expect, it } from "vitest";

import { RunProtocolSession } from "../src/protocol/session/index.mjs";
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
  it("emits input.requested once and strips interrupts from state channels", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["input", "values", "updates"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "updates",
      normalized: true,
      data: {
        node: "__interrupt__",
        values: [
          {
            id: "interrupt_1",
            value: {
              prompt: "Approve deployment?",
            },
          },
        ],
      },
    });
    await session.ingestSourceEvent({
      id: "2",
      event: "values",
      data: {
        __interrupt__: [
          {
            id: "interrupt_1",
            value: {
              prompt: "Approve deployment?",
            },
          },
        ],
        messages: ["still visible"],
      },
    });

    expect(sent).toEqual([
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "input.requested",
        params: {
          namespace: [],
          timestamp: expect.any(Number),
          data: {
            interrupt_id: "interrupt_1",
            payload: {
              prompt: "Approve deployment?",
            },
          },
        },
      },
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "values",
        params: {
          namespace: [],
          timestamp: expect.any(Number),
          data: {
            messages: ["still visible"],
          },
        },
      },
    ]);
  });

  it("replays buffered events that match a later subscription", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "updates|gp_two|p_two",
      normalized: true,
      data: { node: "c_one", values: { messages: ["Entered c_one node"] } },
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
          subscription_id: expect.any(String),
          replayed_events: 1,
        },
      },
      {
        type: "event",
        event_id: expect.any(String),
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

  it("forwards lifecycle started cause metadata unchanged", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["lifecycle"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "lifecycle|worker:0",
      normalized: true,
      data: {
        event: "started",
        graph_name: "worker",
        cause: { type: "toolCall", tool_call_id: "call_123" },
      },
    });

    expect(sent).toEqual([
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "lifecycle",
        params: {
          namespace: ["worker:0"],
          timestamp: expect.any(Number),
          data: {
            event: "started",
            graph_name: "worker",
            cause: { type: "toolCall", tool_call_id: "call_123" },
          },
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
      normalized: true,
      data: {
        event: "tool-started",
        tool_call_id: "tool_call_1",
        tool_name: "weather",
        input: {},
      },
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

  it("preserves raw namespace segments with task IDs", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["values"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "values|tools:call_123|model:worker_456",
      data: { messages: ["child"] },
    });

    const streamedEvent = sent.find(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(streamedEvent).toEqual({
      type: "event",
      event_id: expect.any(String),
      seq: expect.any(Number),
      method: "values",
      params: {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: { messages: ["child"] },
      },
    });
  });

  it("forwards normalized message protocol events", async () => {
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
      event: "messages|tools:call_123|model:worker_456",
      normalized: true,
      data: {
        event: "message-start",
        message_id: "message_1",
        role: "ai",
      },
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events[0]).toMatchObject({
      type: "event",
      method: "messages",
      params: {
        namespace: ["tools:call_123", "model:worker_456"],
        data: {
          event: "message-start",
          message_id: "message_1",
          role: "ai",
        },
      },
    });
  });

  it("ignores legacy tuple message events in the v2 protocol session", async () => {
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
      event: "messages|tools:call_123|model:worker_456",
      data: [
        {
          id: "message_1",
          type: "ai",
          content: "Hel",
        },
        {
          langgraph_checkpoint_ns: "tools:call_123|model:worker_456",
        },
      ],
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events).toEqual([]);
  });

  it("normalizes message payloads inside values snapshots", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["values"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "values",
      data: {
        messages: [
          {
            id: "human_1",
            type: "human",
            content: "Break down a smoke test plan.",
            additional_kwargs: {},
            response_metadata: {},
          },
          {
            id: "ai_1",
            type: "ai",
            content: "",
            additional_kwargs: {
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "task",
                    arguments: "{\"description\":\"Review risks\"}",
                  },
                },
              ],
            },
            response_metadata: {
              model_provider: "openai",
              usage: {
                input_tokens: 5,
                output_tokens: 2,
                total_tokens: 7,
              },
            },
            tool_call_chunks: [
              {
                id: "call_123",
                name: "task",
                args: "{\"description\":\"Review risks\"}",
                index: 0,
                type: "tool_call_chunk",
              },
            ],
            tool_calls: [],
            invalid_tool_calls: [],
          },
          {
            id: "tool_1",
            type: "tool",
            name: "task",
            tool_call_id: "call_123",
            content: "Risk review complete.",
            additional_kwargs: {},
            response_metadata: {},
            status: "success",
          },
        ],
        nested: {
          messages: [
            {
              id: "ai_2",
              type: "assistant",
              content: "Nested result",
              additional_kwargs: {},
              response_metadata: {},
              invalid_tool_calls: [
                {
                  id: "bad_1",
                  args: "{",
                  error: "Malformed args.",
                  type: "invalid_tool_call",
                },
              ],
            },
          ],
        },
      },
    });

    expect(sent).toEqual([
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "values",
        params: {
          namespace: [],
          timestamp: expect.any(Number),
          data: {
            messages: [
              {
                id: "human_1",
                type: "human",
                content: "Break down a smoke test plan.",
              },
              {
                id: "ai_1",
                type: "ai",
                content: "",
                tool_calls: [
                  {
                    id: "call_123",
                    name: "task",
                    args: {
                      description: "Review risks",
                    },
                    type: "tool_call",
                  },
                ],
              },
              {
                id: "tool_1",
                type: "tool",
                name: "task",
                tool_call_id: "call_123",
                content: "Risk review complete.",
                status: "success",
              },
            ],
            nested: {
              messages: [
                {
                  id: "ai_2",
                  type: "ai",
                  content: "Nested result",
                  invalid_tool_calls: [
                    {
                      id: "bad_1",
                      args: "{",
                      error: "Malformed args.",
                      type: "invalid_tool_call",
                    },
                  ],
                },
              ],
            },
          },
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
            graph_name: "nested",
            children: [
              {
                namespace: ["gp_two"],
                status: "started",
                graph_name: "gp_two",
                children: [
                  {
                    namespace: ["gp_two", "p_two"],
                    status: "started",
                    graph_name: "p_two",
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
