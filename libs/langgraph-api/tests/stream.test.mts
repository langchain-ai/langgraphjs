import { describe, expect, it } from "vitest";

import { PROTOCOL_STREAM_RUN_KEY } from "../src/protocol/constants.mjs";
import { AIMessageChunk } from "@langchain/core/messages";
import { BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { ChatGenerationChunk as GenChunk } from "@langchain/core/outputs";
import { StateGraph, START, END } from "@langchain/langgraph";

import { streamState } from "../src/stream.mjs";
import type { Run } from "../src/storage/types.mjs";
import { omitUndefined } from "../src/utils/runnableConfig.mjs";

const createRun = (overrides?: Partial<Run>): Run =>
  ({
    run_id: "00000000-0000-7000-8000-000000000001",
    thread_id: "00000000-0000-7000-8000-000000000002",
    assistant_id: "deep-agent",
    created_at: new Date("2026-04-01T00:00:00.000Z"),
    updated_at: new Date("2026-04-01T00:00:00.000Z"),
    status: "running",
    metadata: {},
    multitask_strategy: "interrupt",
    kwargs: {
      config: {
        configurable: {
          graph_id: "deep-agent",
        },
      },
      stream_mode: ["messages-tuple"],
      subgraphs: true,
      resumable: true,
    },
    ...overrides,
  }) satisfies Run;

describe("omitUndefined", () => {
  it("drops undefined keys so Pregel cannot wipe withConfig defaults", () => {
    expect(
      omitUndefined({
        recursionLimit: undefined,
        configurable: { thread_id: "t1" },
        tags: undefined,
        metadata: { a: 1 },
      })
    ).toEqual({
      configurable: { thread_id: "t1" },
      metadata: { a: 1 },
    });
  });

  it("keeps an explicit recursionLimit", () => {
    expect(omitUndefined({ recursionLimit: 200, tags: ["x"] })).toEqual({
      recursionLimit: 200,
      tags: ["x"],
    });
  });
});

describe("streamState", () => {
  it("omits recursionLimit from streamEvents options when the run config omits it", async () => {
    const run = createRun();
    let seenOptions: Record<string, unknown> | undefined;

    for await (const _chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents(
            _input: unknown,
            options: Record<string, unknown>
          ) {
            seenOptions = options;
            yield* [];
          },
        }) as never,
    })) {
      // drain
    }

    expect(seenOptions).toBeDefined();
    expect("recursionLimit" in (seenOptions ?? {})).toBe(false);
  });

  it("forwards an explicit recursion_limit to streamEvents", async () => {
    const run = createRun({
      kwargs: {
        config: {
          configurable: { graph_id: "deep-agent" },
          recursion_limit: 200,
        },
        stream_mode: ["messages-tuple"],
        subgraphs: true,
        resumable: true,
      },
    });
    let seenOptions: Record<string, unknown> | undefined;

    for await (const _chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents(
            _input: unknown,
            options: Record<string, unknown>
          ) {
            seenOptions = options;
            yield* [];
          },
        }) as never,
    })) {
      // drain
    }

    expect(seenOptions?.recursionLimit).toBe(200);
  });

  it("includes child on_chain_stream events when subgraphs are enabled", async () => {
    const run = createRun();
    const childRunId = "00000000-0000-7000-8000-000000000099";

    const chunks: Array<{ event: string; data: unknown }> = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents() {
            yield {
              event: "on_chain_stream",
              run_id: childRunId,
              data: {
                chunk: [
                  ["tools:call_123"],
                  "messages",
                  {
                    id: "msg_1",
                    type: "ai",
                    content: "Hello from subgraph",
                  },
                ],
              },
            };
          },
        }) as never,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        event: "metadata",
        data: { run_id: run.run_id, attempt: 1 },
      },
      {
        event: "messages|tools:call_123",
        data: {
          id: "msg_1",
          type: "ai",
          content: "Hello from subgraph",
        },
      },
    ]);
  });

  it("passes child namespace updates through unchanged", async () => {
    const run = createRun({
      kwargs: {
        config: {
          configurable: {
            graph_id: "deep-agent",
          },
        },
        stream_mode: ["updates"],
        subgraphs: true,
        resumable: true,
      },
    });
    const childRunId = "00000000-0000-7000-8000-000000000099";

    const chunks: Array<{ event: string; data: unknown }> = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents() {
            yield {
              event: "on_chain_stream",
              run_id: childRunId,
              data: {
                chunk: [
                  ["tools:call_js_eval", "1"],
                  "updates",
                  {
                    worker: {
                      messages: [
                        {
                          id: "human_1",
                          type: "human",
                          content: "Write a tiny poem for Sheryl Baxter.",
                        },
                      ],
                    },
                  },
                ],
              },
            };
            yield {
              event: "on_chain_stream",
              run_id: childRunId,
              data: {
                chunk: [
                  ["tools:call_js_eval", "1"],
                  "updates",
                  {
                    worker: {
                      messages: [
                        {
                          id: "ai_1",
                          type: "ai",
                          content: "Sheryl, your bright work sings.",
                        },
                      ],
                    },
                  },
                ],
              },
            };
          },
        }) as never,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        event: "metadata",
        data: { run_id: run.run_id, attempt: 1 },
      },
      {
        event: "updates|tools:call_js_eval|1",
        data: {
          worker: {
            messages: [
              {
                id: "human_1",
                type: "human",
                content: "Write a tiny poem for Sheryl Baxter.",
              },
            ],
          },
        },
      },
      {
        event: "updates|tools:call_js_eval|1",
        data: {
          worker: {
            messages: [
              {
                id: "ai_1",
                type: "ai",
                content: "Sheryl, your bright work sings.",
              },
            ],
          },
        },
      },
    ]);
  });

  it("does not route legacy runs through streamStateV2 for graph transformers", async () => {
    const run = createRun({
      kwargs: {
        config: {
          configurable: {
            graph_id: "deep-agent",
          },
        },
        stream_mode: ["updates"],
        subgraphs: true,
        resumable: true,
      },
    });

    let streamEventsV3Invoked = false;
    const chunks: Array<{ event: string; data: unknown }> = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          streamTransformers: [() => ({})],
          streamEvents(_input: unknown, options: { version?: string }) {
            if (options?.version === "v3") {
              streamEventsV3Invoked = true;
              return Promise.resolve({
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: "event" as const,
                    seq: 0,
                    method: "updates" as const,
                    params: {
                      namespace: [],
                      timestamp: 1,
                      data: { ignored: true },
                    },
                  };
                },
              });
            }

            return (async function* () {
              yield {
                event: "on_chain_stream",
                run_id: run.run_id,
                data: {
                  chunk: [
                    ["worker"],
                    "updates",
                    {
                      worker: {
                        status: "legacy",
                      },
                    },
                  ],
                },
              };
            })();
          },
        }) as never,
    })) {
      chunks.push(chunk);
    }

    expect(streamEventsV3Invoked).toBe(false);
    expect(chunks).toEqual([
      {
        event: "metadata",
        data: { run_id: run.run_id, attempt: 1 },
      },
      {
        event: "updates|worker",
        data: {
          worker: {
            status: "legacy",
          },
        },
      },
    ]);
  });

  it("routes protocol-gated runs through streamStateV2", async () => {
    const run = createRun({
      kwargs: {
        config: {
          configurable: {
            graph_id: "deep-agent",
          },
        },
        [PROTOCOL_STREAM_RUN_KEY]: true,
        stream_mode: ["messages"],
        subgraphs: false,
        resumable: true,
      },
    });

    // Protocol-gated runs must skip the v1/v2 `streamEvents` path and flow
    // through `graph.streamEvents(..., { version: "v3" })`, which is what lets core's
    // `LifecycleTransformer` emit authoritative subgraph lifecycle
    // events. By mocking the v3 overload here, we assert the run is
    // actually routed to the protocol pipeline.
    let streamEventsV3Invoked = false;
    const chunks: Array<{ event: string; data: unknown }> = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async streamEvents() {
            streamEventsV3Invoked = true;
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "event" as const,
                  seq: 0,
                  method: "messages" as const,
                  params: {
                    namespace: [],
                    timestamp: 1,
                    data: {
                      event: "message-start",
                      messageId: "msg_1",
                    },
                  },
                };
              },
            };
          },
        }) as never,
    })) {
      chunks.push(chunk);
    }

    expect(streamEventsV3Invoked).toBe(true);
    expect(chunks).toEqual([
      {
        event: "metadata",
        data: { run_id: run.run_id, attempt: 1 },
      },
      {
        event: "messages",
        data: {
          event: "message-start",
          messageId: "msg_1",
        },
        normalized: true,
      },
    ]);
  });
});

