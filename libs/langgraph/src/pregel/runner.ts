import { PendingWrite } from "@langchain/langgraph-checkpoint";
import { Call, PregelExecutableTask } from "./types.js";
import { patchConfigurable, RetryPolicy } from "./utils/index.js";
import {
  CONFIG_KEY_SEND,
  CONFIG_KEY_SCRATCHPAD,
  PUSH,
  ERROR,
  INTERRUPT,
  RESUME,
  NO_WRITES,
  TAG_HIDDEN,
  RETURN,
  CONFIG_KEY_CALL,
} from "../constants.js";
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
  private nodeFinished?: (id: string) => void;

  private loop: PregelLoop;

  /**
   * Construct a new PregelRunner, which executes tasks from the provided PregelLoop.
   * @param loop - The PregelLoop that produces tasks for this runner to execute.
   */
  constructor({
    loop,
    nodeFinished,
  }: {
    loop: PregelLoop;
    nodeFinished?: (id: string) => void;
  }) {
    this.loop = loop;
    this.nodeFinished = nodeFinished;
  }

  /**
   * Execute tasks from the current step of the PregelLoop.
   *
   * Note: this method does NOT call @see PregelLoop#tick. That must be handled externally.
   * @param options - Options for the execution.
   */
  async tick(options: TickOptions = {}): Promise<void> {
    const { timeout, signal, retryPolicy, onStepWrite } = options;

    let graphInterrupt: GraphInterrupt | undefined;

    // Start task execution
    const pendingTasks = Object.values(this.loop.tasks).filter(
      (t) => t.writes.length === 0
    );

    const taskStream = this._executeTasksWithRetry(pendingTasks, {
      stepTimeout: timeout,
      signal,
      retryPolicy,
    });

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
      writes: Array<[string, unknown]>,
      { calls }: { calls?: Call[] } = {}
    ): Array<Promise<unknown> | undefined> => {
      if (writes.every(([channel]) => channel !== PUSH)) {
        return task.config?.configurable?.[CONFIG_KEY_SEND]?.(writes) ?? [];
      }

      // TODO: type the scratchpad stuff, extract boilerplate
      // Schedule PUSH tasks, collect promises
      if (task.config?.configurable?.[CONFIG_KEY_SCRATCHPAD] == null) {
        patchConfigurable(task.config, {
          [CONFIG_KEY_SCRATCHPAD]: {},
        });
      }
      const scratchpad = task.config?.configurable?.[
        CONFIG_KEY_SCRATCHPAD
      ] as Record<string, unknown>;
      scratchpad.callCounter = (scratchpad.callCounter as number) ?? 0;

      const rtn: Record<number, Promise<unknown> | undefined> = {};

      for (const [idx, write] of writes.entries()) {
        const [channel] = write;
        if (channel !== PUSH) {
          continue;
        }

        const wcall = calls?.[idx];
        const cnt = scratchpad.callCounter as number;
        scratchpad.callCounter = cnt + 1;

        if (wcall == null) {
          throw new Error("BUG: No call found");
        }

        const nextTask = this.loop.acceptPush(task, cnt, wcall);

        if (!nextTask) {
          continue;
        }

        // Check if this task is already running
        const existingPromise = executingTasksMap[nextTask.id];

        if (existingPromise !== undefined) {
          // If the parent task was retried, the next task might already be running
          rtn[idx] = existingPromise;
        } else if (nextTask.writes.length > 0) {
          // If it already ran, return the result
          const returns = nextTask.writes.filter(([c]) => c === RETURN);
          const errors = nextTask.writes.filter(([c]) => c === ERROR);

          if (returns.length > 0) {
            // Task completed successfully
            if (returns.length === 1) {
              rtn[idx] = Promise.resolve(returns[0][1]);
            } else {
              // the only way this should happen is if the task executes multiple times and writes aren't cleared
              throw new Error(
                `BUG: multiple returns found for task ${nextTask.name}__${nextTask.id}`
              );
            }
          } else if (errors.length > 0) {
            if (errors.length === 1) {
              const errorValue = errors[0][1];
              // Task failed
              const error =
                // eslint-disable-next-line no-instanceof/no-instanceof
                errorValue instanceof Error
                  ? errorValue
                  : new Error(String(errorValue));

              rtn[idx] = Promise.reject(error);
            } else {
              // the only way this should happen is if the task executes multiple times and writes aren't cleared
              throw new Error(
                `BUG: multiple errors found for task ${nextTask.name}__${nextTask.id}`
              );
            }
          }
        } else {
          // Schedule the next task with retry
          const prom = _runWithRetry<string, string>(nextTask, retryPolicy, {
            [CONFIG_KEY_SEND]: writer.bind(this, nextTask),
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            [CONFIG_KEY_CALL]: call.bind(this, nextTask),
          });

          executingTasksMap[nextTask.id] = prom;

          rtn[idx] = prom.then(({ result, error }) => {
            if (error) {
              return Promise.reject(error);
            }

            return result;
          });
        }
      }

      return Object.values(rtn);
    };

    const call = (
      task: PregelExecutableTask<string, string>,
      func: (...args: unknown[]) => unknown | Promise<unknown>,
      name: string,
      input: unknown,
      options: { retry?: RetryPolicy; callbacks?: unknown } = {}
    ) => {
      const result = writer(task, [[PUSH, null]], {
        calls: [
          new Call({
            func,
            name,
            input,
            retry: options.retry,
            callbacks: options.callbacks,
          }),
        ],
      });

      // eslint-disable-next-line no-instanceof/no-instanceof
      if (result !== undefined) {
        if (result.length === 1) {
          return result[0];
        }
        return Promise.all(result);
      }

      return Promise.resolve(result);
    };

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

    // don't start tasks if signal is aborted!
    if (signal?.aborted) {
      // note: don't use throwIfAborted here because it throws a DOMException,
      // which isn't consistent with how we throw on abort below.
      throw new Error("Abort");
    }

    // Start tasks
    Object.assign(
      executingTasksMap,
      Object.fromEntries(
        tasks.map((pregelTask) => {
          return [
            pregelTask.id,
            _runWithRetry(pregelTask, retryPolicy, {
              [CONFIG_KEY_SEND]: writer?.bind(this, pregelTask),
              [CONFIG_KEY_CALL]: call?.bind(this, pregelTask),
            }).catch((error) => {
              return { task: pregelTask, error };
            }),
          ];
        })
      )
    );

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
      if (
        this.nodeFinished &&
        (task.config?.tags == null || !task.config.tags.includes(TAG_HIDDEN))
      ) {
        this.nodeFinished(String(task.name));
      }

      if (task.writes.length === 0) {
        // Add no writes marker
        task.writes.push([NO_WRITES, null]);
      }

      // Save task writes to checkpointer
      this.loop.putWrites(task.id, task.writes);
    }
    return graphInterrupt;
  }
}
