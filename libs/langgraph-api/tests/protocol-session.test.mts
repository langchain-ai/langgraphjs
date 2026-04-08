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
      eventId: expect.any(String),
      seq: expect.any(Number),
      method: "values",
      params: {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: { messages: ["child"] },
      },
    });
  });

  it("derives legacy message namespaces from checkpoint metadata", async () => {
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
          metadata: {
            langgraph_checkpoint_ns: "tools:call_123|model:worker_456",
          },
        },
      },
    });
    await session.ingestSourceEvent({
      id: "2",
      event: "messages/partial",
      data: [{ id: "message_1", type: "ai", content: "Hello" }],
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
          messageId: "message_1",
        },
      },
    });

    expect(events[1]).toMatchObject({
      type: "event",
      method: "messages",
      params: {
        namespace: ["tools:call_123", "model:worker_456"],
        data: {
          event: "content-block-start",
          index: 0,
        },
      },
    });
  });

  it("normalizes namespaced tuple message events into protocol lifecycle events", async () => {
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

    expect(events.map((event) => event.params)).toEqual([
      {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: {
          event: "message-start",
          messageId: "message_1",
        },
      },
      {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "text", text: "" },
        },
      },
      {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "Hel" },
        },
      },
    ]);
  });

  it("normalizes tuple tool-call chunks and strips non-protocol metadata", async () => {
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
      event: "messages|model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87",
      data: [
        {
          id: "chatcmpl-1",
          type: "ai",
          content: "",
          tool_call_chunks: [
            {
              args: "scrip",
              index: 0,
              type: "tool_call_chunk",
            },
          ],
          additional_kwargs: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: "scrip",
                },
              },
            ],
          },
          response_metadata: {
            model_provider: "openai",
            usage: {},
          },
          tool_calls: [],
          invalid_tool_calls: [
            {
              name: "",
              args: "scrip",
              error: "Malformed args.",
              type: "invalid_tool_call",
            },
          ],
        },
        {
          tags: [],
          ls_integration: "deepagents",
          created_by: "system",
          run_attempt: 1,
          langgraph_version: "1.2.6",
          langgraph_plan: "developer",
          langgraph_host: "self-hosted",
          langgraph_api_url: "http://localhost:2024",
          thread_id: "thread_123",
          run_id: "run_123",
          graph_id: "deep-agent",
          assistant_id: "assistant_123",
          langgraph_step: 3,
          langgraph_node: "model_request",
          langgraph_triggers: ["branch:to:model_request"],
          langgraph_path: ["__pregel_pull", "model_request"],
          langgraph_checkpoint_ns:
            "model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87",
          __pregel_task_id: "task_123",
          checkpoint_ns:
            "model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87",
          ls_provider: "openai",
          ls_model_name: "gpt-4o-mini",
          ls_model_type: "chat",
          versions: {
            "@langchain/core": "1.1.31",
            "@langchain/openai": "1.2.13",
          },
        },
      ],
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events.map((event) => event.params)).toEqual([
      {
        namespace: ["model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87"],
        timestamp: expect.any(Number),
        data: {
          event: "message-start",
          messageId: "chatcmpl-1",
          metadata: {
            provider: "openai",
            model: "gpt-4o-mini",
            modelType: "chat",
            runId: "run_123",
            threadId: "thread_123",
          },
        },
      },
      {
        namespace: ["model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "tool_call_chunk", args: "" },
        },
      },
      {
        namespace: ["model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "tool_call_chunk", args: "scrip" },
        },
      },
    ]);
  });

  it("parses finalized OpenAI tool-call arguments before emitting protocol events", async () => {
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
      event: "messages|model_request:test",
      data: [
        {
          id: "chatcmpl-final",
          type: "ai",
          content: "",
          tool_call_chunks: [
            {
              name: "task",
              args: "{\"description\":\"hi\"}",
              id: "call_123",
              index: 0,
              type: "tool_call_chunk",
            },
          ],
          additional_kwargs: {
            stop_reason: "tool_calls",
          },
          response_metadata: {
            finish_reason: "tool_calls",
          },
          tool_calls: [
            {
              index: 0,
              id: "call_123",
              type: "function",
              function: {
                name: "task",
                arguments: "{\"description\":\"hi\"}",
              },
            },
          ],
          invalid_tool_calls: [],
        },
        {
          langgraph_checkpoint_ns: "model_request:test",
          ls_provider: "openai",
        },
      ],
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events.map((event) => event.params)).toEqual([
      {
        namespace: ["model_request:test"],
        timestamp: expect.any(Number),
        data: {
          event: "message-start",
          messageId: "chatcmpl-final",
          metadata: {
            provider: "openai",
          },
        },
      },
      {
        namespace: ["model_request:test"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          contentBlock: {
            type: "tool_call_chunk",
            id: "call_123",
            name: "task",
            args: "",
          },
        },
      },
      {
        namespace: ["model_request:test"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: {
            type: "tool_call_chunk",
            id: "call_123",
            name: "task",
            args: "{\"description\":\"hi\"}",
          },
        },
      },
      {
        namespace: ["model_request:test"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-finish",
          index: 0,
          contentBlock: {
            type: "tool_call",
            id: "call_123",
            name: "task",
            args: {
              description: "hi",
            },
          },
        },
      },
      {
        namespace: ["model_request:test"],
        timestamp: expect.any(Number),
        data: {
          event: "message-finish",
          reason: "tool_use",
          metadata: {
            finish_reason: "tool_calls",
          },
        },
      },
    ]);
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
        eventId: expect.any(String),
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

  it("emits synthetic subagent events from root task updates", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["lifecycle", "messages", "values", "updates"] },
      })
    );
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "1",
      event: "updates",
      data: {
        model_request: {
          messages: [
            {
              id: "ai_1",
              type: "ai",
              content: "",
              tool_calls: [
                {
                  id: "call_123",
                  name: "task",
                  args: {
                    description: "Research protocol details",
                    subagent_type: "protocol-researcher",
                  },
                  type: "tool_call",
                },
              ],
            },
          ],
        },
      },
    });

    await session.ingestSourceEvent({
      id: "2",
      event: "updates",
      data: {
        tools: {
          messages: [
            {
              id: "tool_1",
              type: "tool",
              name: "task",
              tool_call_id: "call_123",
              content: "Research summary",
            },
          ],
        },
      },
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "lifecycle",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: {
              event: "spawned",
              graphName: "tools",
            },
          }),
        }),
        expect.objectContaining({
          method: "messages",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: expect.objectContaining({
              event: "message-start",
              messageId: "subagent:call_123:human",
            }),
          }),
        }),
        expect.objectContaining({
          method: "messages",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: expect.objectContaining({
              event: "content-block-delta",
              index: 0,
              contentBlock: {
                type: "text",
                text: "Research protocol details",
              },
            }),
          }),
        }),
        expect.objectContaining({
          method: "values",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: expect.objectContaining({
              messages: [
                expect.objectContaining({
                  type: "human",
                  content: "Research protocol details",
                }),
                expect.objectContaining({
                  type: "ai",
                  content: "Research summary",
                }),
              ],
            }),
          }),
        }),
        expect.objectContaining({
          method: "lifecycle",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: {
              event: "completed",
              graphName: "tools",
            },
          }),
        }),
      ])
    );
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
          metadata: {
            ls_provider: "openai",
            model_name: "fake",
            model_type: "chat",
            run_id: "run_123",
            thread_id: "thread_123",
            system_fingerprint: "fp_123",
            service_tier: "default",
            temperature: 0.2,
            langgraph_node: "agent",
            langgraph_checkpoint_ns: "model:checkpoint",
            versions: { "@langchain/openai": "1.4.3" },
          },
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
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "message-start",
          messageId: "message_1",
          metadata: {
            provider: "openai",
            model: "fake",
            modelType: "chat",
            runId: "run_123",
            threadId: "thread_123",
            systemFingerprint: "fp_123",
            serviceTier: "default",
            temperature: 0.2,
          },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          contentBlock: { type: "text", text: "" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "Hel" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          contentBlock: { type: "text", text: "lo" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-finish",
          index: 0,
          contentBlock: { type: "text", text: "Hello" },
        },
      },
      {
        namespace: ["model:checkpoint"],
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
