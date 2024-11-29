import { getSubgraphsSeenSet, isGraphBubbleUp } from "../errors.js";
import { PregelExecutableTask } from "./types.js";
import type { RetryPolicy } from "./utils/index.js";

export const DEFAULT_INITIAL_INTERVAL = 500;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const DEFAULT_MAX_INTERVAL = 128000;
export const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_STATUS_NO_RETRY = [
  400, // Bad Request
  401, // Unauthorized
  402, // Payment Required
  403, // Forbidden
  404, // Not Found
  405, // Method Not Allowed
  406, // Not Acceptable
  407, // Proxy Authentication Required
  409, // Conflict
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFAULT_RETRY_ON_HANDLER = (error: any) => {
  if (
    error.message.startsWith("Cancel") ||
    error.message.startsWith("AbortError") ||
    error.name === "AbortError"
  ) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((error as any)?.code === "ECONNABORTED") {
    return false;
  }
  const status =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (error as any)?.response?.status ?? (error as any)?.status;
  if (status && DEFAULT_STATUS_NO_RETRY.includes(+status)) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((error as any)?.error?.code === "insufficient_quota") {
    return false;
  }
  return true;
};

export type SettledPregelTask = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: PregelExecutableTask<any, any>;
  error: Error;
};

export async function* executeTasksWithRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: PregelExecutableTask<any, any>[],
  options?: {
    stepTimeout?: number;
    signal?: AbortSignal;
    retryPolicy?: RetryPolicy;
  }
): AsyncGenerator<SettledPregelTask> {
  const { stepTimeout, retryPolicy } = options ?? {};
  let signal = options?.signal;
  // Start tasks
  const executingTasksMap = Object.fromEntries(
    tasks.map((pregelTask) => {
      return [pregelTask.id, _runWithRetry(pregelTask, retryPolicy)];
    })
  );
  if (stepTimeout && signal) {
    if ("any" in AbortSignal) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signal = (AbortSignal as any).any([
        signal,
        AbortSignal.timeout(stepTimeout),
      ]);
    }
  } else if (stepTimeout) {
    signal = AbortSignal.timeout(stepTimeout);
  }

  // Abort if signal is aborted
  signal?.throwIfAborted();

  let listener: () => void;
  const signalPromise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error("Abort"));
    signal?.addEventListener("abort", listener);
  }).finally(() => signal?.removeEventListener("abort", listener));

  while (Object.keys(executingTasksMap).length > 0) {
    const settledTask = await Promise.race([
      ...Object.values(executingTasksMap),
      signalPromise,
    ]);
    yield settledTask;
    delete executingTasksMap[settledTask.task.id];
  }
}

async function _runWithRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pregelTask: PregelExecutableTask<any, any>,
  retryPolicy?: RetryPolicy
) {
  const resolvedRetryPolicy = pregelTask.retry_policy ?? retryPolicy;
  let interval =
    resolvedRetryPolicy !== undefined
      ? resolvedRetryPolicy.initialInterval ?? DEFAULT_INITIAL_INTERVAL
      : 0;
  let attempts = 0;
  let error;
  let result;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Modify writes in place to clear any previous retries
    while (pregelTask.writes.length > 0) {
      pregelTask.writes.pop();
    }
    error = undefined;
    try {
      result = await pregelTask.proc.invoke(
        pregelTask.input,
        pregelTask.config
      );
      break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      error = e;
      error.pregelTaskId = pregelTask.id;
      if (isGraphBubbleUp(error)) {
        break;
      }
      if (resolvedRetryPolicy === undefined) {
        break;
      }
      attempts += 1;
      // check if we should give up
      if (
        attempts >= (resolvedRetryPolicy.maxAttempts ?? DEFAULT_MAX_RETRIES)
      ) {
        break;
      }
      const retryOn = resolvedRetryPolicy.retryOn ?? DEFAULT_RETRY_ON_HANDLER;
      if (!retryOn(error)) {
        break;
      }
      interval = Math.min(
        resolvedRetryPolicy.maxInterval ?? DEFAULT_MAX_INTERVAL,
        interval * (resolvedRetryPolicy.backoffFactor ?? DEFAULT_BACKOFF_FACTOR)
      );
      const intervalWithJitter = resolvedRetryPolicy.jitter
        ? Math.floor(interval + Math.random() * 1000)
        : interval;
      // sleep before retrying
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, intervalWithJitter));
      // log the retry
      const errorName =
        error.name ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error.constructor as any).unminifiable_name ??
        error.constructor.name;
      console.log(
        `Retrying task "${pregelTask.name}" after ${interval.toFixed(
          2
        )}ms (attempt ${attempts}) after ${errorName}: ${error}`
      );
    } finally {
      // Clear checkpoint_ns seen (for subgraph detection)
      const checkpointNs = pregelTask.config?.configurable?.checkpoint_ns;
      if (checkpointNs) {
        getSubgraphsSeenSet().delete(checkpointNs);
      }
    }
  }
  return {
    task: pregelTask,
    result,
    error,
  };
}
