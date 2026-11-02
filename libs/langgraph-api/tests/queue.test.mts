import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuid7 } from "@langchain/core/utils/uuid";
import { afterEach, expect, it, vi } from "vitest";
import { getAssistantId, registerFromEnv } from "../src/graph/load.mjs";
import { logger } from "../src/logging.mjs";
import { queue } from "../src/queue.mjs";
import { checkpointer } from "../src/storage/checkpoint.mjs";
import { FileSystemOps } from "../src/storage/ops.mjs";
import { FileSystemPersistence } from "../src/storage/persist.mjs";
import type { Run, RunKwargs, Store } from "../src/storage/types.mjs";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
});

async function startQueue() {
  const cwd = mkdtempSync(join(tmpdir(), "lg-api-queue-"));
  const conn = await new FileSystemPersistence<Store>(
    ".langgraphjs_ops.json",
    () => ({
      runs: {},
      threads: {},
      assistants: {},
      assistant_versions: [],
      retry_counter: {},
    })
  ).initialize(cwd);
  const checkpoints = await checkpointer.initialize(cwd);
  cleanup = async () => {
    await conn.flush();
    await checkpoints.flush();
    rmSync(cwd, { recursive: true, force: true });
  };

  const ops = new FileSystemOps(conn);
  await registerFromEnv(
    ops.assistants,
    { delay: "./delay.mts:graph" },
    { cwd: fileURLToPath(new URL("./graphs", import.meta.url)) }
  );
  void queue(ops);

  const createRun = async (kwargs: RunKwargs) => {
    const thread = await ops.threads.put(
      uuid7(),
      { if_exists: "raise" },
      undefined
    );
    const [run] = await ops.runs.put(
      uuid7(),
      getAssistantId("delay"),
      kwargs,
      { threadId: thread.thread_id },
      undefined
    );
    return run;
  };
  const statusOf = async (run: Run) =>
    (await ops.runs.get(run.run_id, run.thread_id, undefined))?.status;

  return { ops, createRun, statusOf };
}

it("picks up later runs after a thread is deleted under its running run", async () => {
  const errors = vi.spyOn(logger, "error").mockImplementation(() => logger);
  const { ops, createRun, statusOf } = await startQueue();

  const first = await createRun({ input: { delay: 500 } });
  await expect.poll(() => statusOf(first), { timeout: 3_000 }).toBe("running");
  await ops.threads.delete(first.thread_id, undefined);

  const second = await createRun({ input: { delay: 0 } });
  await expect.poll(() => statusOf(second), { timeout: 5_000 }).toBe("success");
  expect(errors).not.toHaveBeenCalled();
});

it("logs a thread write that fails after a rollback", async () => {
  const errors = vi.spyOn(logger, "error").mockImplementation(() => logger);
  const { ops, createRun, statusOf } = await startQueue();
  vi.spyOn(ops.threads, "setStatus").mockRejectedValue(new Error("disk full"));

  const run = await createRun({ input: { delay: 1_000 } });
  await expect.poll(() => statusOf(run), { timeout: 3_000 }).toBe("running");
  await ops.runs.cancel(
    run.thread_id,
    [run.run_id],
    { action: "rollback" },
    undefined
  );

  await expect.poll(() => errors.mock.calls.length).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("disk full"), {
    run_id: run.run_id,
  });
});

it("picks up later runs after a run's webhook can't be reached", async () => {
  const errors = vi.spyOn(logger, "error").mockImplementation(() => logger);
  const { createRun, statusOf } = await startQueue();

  const first = await createRun({
    input: { delay: 0 },
    webhook: "http://127.0.0.1:0/webhook",
  });
  const second = await createRun({ input: { delay: 0 } });
  await expect.poll(() => statusOf(second), { timeout: 5_000 }).toBe("success");
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("Background worker failed"),
    { run_id: first.run_id }
  );
});
