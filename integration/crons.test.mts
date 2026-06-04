import { Client } from "@langchain/langgraph-sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

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
  await sql`DELETE FROM cron`;
});

// ---------------------------------------------------------------------------
// Helper: clean up crons created during a test to avoid scheduler saturation
// ---------------------------------------------------------------------------
async function cleanupCrons(cronIds: string[]) {
  for (const id of cronIds) {
    try {
      await client.crons.delete(id);
    } catch {
      // already deleted or cascade-removed — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// CREATE Tests
// ---------------------------------------------------------------------------
describe("crons - create", () => {
  beforeEach(async () => {
    await sql`DELETE FROM cron`;
  });

  it("create cron basic", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const input = { messages: [{ type: "human", content: "foo" }] };
    const cronSchedule = "*/5 * * * *";

    const cron = await client.crons.create(assistant.assistant_id, {
      schedule: cronSchedule,
      input,
      config: globalConfig,
    });

    expect(cron.cron_id).toBeDefined();
    expect(cron.schedule).toBe(cronSchedule);
    expect(cron.assistant_id).toBe(assistant.assistant_id);
    expect(cron.created_at).toBeDefined();
    expect(cron.updated_at).toBeDefined();

    // Verify the cron appears in search
    const searched = await client.crons.search({
      assistantId: assistant.assistant_id,
    });
    expect(searched.length).toBe(1);
    expect(searched[0].cron_id).toBe(cron.cron_id);
    expect(searched[0].enabled).toBe(true);

    await cleanupCrons([cron.cron_id]);
  });

  it("create cron for thread", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const thread = await client.threads.create();
    const input = { messages: [{ type: "human", content: "foo" }] };
    const cronSchedule = "* * * * *";

    const cron = await client.crons.createForThread(
      thread.thread_id,
      assistant.assistant_id,
      {
        schedule: cronSchedule,
        input,
        multitaskStrategy: "enqueue",
        config: globalConfig,
      },
    );

    expect(cron.cron_id).toBeDefined();
    expect(cron.schedule).toBe(cronSchedule);
    expect(cron.assistant_id).toBe(assistant.assistant_id);
    expect(cron.thread_id).toBe(thread.thread_id);

    // Verify via search by thread
    const searched = await client.crons.search({
      threadId: thread.thread_id,
    });
    expect(searched.length).toBe(1);
    expect(searched[0].cron_id).toBe(cron.cron_id);
    expect(searched[0].thread_id).toBe(thread.thread_id);
    expect(searched[0].assistant_id).toBe(assistant.assistant_id);
    expect(searched[0].enabled).toBe(true);

    await cleanupCrons([cron.cron_id]);
  });
});

// ---------------------------------------------------------------------------
// CRUD Tests
// ---------------------------------------------------------------------------
describe("crons - CRUD", () => {
  beforeEach(async () => {
    await sql`DELETE FROM cron`;
  });

  it("cron CRUD lifecycle", async () => {
    const assistant = await client.assistants.create({ graphId: "agent" });
    const input = { messages: [{ type: "human", content: "foo" }] };
    const originalSchedule = "0 * * * *";

    // CREATE
    const cron = await client.crons.create(assistant.assistant_id, {
      schedule: originalSchedule,
      input,
      config: globalConfig,
    });
    const cronId = cron.cron_id;
    expect(cronId).toBeDefined();
    expect(cron.schedule).toBe(originalSchedule);

    // SEARCH — should find the cron
    let searched = await client.crons.search({
      assistantId: assistant.assistant_id,
    });
    expect(searched.length).toBe(1);
    expect(searched[0].cron_id).toBe(cronId);

    // GET (via search by cronId is not directly supported, but we already
    // verified via search; we can also re-search to confirm)
    const found = searched[0];
    expect(found.schedule).toBe(originalSchedule);
    expect(found.assistant_id).toBe(assistant.assistant_id);

    // UPDATE — change the schedule
    const newSchedule = "30 * * * *";
    const updated = await client.crons.update(cronId, {
      schedule: newSchedule,
    });
    expect(updated.cron_id).toBe(cronId);
    expect(updated.schedule).toBe(newSchedule);

    // Verify the update persisted
    searched = await client.crons.search({
      assistantId: assistant.assistant_id,
    });
    expect(searched.length).toBe(1);
    expect(searched[0].schedule).toBe(newSchedule);

    // DELETE
    await client.crons.delete(cronId);

    // Verify deletion
    searched = await client.crons.search({
      assistantId: assistant.assistant_id,
    });
    expect(searched.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EXECUTION Tests
// ---------------------------------------------------------------------------
describe("crons - execution", () => {
  beforeEach(async () => {
    await sql`DELETE FROM cron`;
    await sql`DELETE FROM thread`;
    await sql`DELETE FROM checkpoints`;
  });

  it(
    "cron execution basic",
    { timeout: 20_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = { messages: [{ type: "human", content: "foo" }] };
      const cronSchedule = "* * * * * *"; // every second (6-field with seconds)

      const cron = await client.crons.createForThread(
        thread.thread_id,
        assistant.assistant_id,
        {
          schedule: cronSchedule,
          input,
          multitaskStrategy: "enqueue",
          config: globalConfig,
        },
      );

      // Poll for runs to appear on the thread
      const deadline = Date.now() + 15_000;
      let runs: any[] = [];
      while (Date.now() < deadline) {
        runs = await client.runs.list(thread.thread_id);
        if (runs.length >= 1) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      expect(runs.length).toBeGreaterThanOrEqual(1);

      await cleanupCrons([cron.cron_id]);
    },
  );

  it(
    "cron enable/disable prevents execution",
    { timeout: 20_000 },
    async () => {
      const assistant = await client.assistants.create({ graphId: "agent" });
      const thread = await client.threads.create();
      const input = { messages: [{ type: "human", content: "foo" }] };
      const cronSchedule = "* * * * * *"; // every second

      // Create the cron (enabled by default)
      const cron = await client.crons.createForThread(
        thread.thread_id,
        assistant.assistant_id,
        {
          schedule: cronSchedule,
          input,
          multitaskStrategy: "enqueue",
          config: globalConfig,
        },
      );
      expect(cron.cron_id).toBeDefined();

      // Immediately disable it before the scheduler can fire
      const updated = await client.crons.update(cron.cron_id, {
        enabled: false,
      });
      expect(updated.enabled).toBe(false);

      // Wait a few seconds — no runs should be created while disabled
      await new Promise((r) => setTimeout(r, 3_000));

      const runs = await client.runs.list(thread.thread_id);
      expect(runs.length).toBe(0);

      await cleanupCrons([cron.cron_id]);
    },
  );
});

// ---------------------------------------------------------------------------
// CASCADE DELETE Tests
// ---------------------------------------------------------------------------
describe("crons - cascade", () => {
  beforeEach(async () => {
    await sql`DELETE FROM cron`;
  });

  it("cron delete cascade on assistant delete", async () => {
    const assistant1 = await client.assistants.create({ graphId: "agent" });
    const assistant2 = await client.assistants.create({ graphId: "agent" });
    const input = { messages: [{ type: "human", content: "foo" }] };
    const cronSchedule = "* * * * *";

    const cron1 = await client.crons.create(assistant1.assistant_id, {
      schedule: cronSchedule,
      input,
      config: globalConfig,
    });
    const cron2 = await client.crons.create(assistant2.assistant_id, {
      schedule: cronSchedule,
      input,
      config: globalConfig,
    });

    // Delete the first assistant
    await client.assistants.delete(assistant1.assistant_id);

    // Crons for assistant1 should be gone
    const assistant1Crons = await client.crons.search({
      assistantId: assistant1.assistant_id,
    });
    expect(assistant1Crons.length).toBe(0);

    // Crons for assistant2 should still exist
    const assistant2Crons = await client.crons.search({
      assistantId: assistant2.assistant_id,
    });
    expect(assistant2Crons.length).toBe(1);
    expect(assistant2Crons[0].cron_id).toBe(cron2.cron_id);

    await cleanupCrons([cron2.cron_id]);
  });
});
