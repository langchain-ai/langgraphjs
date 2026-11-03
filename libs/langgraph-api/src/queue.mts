import { HTTPException } from "hono/http-exception";
import type {
  CheckpointPayload,
  Ops,
  Run,
  RunStatus,
} from "./storage/types.mjs";
import {
  type StreamCheckpoint,
  type StreamTaskResult,
  streamState,
} from "./stream.mjs";
import { logError, logger } from "./logging.mjs";
import { serializeError } from "./utils/serde.mjs";
import { callWebhook } from "./webhook.mjs";
import { getGraph } from "./graph/load.mjs";

const MAX_RETRY_ATTEMPTS = 3;

// Strict resume refuses an answer to an interrupt that isn't pending. A retry
// sends its answer again, and an `interrupt` or `rollback` run has already
// cancelled the run it replaces, so refusing either would stop the agent
// mid-turn: those resume as before.
function withStrictResume(run: Run, attempt: number): Run {
  const strict =
    attempt === 1 &&
    run.multitask_strategy !== "interrupt" &&
    run.multitask_strategy !== "rollback";
  return {
    ...run,
    kwargs: {
      ...run.kwargs,
      config: {
        ...run.kwargs.config,
        configurable: {
          ...run.kwargs.config?.configurable,
          __pregel_strict_resume: strict,
        },
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const queue = async (ops: Ops) => {
  while (true) {
    for await (const { run, attempt, signal } of ops.runs.next()) {
      // Nothing restarts this loop, so one run's failure must not end it.
      await worker(ops, run, attempt, signal).catch((error) =>
        logError(error, {
          prefix: "Background worker failed",
          context: { run_id: run.run_id },
        })
      );
    }

    // TODO: this is very suboptimal, we should implement subscription to the run
    await sleep(1000 * Math.random());
  }
};

const worker = async (
  ops: Ops,
  run: Run,
  attempt: number,
  signal: AbortSignal
) => {
  const startedAt = new Date();
  let endedAt: Date | undefined = undefined;
  let checkpoint: StreamCheckpoint | undefined = undefined;
  let exception: Error | undefined = undefined;
  let status: RunStatus | "rollback" | undefined = undefined;

  const temporary = run.kwargs.temporary;
  const webhook = run.kwargs.webhook as string | undefined;

  logger.info("Starting background run", {
    run_id: run.run_id,
    run_attempt: attempt,
    run_created_at: run.created_at,
    run_started_at: startedAt,
    run_queue_ms: startedAt.valueOf() - run.created_at.valueOf(),
  });

  const onCheckpoint = (value: StreamCheckpoint) => {
    checkpoint = value;
  };

  const onTaskResult = (result: StreamTaskResult) => {
    if (checkpoint == null) return;
    const index = checkpoint.tasks.findIndex((task) => task.id === result.id);
    checkpoint.tasks[index] = {
      ...checkpoint.tasks[index],
      ...result,
    };
  };

  const isCancelled = () =>
    signal.aborted &&
    (signal.reason === "interrupt" || signal.reason === "rollback");

  // The run, or its thread, can be deleted while it runs: a final write that
  // fails because its record is gone has nothing left to update.
  const unlessGone = async (
    write: Promise<unknown>,
    isGone: () => Promise<boolean>
  ) => {
    try {
      await write;
    } catch (error) {
      if (!(await isGone())) throw error;
    }
  };
  const runGone = async () =>
    (await ops.runs.get(run.run_id, run.thread_id, undefined)) == null;
  const threadGone = () =>
    ops.threads.get(run.thread_id, undefined).then(
      () => false,
      (error) => {
        if (error instanceof HTTPException && error.status === 404) return true;
        throw error;
      }
    );

  try {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      throw new Error(`Run ${run.run_id} exceeded max attempts`);
    }

    const runId = run.run_id;
    const resumable = run.kwargs?.resumable ?? false;

    try {
      const stream = streamState(withStrictResume(run, attempt), {
        getGraph,
        attempt,
        signal,
        ...(!temporary ? { onCheckpoint, onTaskResult } : undefined),
      });

      for await (const { event, data, normalized } of stream) {
        await ops.runs.stream.publish({
          runId,
          resumable,
          event,
          data,
          ...(normalized != null ? { normalized } : {}),
        });
      }
    } catch (error) {
      if (!isCancelled()) {
        await ops.runs.stream.publish({
          runId,
          resumable,
          event: "error",
          data: serializeError(error),
        });
      }
      throw error;
    }

    endedAt = new Date();
    logger.info("Background run succeeded", {
      run_id: run.run_id,
      run_attempt: attempt,
      run_created_at: run.created_at,
      run_started_at: startedAt,
      run_ended_at: endedAt,
      run_exec_ms: endedAt.valueOf() - startedAt.valueOf(),
    });

    status = "success";
    await unlessGone(ops.runs.setStatus(run.run_id, status), runGone);
  } catch (error) {
    endedAt = new Date();

    if (isCancelled()) {
      checkpoint = undefined;
      if (signal.reason === "rollback") {
        status = "rollback";
        await unlessGone(
          ops.runs.delete(run.run_id, run.thread_id, undefined),
          runGone
        );
      } else {
        status = "interrupted";
        await unlessGone(ops.runs.setStatus(run.run_id, status), runGone);
      }
    } else {
      if (error instanceof Error) exception = error;

      logError(error, {
        prefix: "Background run failed",
        context: {
          run_id: run.run_id,
          run_attempt: attempt,
          run_created_at: run.created_at,
          run_started_at: startedAt,
          run_ended_at: endedAt,
          run_exec_ms: endedAt.valueOf() - startedAt.valueOf(),
        },
      });

      status = "error";
      await unlessGone(ops.runs.setStatus(run.run_id, status), runGone);
    }
  } finally {
    if (temporary) {
      await unlessGone(
        ops.threads.delete(run.thread_id, undefined),
        threadGone
      );
    } else if (exception?.name === "UnknownInterruptError") {
      // A refused resume ran nothing, so the thread keeps the state it had.
      await unlessGone(
        ops.threads.state
          .get(
            { configurable: { thread_id: run.thread_id } },
            { subgraphs: false },
            undefined
          )
          .then((state) =>
            ops.threads.setStatus(run.thread_id, {
              checkpoint: state as unknown as CheckpointPayload,
            })
          ),
        threadGone
      );
    } else {
      await unlessGone(
        ops.threads.setStatus(run.thread_id, { checkpoint, exception }),
        threadGone
      );
    }

    if (webhook) {
      await callWebhook({
        checkpoint,
        status,
        exception,
        run,
        webhook,
        run_started_at: startedAt,
        run_ended_at: endedAt,
      });
    }
  }
};
