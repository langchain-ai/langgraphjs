import { describe, expect, it } from "vitest";

import { streamState } from "../src/stream.mjs";
import type { Run } from "../src/storage/types.mjs";

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

describe("streamState", () => {
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
});
