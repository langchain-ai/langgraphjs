import { PendingWrite } from "@langchain/langgraph-checkpoint";
import { PregelExecutableTask } from "./types.js";
import { RetryPolicy } from "./utils/index.js";
import { CONFIG_KEY_SEND, ERROR, INTERRUPT, RESUME } from "../constants.js";
import {
  GraphInterrupt,
  isGraphBubbleUp,
  isGraphInterrupt,
} from "../errors.js";
import { _runWithRetry, SettledPregelTask } from "./retry.js";
import { PregelLoop } from "./loop.js";

/**
 * Options for the @see PregelRunner#tick method.
 */
export type TickOptions = {
  /**
   * The deadline before which all tasks must be completed.
   */
  timeout?: number;

  /**
   * An optional @see AbortSignal to cancel processing of tasks.
   */
  signal?: AbortSignal;

  /**
   * The @see RetryPolicy to use for the tick.
   */
  retryPolicy?: RetryPolicy;

  /**
   * An optional callback to be called after all task writes are completed.
   */
  onStepWrite?: (step: number, writes: PendingWrite[]) => void;
};

/**
 * Responsible for handling task execution on each tick of the @see PregelLoop.
 */
export class PregelRunner {
  loop: PregelLoop;

  /**
   * Construct a new PregelRunner, which executes tasks from the provided PregelLoop.
   * @param loop - The PregelLoop that produces tasks for this runner to execute.
   */
  constructor({ loop }: { loop: PregelLoop }) {
    this.loop = loop;
  }

  /**
   * Execute tasks from the current step of the PregelLoop.
   *
   * Note: this method does NOT call @see PregelLoop#tick. That must be handled externally.
   * @param options - Options for the execution.
   */
  async tick(options: TickOptions = {}): Promise<void> {
    const tasks = Object.values(this.loop.tasks);

    const { timeout, signal, retryPolicy, onStepWrite } = options;

    // Start task execution
    const pendingTasks = tasks.filter((t) => t.writes.length === 0);
    const taskStream = this._executeTasksWithRetry(pendingTasks, {
      stepTimeout: timeout,
      signal,
      retryPolicy,
    });

    let graphInterrupt: GraphInterrupt | undefined;

    for await (const { task, error } of taskStream) {
      graphInterrupt = this._commit(task, error) ?? graphInterrupt;
    }

    onStepWrite?.(
      this.loop.step,
      Object.values(this.loop.tasks)
        .map((task) => task.writes)
        .flat()
    );

    if (graphInterrupt) {
      throw graphInterrupt;
    }
  }

  /**
   * Concurrently executes tasks with the requested retry policy, yielding a @see SettledPregelTask for each task as it completes.
   * @param tasks - The tasks to execute.
   * @param options - Options for the execution.
   */
  private async *_executeTasksWithRetry(
    tasks: PregelExecutableTask<string, string>[],
    options?: {
      stepTimeout?: number;
      signal?: AbortSignal;
      retryPolicy?: RetryPolicy;
    }
  ): AsyncGenerator<SettledPregelTask> {
    const { stepTimeout, retryPolicy } = options ?? {};
    let signal = options?.signal;

    const executingTasksMap: Record<
      string,
      Promise<{
        task: PregelExecutableTask<string, string>;
        result?: unknown;
        error?: Error;
      }>
    > = {};

    const writer = (
      task: PregelExecutableTask<string, string>,
      writes: Array<[string, unknown]>
    ): Array<Promise<unknown> | undefined> => {
      // placeholder function - will have logic added when functional API is implemented
      return task.config?.configurable?.[CONFIG_KEY_SEND]?.(writes) ?? [];
    };

    // Start tasks
    Object.assign(
      executingTasksMap,
      Object.fromEntries(
        tasks.map((pregelTask) => {
          return [
            pregelTask.id,
            _runWithRetry(pregelTask, retryPolicy, {
              [CONFIG_KEY_SEND]: writer?.bind(this, pregelTask),
            }).catch((error) => {
              return { task: pregelTask, error };
            }),
          ];
        })
      )
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
      yield settledTask as SettledPregelTask;
      delete executingTasksMap[settledTask.task.id];
    }
  }

  /**
   * Determines what writes to apply based on whether the task completed successfully, and what type of error occurred.
   *
   * Throws an error if the error is a @see GraphBubbleUp error and @see PregelLoop#isNested is true.
   *
   * Note that in the case of a @see GraphBubbleUp error that is not a @see GraphInterrupt, like a @see Command, this method does not apply any writes.
   *
   * @param task - The task to commit.
   * @param error - The error that occurred, if any.
   * @returns The @see GraphInterrupt that occurred, if the user's code threw one.
   */
  private _commit(
    task: PregelExecutableTask<string, string>,
    error?: Error
  ): GraphInterrupt | undefined {
    let graphInterrupt;
    if (error !== undefined) {
      if (isGraphBubbleUp(error)) {
        if (this.loop.isNested) {
          throw error;
        }
        if (isGraphInterrupt(error)) {
          graphInterrupt = error;
          if (error.interrupts.length) {
            const interrupts: PendingWrite<string>[] = error.interrupts.map(
              (interrupt) => [INTERRUPT, interrupt]
            );
            const resumes = task.writes.filter((w) => w[0] === RESUME);
            if (resumes.length) {
              interrupts.push(...resumes);
            }
            this.loop.putWrites(task.id, interrupts);
          }
        }
      } else {
        this.loop.putWrites(task.id, [
          [ERROR, { message: error.message, name: error.name }],
        ]);
        throw error;
      }
    } else {
      // Save task writes to checkpointer
      this.loop.putWrites(task.id, task.writes);
    }
    return graphInterrupt;
  }
}
