import { type Run, type RunStatus, Runs, Threads } from "./storage/ops.mjs";
import {
  type StreamCheckpoint,
  type StreamTaskResult,
  streamState,
} from "./stream.mjs";
import { logError, logger } from "./logging.mjs";
import { serializeError } from "./utils/serde.mjs";
import { callWebhook } from "./webhook.mjs";

const MAX_RETRY_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const queue = async () => {
  while (true) {
    for await (const { run, attempt, signal } of Runs.next()) {
      await worker(run, attempt, signal);
    }

    // TODO: this is very suboptimal, we should implement subscription to the run
    await sleep(1000 * Math.random());
  }
};

const worker = async (run: Run, attempt: number, abortSignal: AbortSignal) => {
  const startedAt = new Date();
  let endedAt: Date | undefined = undefined;
  let checkpoint: StreamCheckpoint | undefined = undefined;
  let exception: Error | undefined = undefined;
  let status: RunStatus | undefined = undefined;

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

  try {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      throw new Error(`Run ${run.run_id} exceeded max attempts`);
    }

    try {
      const stream = streamState(run, attempt, {
        signal: abortSignal,
        ...(!temporary ? { onCheckpoint, onTaskResult } : undefined),
      });

      for await (const { event, data } of stream) {
        await Runs.Stream.publish(run.run_id, event, data);
      }
    } catch (error) {
      await Runs.Stream.publish(run.run_id, "error", serializeError(error));
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
    await Runs.setStatus(run.run_id, status);
  } catch (error) {
    endedAt = new Date();
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
    await Runs.setStatus(run.run_id, "error");
  } finally {
    if (temporary) {
      await Threads.delete(run.thread_id, undefined);
    } else {
      await Threads.setStatus(run.thread_id, { checkpoint, exception });
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
