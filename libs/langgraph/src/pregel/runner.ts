import { PendingWrite } from "@langchain/langgraph-checkpoint";
import { Call, PregelExecutableTask, PregelScratchpad } from "./types.js";
import { RetryPolicy } from "./utils/index.js";
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
import { GraphBubbleUp, isGraphBubbleUp, isGraphInterrupt } from "../errors.js";
import { _runWithRetry, SettledPregelTask } from "./retry.js";
import { PregelLoop } from "./loop.js";

/**
 * Options for the {@link PregelRunner#tick} method.
 */
export type TickOptions = {
  /**
   * The deadline before which all tasks must be completed.
   */
  timeout?: number;

  /**
   * An optional {@link AbortSignal} to cancel processing of tasks.
   */
  signal?: AbortSignal;

  /**
   * The {@link RetryPolicy} to use for the tick.
   */
  retryPolicy?: RetryPolicy;

  /**
   * An optional callback to be called after all task writes are completed.
   */
  onStepWrite?: (step: number, writes: PendingWrite[]) => void;
};

/**
 * Responsible for handling task execution on each tick of the {@link PregelLoop}.
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
   * Note: this method does NOT call {@link PregelLoop}#tick. That must be handled externally.
   * @param options - Options for the execution.
   */
  async tick(options: TickOptions = {}) {
    const { timeout, signal, retryPolicy, onStepWrite } = options;

    let graphBubbleUp: GraphBubbleUp | undefined;

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
      this._commit(task, error);
      if (isGraphInterrupt(error)) {
        graphBubbleUp = error;
      } else if (isGraphBubbleUp(error) && !isGraphInterrupt(graphBubbleUp)) {
        graphBubbleUp = error;
      }
    }

    onStepWrite?.(
      this.loop.step,
      Object.values(this.loop.tasks)
        .map((task) => task.writes)
        .flat()
    );

    if (isGraphInterrupt(graphBubbleUp)) {
      throw graphBubbleUp;
    }

    if (isGraphBubbleUp(graphBubbleUp) && this.loop.isNested) {
      throw graphBubbleUp;
    }
  }

  /**
   * Concurrently executes tasks with the requested retry policy, yielding a {@link SettledPregelTask} for each task as it completes.
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

    const promiseAddedSymbol = Symbol.for("promiseAdded");

    let addedPromiseSignal: () => void;

    let addedPromiseWait: Promise<typeof promiseAddedSymbol>;
    function waitHandler(resolve: (value: unknown) => void) {
      addedPromiseSignal = () => {
        addedPromiseWait = new Promise(waitHandler) as Promise<
          typeof promiseAddedSymbol
        >;
        resolve(promiseAddedSymbol);
      };
    }

    addedPromiseWait = new Promise(waitHandler) as Promise<
      typeof promiseAddedSymbol
    >;

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

      // Schedule PUSH tasks, collect promises
      const scratchpad: PregelScratchpad<unknown> =
        task.config?.configurable?.[CONFIG_KEY_SCRATCHPAD];

      const rtn: Record<number, Promise<unknown> | undefined> = {};

      for (const [idx, write] of writes.entries()) {
        const [channel] = write;
        if (channel !== PUSH) {
          continue;
        }

        const wcall = calls?.[idx];
        const cnt = scratchpad.callCounter;
        scratchpad.callCounter += 1;

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
              // should be unreachable
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
          addedPromiseSignal();

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

      return Promise.resolve();
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
        addedPromiseWait,
      ]);

      if (settledTask === promiseAddedSymbol) {
        continue;
      }

      yield settledTask as SettledPregelTask;
      delete executingTasksMap[(settledTask as SettledPregelTask).task.id];
    }
  }

  /**
   * Determines what writes to apply based on whether the task completed successfully, and what type of error occurred.
   *
   * Throws an error if the error is a {@link GraphBubbleUp} error and {@link PregelLoop}#isNested is true.
   *
   * @param task - The task to commit.
   * @param error - The error that occurred, if any.
   */
  private _commit(task: PregelExecutableTask<string, string>, error?: Error) {
    if (error !== undefined) {
      if (isGraphInterrupt(error)) {
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
      } else if (isGraphBubbleUp(error) && task.writes.length) {
        this.loop.putWrites(task.id, task.writes);
      } else {
        this.loop.putWrites(task.id, [
          [ERROR, { message: error.message, name: error.name }],
        ]);
        // TODO: is throwing here safe? what about commits from other concurrent tasks?
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
  }
}
