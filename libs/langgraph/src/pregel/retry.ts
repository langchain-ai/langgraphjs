import {
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Command,
  CONFIG_KEY_RESUMING,
} from "../constants.js";
import {
  getSubgraphsSeenSet,
  isGraphBubbleUp,
  isParentCommand,
} from "../errors.js";
import { PregelExecutableTask } from "./types.js";
import { patchConfigurable, type RetryPolicy } from "./utils/index.js";

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

export async function _runWithRetry<
  N extends PropertyKey,
  C extends PropertyKey
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pregelTask: PregelExecutableTask<N, C>,
  retryPolicy?: RetryPolicy,
  configurable?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{
  task: PregelExecutableTask<N, C>;
  result: unknown;
  error: Error | undefined;
}> {
  const resolvedRetryPolicy = pregelTask.retry_policy ?? retryPolicy;
  let interval =
    resolvedRetryPolicy !== undefined
      ? resolvedRetryPolicy.initialInterval ?? DEFAULT_INITIAL_INTERVAL
      : 0;
  let attempts = 0;
  let error;
  let result;

  let { config } = pregelTask;
  if (configurable) {
    config = patchConfigurable(config, configurable);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) {
      // no need to throw here - we'll throw from the runner, instead.
      // there's just no point in retrying if the user has requested an abort.
      break;
    }
    // Clear any writes from previous attempts
    pregelTask.writes.splice(0, pregelTask.writes.length);
    error = undefined;
    try {
      result = await pregelTask.proc.invoke(pregelTask.input, config);
      break;
    } catch (e: unknown) {
      error = e;
      (error as { pregelTaskId: string }).pregelTaskId = pregelTask.id;
      if (isParentCommand(error)) {
        const ns: string = config?.configurable?.checkpoint_ns;
        const cmd = error.command;
        if (cmd.graph === ns) {
          // this command is for the current graph, handle it
          for (const writer of pregelTask.writers) {
            await writer.invoke(cmd, config);
          }
          break;
        } else if (cmd.graph === Command.PARENT) {
          // this command is for the parent graph, assign it to the parent
          const parent_ns = ns
            .split(CHECKPOINT_NAMESPACE_SEPARATOR)
            .slice(0, -1)
            .join(CHECKPOINT_NAMESPACE_SEPARATOR);
          error.command = new Command({
            ...error.command,
            graph: parent_ns,
          });
        }
      }
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
        (error as Error).name ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((error as Error).constructor as any).unminifiable_name ??
        (error as Error).constructor.name;
      console.log(
        `Retrying task "${String(pregelTask.name)}" after ${interval.toFixed(
          2
        )}ms (attempt ${attempts}) after ${errorName}: ${error}`
      );

      // signal subgraphs to resume (if available)
      config = patchConfigurable(config, { [CONFIG_KEY_RESUMING]: true });
    } finally {
      // Clear checkpoint_ns seen (for subgraph detection)
      const checkpointNs = config?.configurable?.checkpoint_ns;
      if (checkpointNs) {
        getSubgraphsSeenSet().delete(checkpointNs);
      }
    }
  }
  return {
    task: pregelTask,
    result,
    error: error as Error | undefined,
  };
}
