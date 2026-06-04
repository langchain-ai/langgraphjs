import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { gatherIterator, pollRun } from "./utils.mts";

const sql = postgres(
  process.env.POSTGRES_URI ??
    "postgres://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable",
);

const API_URL = "http://localhost:9123";
const client = new Client<any>({ apiUrl: API_URL });

const globalConfig = {
  configurable: {
    user_id: "123",
  },
};

beforeAll(async () => {
  await sql`DELETE FROM thread`;
  await sql`DELETE FROM store`;
  await sql`DELETE FROM checkpoints`;
});

describe("background run lifecycle", () => {
  it.concurrent("create background run", { retry: 3 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: globalConfig },
    );

    // Thread should be busy immediately after creating a background run
    const threadAfterCreate = await client.threads.get(thread.thread_id);
    expect(threadAfterCreate.status).toBe("busy");

    // Poll until the run completes
    const runStatus = await pollRun(
      client,
      thread.thread_id,
      run.run_id,
      "success",
    );
    expect(runStatus.status).toBe("success");

    // Thread should be idle after the run completes
    const threadAfterRun = await client.threads.get(thread.thread_id);
    expect(threadAfterRun.status).toBe("idle");

    // Verify the run is listed
    const runs = await client.runs.list(thread.thread_id);
    expect(runs.length).toBe(1);
    expect(runs[0].run_id).toBe(run.run_id);
    expect(runs[0].status).toBe("success");
  });

  it.concurrent("create + join", { retry: 3 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: globalConfig },
    );

    // Join waits for the run to complete
    await client.runs.join(thread.thread_id, run.run_id);

    // Verify run succeeded
    const runStatus = await client.runs.get(thread.thread_id, run.run_id);
    expect(runStatus.status).toBe("success");

    // Verify the thread has state with messages
    const state = await client.threads.getState(thread.thread_id);
    expect(Array.isArray(state.values.messages)).toBe(true);
    expect(state.values.messages.length).toBeGreaterThan(0);
  });

  it.concurrent("create + stream join", { retry: 3 }, async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input, config: globalConfig },
    );

    const chunks = await gatherIterator(
      client.runs.joinStream(thread.thread_id, run.run_id),
    );

    // Should have values events with messages
    const valuesChunks = chunks.filter((c) => c.event === "values");
    expect(valuesChunks.length).toBeGreaterThan(0);

    const lastValues = valuesChunks.at(-1);
    expect(lastValues).toBeDefined();
    expect(Array.isArray(lastValues!.data.messages)).toBe(true);
    expect(lastValues!.data.messages.length).toBeGreaterThan(0);
  });

  it.concurrent(
    "cancel background run",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [{ type: "human", content: "foo" }],
        sleep: 2,
      };

      const run = await client.runs.create(
        thread.thread_id,
        assistant.assistant_id,
        { input, config: globalConfig },
      );

      // Cancel the run immediately
      await client.runs.cancel(thread.thread_id, run.run_id);

      // Join to wait for the cancellation to take effect
      await client.runs.join(thread.thread_id, run.run_id);

      // Verify the run was interrupted
      const runStatus = await client.runs.get(thread.thread_id, run.run_id);
      expect(runStatus.status).toBe("interrupted");

      // Thread should be idle after cancellation
      const threadAfterCancel = await client.threads.get(thread.thread_id);
      expect(threadAfterCancel.status).toBe("idle");
    },
  );

  it.concurrent(
    "cancel and join concurrently",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = {
        messages: [{ type: "human", content: "foo" }],
        sleep: 2,
      };

      const run = await client.runs.create(
        thread.thread_id,
        assistant.assistant_id,
        { input, config: globalConfig },
      );

      // Cancel and join concurrently
      await Promise.all([
        client.runs.join(thread.thread_id, run.run_id),
        client.runs.cancel(thread.thread_id, run.run_id),
      ]);

      // Verify the run ended up interrupted
      const runStatus = await client.runs.get(thread.thread_id, run.run_id);
      expect(runStatus.status).toBe("interrupted");
    },
  );

  it.concurrent(
    "stream background run with resumable",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();

      type RunMetadata = { run_id: string; thread_id?: string };

      let onRunCreated: ((params: RunMetadata) => void) | undefined = undefined;
      const waitRun = new Promise<RunMetadata>((r) => (onRunCreated = r));

      const stream = client.runs.stream(
        thread.thread_id,
        assistant.assistant_id,
        {
          input: {
            messages: [{ role: "human", content: "input" }],
            sleep: { steps: 3, ms: 1000 },
          },
          streamMode: "values",
          streamResumable: true,
          config: globalConfig,
          onRunCreated,
        },
      );

      // Collect the source stream, and concurrently reconnect via joinStream
      const [join, source] = await Promise.all([
        (async () => {
          const [{ thread_id, run_id }] = await Promise.all([
            waitRun,
            new Promise((resolve) => setTimeout(resolve, 1500)),
          ]);

          return gatherIterator(
            client.runs.joinStream(thread_id!, run_id, { lastEventId: "-1" }),
          );
        })(),

        gatherIterator(stream),
      ]);

      // The reconnected stream should contain the same events as the original
      expect(join).toEqual(source);
    },
  );

  it.concurrent(
    "after_seconds delay",
    { retry: 3, timeout: 15_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = { messages: [{ type: "human", content: "foo" }] };

      const run = await client.runs.create(
        thread.thread_id,
        assistant.assistant_id,
        { input, config: globalConfig, afterSeconds: 3 },
      );

      // Run should be pending immediately
      const runImmediate = await client.runs.get(
        thread.thread_id,
        run.run_id,
      );
      expect(runImmediate.status).toBe("pending");

      // After 1 second, should still be pending
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const runAfter1s = await client.runs.get(thread.thread_id, run.run_id);
      expect(runAfter1s.status).toBe("pending");

      // Poll until success with extended timeout
      const runStatus = await pollRun(
        client,
        thread.thread_id,
        run.run_id,
        "success",
        10000,
      );
      expect(runStatus.status).toBe("success");

      // Verify the final state has messages
      const threadState = await client.threads.getState(thread.thread_id);
      expect(threadState.values).toBeDefined();
      expect(Array.isArray(threadState.values.messages)).toBe(true);
      expect(threadState.values.messages.length).toBeGreaterThan(0);
    },
  );

  it.concurrent("join failed background run", { retry: 3 }, async () => {
    const assistant = await client.assistants.create({ graphId: "error" });
    const thread = await client.threads.create();
    const input = { messages: [] };

    const run = await client.runs.create(
      thread.thread_id,
      assistant.assistant_id,
      { input },
    );

    // Join waits for the run to finish (even if it fails)
    await client.runs.join(thread.thread_id, run.run_id);

    // Verify the run status is error
    const runStatus = await client.runs.get(thread.thread_id, run.run_id);
    expect(runStatus.status).toBe("error");

    // Thread should be in error state
    const threadAfterError = await client.threads.get(thread.thread_id);
    expect(threadAfterError.status).toBe("error");
  });
});