describe("cumulative tool_call args recovery (#2570)", () => {
  const argsEvents = (id: string, parts: string[], final: string) => {
    const events = parts.map((args, i) => ({
      event: "on_chat_model_stream",
      data: {
        chunk: new AIMessageChunk({
          id,
          content: "",
          tool_call_chunks: [
            i === 0
              ? { name: "t", id: "call_1", args, index: 0, type: "tool_call_chunk" as const }
              : { args, index: 0, type: "tool_call_chunk" as const },
          ],
        }),
      },
    }));
    return [
      ...events,
      {
        event: "on_chat_model_end",
        data: { output: new AIMessageChunk({ id, content: "" }) },
      },
    ];
  };

  const collectArgs = async (parts: string[]) => {
    const run = createRun({
      kwargs: {
        config: { configurable: { graph_id: "deep-agent" } },
        stream_mode: ["messages"],
      },
    });
    const partials: string[] = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents() {
            yield* argsEvents("msg_1", parts, parts.join(""));
          },
        }) as never,
    })) {
      if (chunk.event === "messages/partial") {
        const [message] = chunk.data as [AIMessageChunk];
        partials.push(message.tool_call_chunks?.[0]?.args ?? "");
      }
    }
    return partials;
  };

  it("replaces the concatenation of cumulative snapshots once the run ends", async () => {
    const partials = await collectArgs(['{"a', '{"a":1', '{"a":1}']);
    // mid-stream frames keep today's behavior; the final frame is recovered
    expect(partials[partials.length - 2]).toBe('{"a{"a":1{"a":1}');
    expect(partials[partials.length - 1]).toBe('{"a":1}');
  });

  it("does not touch a compliant delta stream", async () => {
    const parts = ['{"a', '":1}'];
    const partials = await collectArgs(parts);
    expect(partials).toEqual(['{"a', '{"a":1}']);
  });

  it("does not touch a compliant stream whose chunks happen to chain", async () => {
    // {"x":{"x":1}} split at the self-similar seam: the chain holds, but the
    // concatenation parses, so recovery is never consulted
    const partials = await collectArgs(['{"x":', '{"x":1}}']);
    expect(partials[partials.length - 1]).toBe('{"x":{"x":1}}');
  });

  it("preserves broken output whose chunks do not chain", async () => {
    const partials = await collectArgs(['{"a":', 'oops}']);
    expect(partials[partials.length - 1]).toBe('{"a":oops}');
  });

  it("reads chained broken output as its only parsing interpretation", async () => {
    // the documented trade: {{"a":1} split as { + {"a":1} chains and parses
    // as {"a":1} instead of surfacing as Malformed args
    const partials = await collectArgs(["{", '{"a":1}']);
    expect(partials[partials.length - 1]).toBe('{"a":1}');
  });
});

