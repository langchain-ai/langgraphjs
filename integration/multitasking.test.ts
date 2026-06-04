import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { pollRun } from "./utils.ts";

const sql = postgres(
  process.env.POSTGRES_URI ??
    "postgres://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable",
);

const API_URL = "http://localhost:9123";
const client = new Client<any>({ apiUrl: API_URL });

// Passed to all invocation requests as the graph uses this field for store-based
// shared state operations.
const globalConfig = {
  configurable: {
    user_id: "123",
  },
};

beforeAll(async () => {
  await sql`DELETE FROM thread`;
  await sql`DELETE FROM store`;
  await sql`DELETE FROM checkpoints`;
  await sql`DELETE FROM assistant WHERE metadata->>'created_by' is null OR metadata->>'created_by' != 'system'`;
});

describe("multitasking", () => {
  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------
  it.concurrent("reject", { retry: 3, timeout: 15_000 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = {
      messages: [{ type: "human", content: "foo", id: "reject-msg" }],
      sleep: 2,
    };

    // Start a slow background run
    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: globalConfig },
    );

    // Attempting a second run with reject strategy should fail with 409
    await expect(
      client.runs.create(thread.thread_id, assistant.assistant_id, {
        input,
        multitaskStrategy: "reject",
        config: globalConfig,
      }),
    ).rejects.toThrow();

    // The first run should still complete successfully
    const finalRun = await pollRun(client, thread.thread_id, run.run_id);
    expect(finalRun.status).toBe("success");
  });

  // -------------------------------------------------------------------------
  // interrupt
  // -------------------------------------------------------------------------
  it.concurrent("interrupt", { retry: 3, timeout: 15_000 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input1 = {
      messages: [
        { type: "human", content: "foo", id: "interrupt-msg-1" },
      ],
      sleep: 2,
    };
    const input2 = {
      messages: [
        { type: "human", content: "bar", id: "interrupt-msg-2" },
      ],
      sleep: 0,
    };

    // Start a slow first run
    const run1 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input: input1, config: globalConfig },
    );

    // Give it a moment to start executing
    await new Promise((r) => setTimeout(r, 500));

    // Start a second run that interrupts the first
    const run2 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      {
        input: input2,
        multitaskStrategy: "interrupt",
        config: globalConfig,
      },
    );

    // First run should be interrupted
    const finalRun1 = await pollRun(
      client,
      thread.thread_id,
      run1.run_id,
      "interrupted",
    );
    expect(finalRun1.status).toBe("interrupted");

    // Second run should succeed
    const finalRun2 = await pollRun(client, thread.thread_id, run2.run_id);
    expect(finalRun2.status).toBe("success");

    // Thread state should reflect the second run's input
    const state = await client.threads.getState(thread.thread_id);
    const contents = state.values.messages.map((m: any) => m.content);
    // The last human message in state should be "bar" from the second run
    expect(contents).toContain("bar");
  });

  // -------------------------------------------------------------------------
  // rollback
  // -------------------------------------------------------------------------
  it.concurrent("rollback", { retry: 3, timeout: 15_000 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input1 = {
      messages: [
        { type: "human", content: "foo", id: "rollback-msg-1" },
      ],
      sleep: 4,
    };
    const input2 = {
      messages: [
        { type: "human", content: "bar", id: "rollback-msg-2" },
      ],
    };

    // Start a slow first run
    const run1 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input: input1, config: globalConfig },
    );

    // Give it a moment to start executing
    await new Promise((r) => setTimeout(r, 500));

    // Start a second run that rolls back the first
    const run2 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      {
        input: input2,
        multitaskStrategy: "rollback",
        config: globalConfig,
      },
    );

    // First run should be gone (rolled back -- 404)
    await expect(
      pollRun(client, thread.thread_id, run1.run_id),
    ).rejects.toThrow();

    // Second run should succeed
    const finalRun2 = await pollRun(client, thread.thread_id, run2.run_id);
    expect(finalRun2.status).toBe("success");

    // Thread state should only contain the second run's results
    const state = await client.threads.getState(thread.thread_id);
    expect(state.values.messages[0].content).toBe("bar");
    // agent graph produces: human -> begin -> tool_call__begin -> end = 4 messages
    expect(state.values.messages).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------
  it.concurrent("enqueue", { retry: 3, timeout: 15_000 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input1 = {
      messages: [
        { type: "human", content: "foo", id: "enqueue-msg-1" },
      ],
      sleep: 1,
    };
    const input2 = {
      messages: [
        { type: "human", content: "bar", id: "enqueue-msg-2" },
      ],
      sleep: 0,
    };

    // Start first run
    const run1 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input: input1, config: globalConfig },
    );

    // Enqueue a second run while the first is in progress
    const run2 = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      {
        input: input2,
        multitaskStrategy: "enqueue",
        config: globalConfig,
      },
    );

    // Both runs should complete successfully
    const finalRun1 = await pollRun(client, thread.thread_id, run1.run_id);
    expect(finalRun1.status).toBe("success");

    const finalRun2 = await pollRun(client, thread.thread_id, run2.run_id);
    expect(finalRun2.status).toBe("success");

    // Thread state should contain messages from both runs
    const state = await client.threads.getState(thread.thread_id);
    // 4 messages from first run + 4 from second = 8 total
    expect(state.values.messages).toHaveLength(8);
    expect(state.values.messages[0].content).toBe("foo");
    expect(state.values.messages[4].content).toBe("bar");
  });

  // -------------------------------------------------------------------------
  // reject with streaming
  // -------------------------------------------------------------------------
  it.concurrent(
    "reject with streaming",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [
          { type: "human", content: "foo", id: "reject-stream-msg" },
        ],
        sleep: 2,
      };

      // Start a slow first run via streaming
      const stream = client.runs.stream(
        thread.thread_id,
        assistant.assistant_id,
        { input, streamMode: "values", config: globalConfig },
      );

      let runId: string | null = null;
      let rejectedWith409 = false;

      for await (const chunk of stream) {
        if (chunk.event === "metadata") {
          runId = chunk.data.run_id;
          // As soon as we know the run is active, attempt a reject
          try {
            await client.runs.create(
              thread.thread_id,
              assistant.assistant_id,
              {
                input,
                multitaskStrategy: "reject",
                config: globalConfig,
              },
            );
          } catch {
            rejectedWith409 = true;
          }
        }
      }

      expect(runId).not.toBeNull();
      expect(rejectedWith409).toBe(true);

      // First run should still succeed
      const run = await client.runs.get(thread.thread_id, runId as string);
      expect(run.status).toBe("success");
    },
  );

  // -------------------------------------------------------------------------
  // interrupt with streaming
  // -------------------------------------------------------------------------
  it.concurrent(
    "interrupt with streaming",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input1 = {
        messages: [
          { type: "human", content: "foo", id: "interrupt-stream-msg-1" },
        ],
        sleep: 2,
      };
      const input2 = {
        messages: [
          { type: "human", content: "bar", id: "interrupt-stream-msg-2" },
        ],
        sleep: 0,
      };

      // Start the slow first run via streaming
      const stream = client.runs.stream(
        thread.thread_id,
        assistant.assistant_id,
        { input: input1, streamMode: "values", config: globalConfig },
      );

      let runId1: string | null = null;
      let interruptTaskDone: Promise<any> | null = null;

      for await (const chunk of stream) {
        if (chunk.event === "metadata" && !interruptTaskDone) {
          runId1 = chunk.data.run_id;
          // Fire off the interrupt run concurrently
          interruptTaskDone = client.runs.create(
            thread.thread_id,
            assistant.assistant_id,
            {
              input: input2,
              multitaskStrategy: "interrupt",
              config: globalConfig,
            },
          );
        }
      }

      expect(runId1).not.toBeNull();
      const run2 = await interruptTaskDone!;

      // First run should be interrupted
      const finalRun1 = await pollRun(
        client,
        thread.thread_id,
        runId1 as string,
        "interrupted",
      );
      expect(finalRun1.status).toBe("interrupted");

      // Second run should succeed
      const finalRun2 = await pollRun(
        client,
        thread.thread_id,
        run2.run_id,
      );
      expect(finalRun2.status).toBe("success");
    },
  );

  // -------------------------------------------------------------------------
  // state update while inflight
  // -------------------------------------------------------------------------
  it.concurrent(
    "state update while inflight",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [{ type: "human", content: "foo", id: "inflight-msg" }],
      };

      // Create a background run that will start executing after 2 seconds
      const run = await client.runs.create(
        thread.thread_id,
        assistant.assistant_id,
        { input, config: globalConfig, afterSeconds: 2 },
      );

      // Wait a moment for the run to be inserted
      await new Promise((r) => setTimeout(r, 500));

      // Attempt to update thread state while the run is inflight -- should fail 409
      await expect(
        client.threads.updateState(thread.thread_id, {
          values: {
            messages: [
              {
                type: "assistant",
                content: "One must imagine Sisyphus happy.",
              },
            ],
          },
        }),
      ).rejects.toThrow();

      // Cancel the inflight run
      await client.runs.cancel(thread.thread_id, run.run_id);

      // Join the run so we know it's fully stopped
      await client.runs.join(thread.thread_id, run.run_id);

      // Verify the run was interrupted
      const cancelledRun = await client.runs.get(
        thread.thread_id,
        run.run_id,
      );
      expect(cancelledRun.status).toBe("interrupted");

      // Thread should be idle now
      const threadInfo = await client.threads.get(thread.thread_id);
      expect(threadInfo.status).toBe("idle");

      // Now updateState should succeed (thread is idle)
      await client.threads.updateState(thread.thread_id, {
        values: {
          messages: [
            {
              type: "assistant",
              content: "One must imagine Sisyphus happy.",
            },
          ],
        },
        asNode: "agent",
      });

      const state = await client.threads.getState(thread.thread_id);
      const allContent = JSON.stringify(state.values);
      expect(allContent).toContain("Sisyphus");
    },
  );
});
