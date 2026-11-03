import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuid7 } from "@langchain/core/utils/uuid";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { type AuthContext, registerAuth } from "../src/auth/index.mjs";
import { getAssistantId, registerFromEnv } from "../src/graph/load.mjs";
import { logger } from "../src/logging.mjs";
import { queue } from "../src/queue.mjs";
import { checkpointer } from "../src/storage/checkpoint.mjs";
import {
  FileSystemOps,
  RUN_LOG_GRACE_MS,
  StreamManager,
} from "../src/storage/ops.mjs";
import { FileSystemPersistence } from "../src/storage/persist.mjs";
import type { Run, RunKwargs, Store } from "../src/storage/types.mjs";
import { gatherIterator } from "./utils.mjs";

let cleanup: (() => Promise<void>) | undefined;

beforeAll(() =>
  registerAuth(
    { path: "./auth.mts:auth" },
    { cwd: fileURLToPath(new URL("./graphs", import.meta.url)) }
  )
);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

async function openOps() {
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

  const createRun = async (
    kwargs: RunKwargs,
    options?: { afterSeconds?: number }
  ) => {
    const thread = await ops.threads.put(
      uuid7(),
      { if_exists: "raise" },
      undefined
    );
    const [run] = await ops.runs.put(
      uuid7(),
      getAssistantId("delay"),
      kwargs,
      { threadId: thread.thread_id, ...options },
      undefined
    );
    return run;
  };
  const statusOf = async (run: Run) =>
    (await ops.runs.get(run.run_id, run.thread_id, undefined))?.status;

  return { ops, createRun, statusOf };
}

async function startQueue() {
  const opened = await openOps();
  void queue(opened.ops);
  return opened;
}

