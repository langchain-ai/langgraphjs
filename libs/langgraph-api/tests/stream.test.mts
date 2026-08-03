import { describe, expect, it } from "vitest";

import { PROTOCOL_STREAM_RUN_KEY } from "../src/protocol/constants.mjs";
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
