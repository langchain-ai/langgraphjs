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
      data: {
        __interrupt__: [
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
          message_id: "message_1",
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
          message_id: "message_1",
          role: "ai",
        },
      },
      {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        namespace: ["tools:call_123", "model:worker_456"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "text", text: "Hel" },
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
          message_id: "chatcmpl-1",
          role: "ai",
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
          content_block: { type: "tool_call_chunk", args: "" },
        },
      },
      {
        namespace: ["model_request:d445c9e4-e3b6-5530-a22d-8c85ebdd2c87"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "tool_call_chunk", args: "scrip" },
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
          message_id: "chatcmpl-final",
          role: "ai",
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
          content_block: {
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
          content_block: {
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
          content_block: {
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
              event: "started",
              graph_name: "tools",
            },
            timestamp: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          method: "messages",
          params: expect.objectContaining({
            namespace: ["tools:call_123"],
            data: expect.objectContaining({
              event: "message-start",
              message_id: "subagent:call_123:human",
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
              content_block: {
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
              graph_name: "tools",
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
          message_id: "message_1",
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
          role: "ai",
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "text", text: "Hel" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-delta",
          index: 0,
          content_block: { type: "text", text: "lo" },
        },
      },
      {
        namespace: ["model:checkpoint"],
        timestamp: expect.any(Number),
        data: {
          event: "content-block-finish",
          index: 0,
          content_block: { type: "text", text: "Hello" },
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

  it("remaps internal subgraph message namespaces onto task tool-call namespaces", async () => {
    const sent: unknown[] = [];
    const session = createSession(sent);
    await session.start();
    sent.length = 0;

    await session.handleCommand(
      JSON.stringify({
        id: 1,
        method: "subscription.subscribe",
        params: { channels: ["messages", "updates", "values", "lifecycle"] },
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
    sent.length = 0;

    await session.ingestSourceEvent({
      id: "2",
      event: "messages|tools:internal_worker_1|model_request:abc",
      data: [
        {
          id: "internal_human_1",
          type: "human",
          content: "Research protocol details",
        },
        {},
      ],
    });
    await session.ingestSourceEvent({
      id: "3",
      event: "messages|tools:internal_worker_1|model_request:abc",
      data: [
        {
          id: "internal_ai_1",
          type: "ai",
          content: "timestamp",
        },
        {},
      ],
    });

    const events = sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message != null &&
        (message as { type?: string }).type === "event"
    );
    const messageEvents = events.filter((event) => event.method === "messages");

    expect(messageEvents).toEqual([
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "messages",
        params: {
          namespace: ["tools:call_123", "model_request:abc"],
          timestamp: expect.any(Number),
          data: {
            event: "message-start",
            message_id: "internal_ai_1",
            role: "ai",
          },
        },
      },
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "messages",
        params: {
          namespace: ["tools:call_123", "model_request:abc"],
          timestamp: expect.any(Number),
          data: {
            event: "content-block-start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
      },
      {
        type: "event",
        event_id: expect.any(String),
        seq: expect.any(Number),
        method: "messages",
        params: {
          namespace: ["tools:call_123", "model_request:abc"],
          timestamp: expect.any(Number),
          data: {
            event: "content-block-delta",
            index: 0,
            content_block: { type: "text", text: "timestamp" },
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

  describe("flow.setCapacity", () => {
    it("accepts a valid strategy parameter", async () => {
      const sent: unknown[] = [];
      const session = createSession(sent);
      await session.start();
      sent.length = 0;

      await session.handleCommand(
        JSON.stringify({
          id: 1,
          method: "flow.setCapacity",
          params: { max_buffer_size: 50, strategy: "drop-oldest" },
        })
      );

      expect(sent).toEqual([{ type: "success", id: 1, result: {} }]);
    });

    it("rejects an invalid strategy", async () => {
      const sent: unknown[] = [];
      const session = createSession(sent);
      await session.start();
      sent.length = 0;

      await session.handleCommand(
        JSON.stringify({
          id: 1,
          method: "flow.setCapacity",
          params: { max_buffer_size: 50, strategy: "yolo" },
        })
      );

      expect(sent).toEqual([
        {
          type: "error",
          id: 1,
          error: "invalid_argument",
          message: expect.stringContaining("Unsupported flow strategy"),
        },
      ]);
    });

    it("defaults to drop-oldest when strategy is omitted", async () => {
      const sent: unknown[] = [];
      const session = createSession(sent);
      await session.start();
      sent.length = 0;

      await session.handleCommand(
        JSON.stringify({
          id: 1,
          method: "flow.setCapacity",
          params: { max_buffer_size: 5 },
        })
      );

      expect(sent).toEqual([{ type: "success", id: 1, result: {} }]);
    });

    describe("drop-oldest strategy", () => {
      it("discards oldest events when buffer exceeds capacity", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();
        sent.length = 0;

        await session.handleCommand(
          JSON.stringify({
            id: 1,
            method: "flow.setCapacity",
            params: { max_buffer_size: 3, strategy: "drop-oldest" },
          })
        );

        await session.handleCommand(
          JSON.stringify({
            id: 2,
            method: "subscription.subscribe",
            params: { channels: ["values"] },
          })
        );
        sent.length = 0;

        for (let i = 0; i < 6; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        const events = sent.filter(
          (m: any) => m.type === "event" && m.method === "values"
        );
        expect(events).toHaveLength(6);

        sent.length = 0;
        await session.handleCommand(
          JSON.stringify({
            id: 3,
            method: "subscription.subscribe",
            params: { channels: ["values"] },
          })
        );

        const replayed = sent.filter(
          (m: any) => m.type === "event" && m.method === "values"
        );
        expect(replayed).toHaveLength(3);
        expect(replayed.map((e: any) => e.params.data.count)).toEqual([
          3, 4, 5,
        ]);
      });
    });

    describe("pause-producer strategy", () => {
      it("blocks event production when buffer is full until capacity is freed", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        await session.handleCommand(
          JSON.stringify({
            id: 1,
            method: "flow.setCapacity",
            params: { max_buffer_size: 3, strategy: "pause-producer" },
          })
        );
        sent.length = 0;

        for (let i = 0; i < 3; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        let fourthResolved = false;
        const fourthPromise = session
          .ingestSourceEvent({
            id: "3",
            event: "values",
            data: { count: 3 },
          })
          .then(() => {
            fourthResolved = true;
          });

        await new Promise((r) => setTimeout(r, 50));
        expect(fourthResolved).toBe(false);

        await session.handleCommand(
          JSON.stringify({
            id: 2,
            method: "flow.setCapacity",
            params: { max_buffer_size: 10, strategy: "drop-oldest" },
          })
        );

        await fourthPromise;
        expect(fourthResolved).toBe(true);
      });

      it("unblocks when session is closed", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        await session.handleCommand(
          JSON.stringify({
            id: 1,
            method: "flow.setCapacity",
            params: { max_buffer_size: 2, strategy: "pause-producer" },
          })
        );
        sent.length = 0;

        for (let i = 0; i < 2; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        let resolved = false;
        const blocked = session
          .ingestSourceEvent({
            id: "2",
            event: "values",
            data: { count: 2 },
          })
          .then(() => {
            resolved = true;
          });

        await new Promise((r) => setTimeout(r, 50));
        expect(resolved).toBe(false);

        await session.close();
        await blocked;
        expect(resolved).toBe(true);
      });
    });

    describe("sample strategy", () => {
      it("delivers every other non-lifecycle event when buffer is at capacity", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        // Buffer size 5 = 1 (initial lifecycle) + 4 room for values
        await session.handleCommand(
          JSON.stringify({
            id: 1,
            method: "flow.setCapacity",
            params: { max_buffer_size: 5, strategy: "sample" },
          })
        );

        await session.handleCommand(
          JSON.stringify({
            id: 2,
            method: "subscription.subscribe",
            params: { channels: ["values"] },
          })
        );
        sent.length = 0;

        // Fill exactly to capacity (4 values + 1 lifecycle = 5)
        for (let i = 0; i < 4; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        const preCapacity = sent.filter(
          (m: any) => m.type === "event" && m.method === "values"
        );
        expect(preCapacity).toHaveLength(4);
        sent.length = 0;

        // Push 6 more events while at capacity — sampling should drop some
        for (let i = 4; i < 10; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        const sampled = sent.filter(
          (m: any) => m.type === "event" && m.method === "values"
        );
        expect(sampled.length).toBeLessThan(6);
        expect(sampled.length).toBeGreaterThan(0);
      });

      it("always delivers lifecycle events even under sampling pressure", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        await session.handleCommand(
          JSON.stringify({
            id: 1,
            method: "flow.setCapacity",
            params: { max_buffer_size: 2, strategy: "sample" },
          })
        );

        await session.handleCommand(
          JSON.stringify({
            id: 2,
            method: "subscription.subscribe",
            params: { channels: ["values", "lifecycle"] },
          })
        );
        sent.length = 0;

        for (let i = 0; i < 3; i++) {
          await session.ingestSourceEvent({
            id: String(i),
            event: "values",
            data: { count: i },
          });
        }

        await session.ingestSourceEvent({
          id: "child-event",
          event: "values|child_agent",
          data: { messages: ["hello"] },
        });

        const lifecycle = sent.filter(
          (m: any) => m.type === "event" && m.method === "lifecycle"
        );
        expect(lifecycle.length).toBeGreaterThan(0);
      });
    });

    describe("handleProtocolCommand", () => {
      it("validates strategy via the response path", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        const result = await session.handleProtocolCommand({
          id: 1,
          method: "flow.setCapacity",
          params: { max_buffer_size: 10, strategy: "sample" },
        });

        expect(result).toEqual({ type: "success", id: 1, result: {} });
      });

      it("rejects invalid strategy via the response path", async () => {
        const sent: unknown[] = [];
        const session = createSession(sent);
        await session.start();

        const result = await session.handleProtocolCommand({
          id: 1,
          method: "flow.setCapacity",
          params: {
            max_buffer_size: 10,
            strategy: "bogus" as any,
          },
        });

        expect(result).toEqual({
          type: "error",
          id: 1,
          error: "invalid_argument",
          message: expect.stringContaining("Unsupported flow strategy"),
        });
      });
    });
  });
});