async function runOnce(
  ops: FileSystemOps,
  run: Run,
  whileHeld?: () => Promise<unknown>
) {
  vi.advanceTimersByTime(1);
  const worker = ops.runs.next();
  expect((await worker.next()).value?.run.run_id, "the claimed run").toBe(
    run.run_id
  );
  await ops.runs.stream.publish({
    runId: run.run_id,
    resumable: false,
    event: "values",
    data: { delay: 0 },
  });
  await ops.runs.setStatus(run.run_id, "success");
  await whileHeld?.();
  await worker.next();
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

it("two joiners of a non-resumable run each get every event", async () => {
  const { ops, createRun } = await startQueue();
  const run = await createRun(
    { input: { delay: 0 }, stream_mode: ["values"] },
    { afterSeconds: 1 }
  );
  const join = (lastEventId?: string) =>
    gatherIterator(
      ops.runs.stream.join(
        run.run_id,
        run.thread_id,
        { lastEventId },
        undefined
      )
    );

  const [first, second] = await Promise.all([join(), join()]);
  expect(first.map((event) => event.event)).toEqual([
    "metadata",
    "values",
    "values",
  ]);
  expect(second).toEqual(first);
  expect(await join("-1"), "a replay after the run ended").toEqual(first);
  expect(await join(), "a live join after the run ended").toEqual([]);
});

it("runs.join() does not empty an open stream", async () => {
  const { ops, createRun } = await startQueue();
  const run = await createRun(
    { input: { delay: 0 }, stream_mode: ["values"] },
    { afterSeconds: 1 }
  );
  const stream = ops.runs.stream.join(
    run.run_id,
    run.thread_id,
    { lastEventId: undefined },
    undefined
  );

  const first = await stream.next();
  const joined = await ops.runs.join(run.run_id, run.thread_id, undefined);
  const events = [first.value, ...(await gatherIterator(stream))];

  expect(events.map((event) => event?.event)).toEqual([
    "metadata",
    "values",
    "values",
  ]);
  expect(joined).toEqual(events.at(-1)?.data);
  expect(
    await ops.runs.wait(run.run_id, run.thread_id, undefined),
    "a wait after the run ended"
  ).toEqual(joined);
});

it("replays a finished run's log for a grace period, then frees it", async () => {
  vi.useFakeTimers();
  const { ops, createRun } = await openOps();
  const run = await createRun({ input: { delay: 0 } });
  await runOnce(ops, run);

  vi.advanceTimersByTime(RUN_LOG_GRACE_MS - 1);
  const replay = ops.runs.stream.join(
    run.run_id,
    run.thread_id,
    { lastEventId: "-1" },
    undefined
  );
  expect(
    (await replay.next()).value,
    "a replay inside the grace period"
  ).toMatchObject({ event: "values", data: { delay: 0 } });
  await replay.return(undefined);

  vi.advanceTimersByTime(1);
  expect(
    StreamManager.readers[run.run_id],
    "the log after the grace period"
  ).toBeUndefined();
});

it.each([
  [
    "run",
    (ops: FileSystemOps, run: Run) =>
      ops.runs.delete(run.run_id, run.thread_id, undefined),
  ],
  [
    "run's thread",
    (ops: FileSystemOps, run: Run) =>
      ops.threads.delete(run.thread_id, undefined),
  ],
])(
  "frees a finished run's log as soon as the %s is deleted",
  async (_, remove) => {
    vi.useFakeTimers();
    const { ops, createRun } = await openOps();
    const run = await createRun({ input: { delay: 0 } });
    await runOnce(ops, run);

    await remove(ops, run);
    expect(StreamManager.readers[run.run_id]).toBeUndefined();
  }
);

it("keeps a stateless run's log for the grace period after its thread is deleted with it", async () => {
  vi.useFakeTimers();
  const { ops, createRun } = await openOps();
  const run = await createRun({ input: { delay: 0 }, temporary: true });
  await runOnce(ops, run, () => ops.threads.delete(run.thread_id, undefined));

  expect(
    StreamManager.readers[run.run_id],
    "the log right after the run"
  ).toBeDefined();
  vi.advanceTimersByTime(RUN_LOG_GRACE_MS);
  expect(
    StreamManager.readers[run.run_id],
    "the log after the grace period"
  ).toBeUndefined();
});

it("keeps a re-queued run's log until a grace period after its last attempt", async () => {
  vi.useFakeTimers();
  const { ops, createRun } = await openOps();
  const run = await createRun({ input: { delay: 0 } });
  await runOnce(ops, run);
  await ops.runs.setStatus(run.run_id, "pending");

  await runOnce(ops, run, async () =>
    vi.advanceTimersByTime(RUN_LOG_GRACE_MS)
  );
  expect(
    StreamManager.readers[run.run_id],
    "the log right after the second attempt"
  ).toBeDefined();
  vi.advanceTimersByTime(RUN_LOG_GRACE_MS);
  expect(
    StreamManager.readers[run.run_id],
    "the log after the grace period"
  ).toBeUndefined();
});

const alice: AuthContext = {
  user: {
    identity: "alice",
    permissions: ["me"],
    display_name: "alice",
    is_authenticated: true,
  },
  scopes: ["me"],
};

it.each<
  [
    string,
    (run: Run) => [string, string | undefined, AuthContext | undefined],
    unknown[],
  ]
>([
  [
    "a run through another thread",
    (run) => [run.run_id, uuid7(), undefined],
    [{ event: "error", data: "Run not found" }],
  ],
  [
    "a run through a thread the caller can't read",
    (run) => [run.run_id, run.thread_id, alice],
    [
      {
        event: "error",
        data: { error: "Error", message: "404: Thread not found" },
      },
    ],
  ],
  ["a hidden run by id", (run) => [run.run_id, undefined, alice], []],
  ["an unknown run by id", () => [uuid7(), undefined, alice], []],
  [
    "an unknown run by id without auth",
    () => [uuid7(), undefined, undefined],
    [],
  ],
])("a join of %s ends without creating a log", async (_, target, events) => {
  const { ops, createRun } = await openOps();
  const [runId, threadId, auth] = target(
    await createRun({ input: { delay: 0 } })
  );
  const options =
    threadId == null
      ? { lastEventId: "-1", ignore404: true, checkRunAccess: true }
      : { lastEventId: "-1" };

  expect(
    await gatherIterator(ops.runs.stream.join(runId, threadId, options, auth))
  ).toEqual(events);
  expect(StreamManager.readers[runId], "the run's log").toBeUndefined();
});

it("a join of a finished run whose log was freed ends at once without creating a log", async () => {
  vi.useFakeTimers();
  const { ops, createRun } = await openOps();
  const run = await createRun({ input: { delay: 0 } });
  await runOnce(ops, run);
  vi.advanceTimersByTime(RUN_LOG_GRACE_MS);

  const events = gatherIterator(
    ops.runs.stream.join(
      run.run_id,
      run.thread_id,
      { lastEventId: "-1" },
      undefined
    )
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(StreamManager.readers[run.run_id], "the run's log").toBeUndefined();
  expect(await Promise.race([events, "still waiting"])).toEqual([]);
});

it.each(["pending", "running"] as const)(
  "a join of a %s run gets the run's events",
  async (status) => {
    vi.useFakeTimers();
    const { ops, createRun } = await openOps();
    const run = await createRun({ input: { delay: 0 } });
    await ops.runs.setStatus(run.run_id, status);
    const join = ops.runs.stream.join(
      run.run_id,
      run.thread_id,
      { lastEventId: "-1" },
      undefined
    );
    const first = join.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(StreamManager.readers[run.run_id], "the run's log").toBeDefined();

    await ops.runs.stream.publish({
      runId: run.run_id,
      resumable: false,
      event: "values",
      data: { delay: 0 },
    });
    expect((await first).value).toMatchObject({
      event: "values",
      data: { delay: 0 },
    });
    await join.return(undefined);
  }
);

it("a wait reads a finished stateless run deleted with its thread during its grace period", async () => {
  vi.useFakeTimers();
  const { ops, createRun } = await openOps();
  const run = await createRun({ input: { delay: 0 }, temporary: true });
  await runOnce(ops, run, () => ops.threads.delete(run.thread_id, undefined));

  const result = ops.runs.wait(run.run_id, undefined, undefined);
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toEqual({ delay: 0 });
});

it.each<[string, boolean]>([
  ["run", false],
  ["stateless run", true],
])(
  "frees the log a join made for a pending %s after it is cancelled",
  async (_, temporary) => {
    vi.useFakeTimers();
    const { ops, createRun } = await openOps();
    const run = await createRun({ input: { delay: 0 }, temporary });
    const events = gatherIterator(
      ops.runs.stream.join(
        run.run_id,
        undefined,
        { lastEventId: "-1", ignore404: true },
        undefined
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(StreamManager.readers[run.run_id], "the run's log").toBeDefined();

    await ops.runs.cancel(
      run.thread_id,
      [run.run_id],
      { action: "interrupt" },
      undefined
    );
    vi.advanceTimersByTime(RUN_LOG_GRACE_MS);
    expect(
      StreamManager.readers[run.run_id],
      "the log after the grace period"
    ).toBeUndefined();
    expect(await events).toEqual([]);
  }
);
