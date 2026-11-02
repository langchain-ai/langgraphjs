import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { PROTOCOL_STREAM_RUN_KEY } from "../src/protocol/constants.mjs";
import { streamState } from "../src/stream.mjs";
import type { Run } from "../src/storage/types.mjs";
import { omitUndefined } from "../src/utils/runnableConfig.mjs";
import { gatherIterator } from "./utils.mjs";

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

class IdOnFirstChunkChatModel extends FakeListChatModel {
  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const id = `msg_${this.i}`;
    const text = this._currentResponse();
    this._incrementResponse();

    const messages = [
      new AIMessageChunk({ content: "", id }),
      ...[...text].map((content) => new AIMessageChunk({ content })),
    ];
    for (const message of messages) {
      const chunk = new ChatGenerationChunk({ message, text: message.text });
      yield chunk;
      await runManager?.handleLLMNewToken(
        chunk.text,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk }
      );
    }
  }
}

class SlowTokenHandler extends BaseCallbackHandler {
  name = "SlowTokenHandler";

  async handleLLMNewToken() {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  it("streams each model call under its first chunk's id while slow callbacks hold the callback queue", async () => {
    const model = new IdOnFirstChunkChatModel({
      responses: ["Hi", "Bye"],
      callbacks: [new SlowTokenHandler()],
    });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (state) => ({
        messages: [
          await model.invoke(state.messages),
          await model.invoke(state.messages),
        ],
      }))
      .addEdge(START, "agent")
      .compile();
    const run = createRun({
      kwargs: {
        input: { messages: [{ type: "human", content: "hey", id: "human_1" }] },
        config: { configurable: { graph_id: "agent" } },
        stream_mode: ["messages"],
        subgraphs: false,
        resumable: true,
      },
    });

    const chunks: Array<{ event: string; data: any }> = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () => graph as never,
    })) {
      chunks.push(chunk);
    }
    await awaitAllCallbacks();

    const events = (name: string) => chunks.filter((c) => c.event === name);
    const lastPartials = Object.fromEntries(
      events("messages/partial").map((c) => [c.data[0].id, c.data[0].content])
    );
    expect(
      events("messages/metadata").flatMap((c) => Object.keys(c.data))
    ).toEqual(["msg_0", "msg_1"]);
    expect(lastPartials).toEqual({ msg_0: "Hi", msg_1: "Bye" });
    expect(
      events("messages/complete").flatMap((c) =>
        c.data.map((m: BaseMessage) => [m.id, m.content])
      )
    ).toEqual([
      ["human_1", "hey"],
      ["msg_0", "Hi"],
      ["msg_1", "Bye"],
    ]);
  });

  it("sends messages/complete for the root graph's messages when subgraphs are on", async () => {
    const subgraph = new StateGraph(MessagesAnnotation)
      .addNode("draft", () => ({
        messages: [new AIMessage({ content: "draft", id: "draft_1" })],
      }))
      .addEdge(START, "draft")
      .compile();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (state, config) => {
        await subgraph.invoke(state, config);
        return {
          messages: [new AIMessage({ content: "final", id: "final_1" })],
        };
      })
      .addEdge(START, "agent")
      .compile();
    const run = createRun({
      kwargs: {
        input: { messages: [{ type: "human", content: "hey", id: "human_1" }] },
        config: { configurable: { graph_id: "agent" } },
        stream_mode: ["messages"],
        subgraphs: true,
        resumable: true,
      },
    });

    const completed: string[] = [];
    for await (const chunk of streamState(run, {
      attempt: 1,
      getGraph: async () => graph as never,
    })) {
      if (chunk.event === "messages/complete") {
        completed.push(...(chunk.data as BaseMessage[]).map((m) => m.id!));
      }
    }

    expect(completed).toEqual(["human_1", "final_1"]);
  });

  it("keeps a run going when a node streams a nested runnable with subgraphs on", async () => {
    const inner = RunnableLambda.from(async function* () {
      yield { step: "inner" };
    });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (_state, config) => {
        await gatherIterator(inner.stream({}, config));
        return {
          messages: [new AIMessage({ content: "final", id: "final_1" })],
        };
      })
      .addEdge(START, "agent")
      .compile();
    const run = createRun({
      kwargs: {
        input: { messages: [] },
        config: { configurable: { graph_id: "agent" } },
        stream_mode: ["messages", "events"],
        subgraphs: true,
        resumable: true,
      },
    });

    const chunks = await gatherIterator(
      streamState(run, { attempt: 1, getGraph: async () => graph as never })
    );

    expect(chunks).toContainEqual({
      event: "events",
      data: expect.objectContaining({
        event: "on_chain_stream",
        data: { chunk: { step: "inner" } },
      }),
    });
    expect(
      chunks
        .filter((c) => c.event === "messages/complete")
        .flatMap((c) => (c.data as BaseMessage[]).map((m) => m.id))
    ).toEqual(["final_1"]);
  });
});