describe("cumulative recovery, per tool_call", () => {
  it("recovers only the cumulative call when another call is compliant", async () => {
    const run = createRun({
      kwargs: {
        config: { configurable: { graph_id: "deep-agent" } },
        stream_mode: ["messages"],
      },
    });
    const mk = (chunks: Array<Record<string, unknown>>) =>
      new AIMessageChunk({
        id: "msg_2",
        content: "",
        tool_call_chunks: chunks as never,
      });
    const events = [
      {
        event: "on_chat_model_stream",
        data: {
          chunk: mk([
            { name: "cum", id: "call_a", args: '{"a', index: 0, type: "tool_call_chunk" },
            { name: "ok", id: "call_b", args: '{"b', index: 1, type: "tool_call_chunk" },
          ]),
        },
      },
      {
        event: "on_chat_model_stream",
        data: {
          chunk: mk([
            { args: '{"a":1}', index: 0, type: "tool_call_chunk" },
            { args: '":2}', index: 1, type: "tool_call_chunk" },
          ]),
        },
      },
      {
        event: "on_chat_model_end",
        data: { output: new AIMessageChunk({ id: "msg_2", content: "" }) },
      },
    ];
    let last: AIMessageChunk | undefined;
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () =>
        ({
          async *streamEvents() {
            yield* events;
          },
        }) as never,
    })) {
      if (chunk.event === "messages/partial")
        [last] = chunk.data as [AIMessageChunk];
    }
    expect(last?.tool_call_chunks?.map((c) => c.args)).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
    expect(last?.tool_calls?.map((c) => c.args)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(last?.invalid_tool_calls ?? []).toHaveLength(0);
  });
});

class CumulativeModel extends BaseChatModel {
  constructor(fields: BaseChatModelParams = {}) { super(fields); }
  _llmType() { return "cumulative-fake"; }
  async _generate(): Promise<ChatResult> {
    return { generations: [{ text: "", message: new AIMessageChunk({ id: "m1", content: "" }) }] };
  }
  async *_streamResponseChunks(
    _m: BaseMessage[], _o: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const snapshots = ['{"a', '{"a":1', '{"a":1}'];
    for (let i = 0; i < snapshots.length; i += 1) {
      const gc = new GenChunk({
        text: "",
        message: new AIMessageChunk({
          id: "m1", content: "",
          tool_call_chunks: [
            i === 0
              ? { name: "t", id: "call_1", args: snapshots[i], index: 0, type: "tool_call_chunk" }
              : { args: snapshots[i], index: 0, type: "tool_call_chunk" },
          ],
        }),
      });
      yield gc;
      await runManager?.handleLLMNewToken("", undefined, undefined, undefined, undefined, { chunk: gc });
    }
  }
}

const realRun = createRun({
  kwargs: {
    input: { messages: [] },
    config: { configurable: { graph_id: "deep-agent" } },
    stream_mode: ["messages"],
  },
});

describe("cumulative recovery against a real graph stream", () => {
  it("fires on real on_chat_model_end and carries parsed tool_calls", async () => {
    const graph = new StateGraph<{ messages: BaseMessage[] }>({ channels: { messages: null } })
      .addNode("agent", async () => {
        const r = await new CumulativeModel().invoke("hi");
        return { messages: [r] };
      })
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile();

    const partials: AIMessageChunk[] = [];
    for await (const chunk of streamState(realRun, {
      attempt: 1,
      getGraph: async () => graph as never,
    })) {
      if (chunk.event === "messages/partial") partials.push((chunk.data as [AIMessageChunk])[0]);
    }
    const last = partials[partials.length - 1];
    expect(last?.tool_call_chunks?.[0]?.args).toBe('{"a":1}');
    expect(last?.tool_calls?.[0]?.args).toEqual({ a: 1 });
    expect(last?.invalid_tool_calls ?? []).toHaveLength(0);
  });
});
