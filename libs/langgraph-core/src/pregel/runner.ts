import { PendingWrite } from "@langchain/langgraph-checkpoint";
import {
  Call,
  PregelAbortSignals,
  PregelExecutableTask,
  PregelScratchpad,
} from "./types.js";
import {
  CachePolicy,
  combineAbortSignals,
  patchConfigurable,
  RetryPolicy,
} from "./utils/index.js";
import {
  CONFIG_KEY_SCRATCHPAD,
  ERROR,
  INTERRUPT,
  RESUME,
  NO_WRITES,
  TAG_HIDDEN,
  RETURN,
  CONFIG_KEY_CALL,
  CONFIG_KEY_ABORT_SIGNALS,
} from "../constants.js";
import { GraphBubbleUp, isGraphBubbleUp, isGraphInterrupt } from "../errors.js";
import { _runWithRetry, SettledPregelTask } from "./retry.js";
import { PregelLoop } from "./loop.js";

const PROMISE_ADDED_SYMBOL = Symbol.for("promiseAdded");

function createPromiseBarrier() {
  const barrier: {
    next: () => void;
    wait: Promise<unknown>;
  } = {
    next: () => void 0,
    wait: Promise.resolve(PROMISE_ADDED_SYMBOL),
  };

  function waitHandler(resolve: (value: typeof PROMISE_ADDED_SYMBOL) => void) {
    barrier.next = () => {
      barrier.wait = new Promise(waitHandler);
      resolve(PROMISE_ADDED_SYMBOL);
    };
  }
  barrier.wait = new Promise(waitHandler);
  return barrier;
}

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

  /**
   * The maximum number of tasks to execute concurrently.
   */
  maxConcurrency?: number;
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
    const { timeout, retryPolicy, onStepWrite, maxConcurrency } = options;

    const nodeErrors: Set<Error> = new Set();
    let graphBubbleUp: GraphBubbleUp | undefined;

    const exceptionSignalController = new AbortController();
    const exceptionSignal = exceptionSignalController.signal;
    const stepTimeoutSignal = timeout
      ? AbortSignal.timeout(timeout)
      : undefined;

    // Start task execution (cache Object.values once)
    const allTasks = Object.values(this.loop.tasks);
    const pendingTasks = allTasks.filter((t) => t.writes.length === 0);

    const { signals, disposeCombinedSignal } = this._initializeAbortSignals({
      exceptionSignal,
      stepTimeoutSignal,
      signal: options.signal,
    });

    const taskStream = this._executeTasksWithRetry(pendingTasks, {
      signals,
      retryPolicy,
      maxConcurrency,
    });

    for await (const { task, error, signalAborted } of taskStream) {
      this._commit(task, error);
      if (isGraphInterrupt(error)) {
        graphBubbleUp = error;
      } else if (isGraphBubbleUp(error) && !isGraphInterrupt(graphBubbleUp)) {
        graphBubbleUp = error;
      } else if (error && (nodeErrors.size === 0 || !signalAborted)) {
        /*
         * The goal here is to capture the exception that causes the graph to terminate early. In
         * theory it's possible for multiple nodes to throw, so this also handles the edge case of
         * capturing concurrent exceptions thrown before the node saw an abort. This is checked via
         * the signalAborted flag, which records the state of the abort signal at the time the node
         * execution finished.
         *
         * There is a case however where one node throws some error causing us to trigger an abort,
         * which then causes other concurrently executing nodes to throw their own AbortErrors. In
         * this case we don't care about reporting the abort errors thrown by the other nodes,
         * because they don't tell the user anything about what caused the graph execution to
         * terminate early, so we ignore them (and any other errors that occur after the node sees
         * an abort signal).
         */
        exceptionSignalController.abort();
        nodeErrors.add(error);
      }
    }

    disposeCombinedSignal?.();

    onStepWrite?.(this.loop.step, allTasks.map((task) => task.writes).flat());

    if (nodeErrors.size === 1) {
      throw Array.from(nodeErrors)[0];
    } else if (nodeErrors.size > 1) {
      throw new AggregateError(
        Array.from(nodeErrors),
        `Multiple errors occurred during superstep ${this.loop.step}. See the "errors" field of this exception for more details.`
      );
    }

    if (isGraphInterrupt(graphBubbleUp)) {
      throw graphBubbleUp;
    }

    if (isGraphBubbleUp(graphBubbleUp) && this.loop.isNested) {
      throw graphBubbleUp;
    }
  }

  /**
   * Initializes the current AbortSignals for the PregelRunner, handling the various ways that
   * AbortSignals must be chained together so that the PregelLoop can be interrupted if necessary
   * while still allowing nodes to gracefully exit.
   *
   * This method must only be called once per PregelRunner#tick. It has the side effect of updating
   * the PregelLoop#config with the new AbortSignals so they may be propagated correctly to future
   * ticks and subgraph calls.
   *
   * @param options - Options for the initialization.
   * @returns The current abort signals.
   * @internal
   */
  private _initializeAbortSignals({
    exceptionSignal,
    stepTimeoutSignal,
    signal,
  }: {
    exceptionSignal: AbortSignal;
    stepTimeoutSignal?: AbortSignal;
    signal?: AbortSignal;
  }): { signals: PregelAbortSignals; disposeCombinedSignal?: () => void } {
    const previousSignals = (this.loop.config.configurable?.[
      CONFIG_KEY_ABORT_SIGNALS
    ] ?? {}) as PregelAbortSignals;

    // We always inherit the external abort signal from AsyncLocalStorage,
    // since that's the only way the signal is inherited by the subgraph calls.
    const externalAbortSignal = previousSignals.externalAbortSignal ?? signal;

    // inherit the step timeout signal from parent graph
    const timeoutAbortSignal =
      stepTimeoutSignal ?? previousSignals.timeoutAbortSignal;

    const { signal: composedAbortSignal, dispose: disposeCombinedSignal } =
      combineAbortSignals(
        externalAbortSignal,
        timeoutAbortSignal,
        exceptionSignal
      );

    const signals: PregelAbortSignals = {
      externalAbortSignal,
      timeoutAbortSignal,
      composedAbortSignal,
    };

    this.loop.config = patchConfigurable(this.loop.config, {
      [CONFIG_KEY_ABORT_SIGNALS]: signals,
    });

    return { signals, disposeCombinedSignal };
  }

  /**
   * Concurrently executes tasks with the requested retry policy, yielding a {@link SettledPregelTask} for each task as it completes.
   * @param tasks - The tasks to execute.
   * @param options - Options for the execution.
   */
  private async *_executeTasksWithRetry(
    tasks: PregelExecutableTask<string, string>[],
    options?: {
      signals?: PregelAbortSignals;
      retryPolicy?: RetryPolicy;
      maxConcurrency?: number;
    }
  ): AsyncGenerator<SettledPregelTask> {
    const { retryPolicy, maxConcurrency, signals } = options ?? {};

    const barrier = createPromiseBarrier();
    const executingTasksMap: Record<
      string,
      Promise<{
        task: PregelExecutableTask<string, string>;
        result?: unknown;
        error?: Error;
      }>
    > = {};

    const thisCall = {
      executingTasksMap,
      barrier,
      retryPolicy,
      scheduleTask: async (
        task: PregelExecutableTask<string, string>,
        writeIdx: number,
        call?: Call
      ) => this.loop.acceptPush(task, writeIdx, call),
    };

    if (signals?.composedAbortSignal?.aborted) {
      // note: don't use throwIfAborted here because it throws a DOMException,
      // which isn't consistent with how we throw on abort below.
      throw new Error("Abort");
    }

    let startedTasksCount = 0;

    let listener: (() => void) | undefined;
    const timeoutOrCancelSignal = combineAbortSignals(
      signals?.externalAbortSignal,
      signals?.timeoutAbortSignal
    );

    const abortPromise = timeoutOrCancelSignal.signal
      ? new Promise<never>((_resolve, reject) => {
          listener = () => reject(new Error("Abort"));
          timeoutOrCancelSignal.signal?.addEventListener("abort", listener, {
            once: true,
          });
        })
      : undefined;

    while (
      (startedTasksCount === 0 || Object.keys(executingTasksMap).length > 0) &&
      tasks.length
    ) {
      for (
        ;
        Object.keys(executingTasksMap).length <
          (maxConcurrency ?? tasks.length) && startedTasksCount < tasks.length;
        startedTasksCount += 1
      ) {
        const task = tasks[startedTasksCount];

        executingTasksMap[task.id] = _runWithRetry(
          task,
          retryPolicy,
          { [CONFIG_KEY_CALL]: call?.bind(thisCall, this, task) },
          signals?.composedAbortSignal
        ).catch((error) => {
          return {
            task,
            error,
            signalAborted: signals?.composedAbortSignal?.aborted,
          };
        });
      }

      // Build promises array once for Promise.race instead of spreading
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promises: Promise<any>[] = Object.values(executingTasksMap);
      if (abortPromise) promises.push(abortPromise);
      promises.push(barrier.wait);
      const settledTask = await Promise.race(promises);

      if (settledTask === PROMISE_ADDED_SYMBOL) {
        continue;
      }

      yield settledTask as SettledPregelTask;

      if (listener != null) {
        timeoutOrCancelSignal.signal?.removeEventListener("abort", listener);
        timeoutOrCancelSignal.dispose?.();
      }

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

async function call(
  this: {
    executingTasksMap: Record<
      string,
      Promise<{
        task: PregelExecutableTask<string, string>;
        result?: unknown;
        error?: Error;
      }>
    >;

    barrier: {
      next: () => void;
      wait: Promise<unknown>;
    };

    retryPolicy?: RetryPolicy;

    scheduleTask: (
      task: PregelExecutableTask<string, string>,
      writeIdx: number,
      call?: Call
    ) => Promise<PregelExecutableTask<string, string> | void>;
  },
  runner: PregelRunner,
  task: PregelExecutableTask<string, string>,
  func: (...args: unknown[]) => unknown | Promise<unknown>,
  name: string,
  input: unknown,
  options: {
    retry?: RetryPolicy;
    cache?: CachePolicy;
    callbacks?: unknown;
  } = {}
): Promise<unknown> {
  // Schedule PUSH tasks, collect promises
  const scratchpad = task.config?.configurable?.[CONFIG_KEY_SCRATCHPAD] as
    | PregelScratchpad<unknown>
    | undefined;

  if (!scratchpad) {
    throw new Error(
      `BUG: No scratchpad found on task ${task.name}__${task.id}`
    );
  }

  const cnt = scratchpad.callCounter;
  scratchpad.callCounter += 1;

  // schedule the next task, if the callback returns one
  const wcall = new Call({
    func,
    name,
    input,
    cache: options.cache,
    retry: options.retry,
    callbacks: options.callbacks,
  });
  const nextTask = await this.scheduleTask(task, cnt, wcall);
  if (!nextTask) return undefined;

  // Check if this task is already running
  const existingPromise = this.executingTasksMap[nextTask.id];

  if (existingPromise !== undefined) {
    // If the parent task was retried, the next task might already be running
    return existingPromise;
  }

  if (nextTask.writes.length > 0) {
    // If it already ran, return the result
    const returns = nextTask.writes.filter(([c]) => c === RETURN);
    const errors = nextTask.writes.filter(([c]) => c === ERROR);

    if (returns.length > 0) {
      // Task completed successfully
      if (returns.length === 1) return Promise.resolve(returns[0][1]);

      // should be unreachable
      throw new Error(
        `BUG: multiple returns found for task ${nextTask.name}__${nextTask.id}`
      );
    }

    if (errors.length > 0) {
      // Task failed
      if (errors.length === 1) {
        const errorValue = errors[0][1];
        const error =
          // eslint-disable-next-line no-instanceof/no-instanceof
          errorValue instanceof Error
            ? errorValue
            : new Error(String(errorValue));

        return Promise.reject(error);
      }

      // the only way this should happen is if the task executes multiple times and writes aren't cleared
      throw new Error(
        `BUG: multiple errors found for task ${nextTask.name}__${nextTask.id}`
      );
    }

    return undefined;
  } else {
    // Schedule the next task with retry
    const prom = _runWithRetry<string, string>(nextTask, options.retry, {
      [CONFIG_KEY_CALL]: call.bind(this, runner, nextTask),
    });

    this.executingTasksMap[nextTask.id] = prom;
    this.barrier.next();

    return prom.then(({ result, error }) => {
      if (error) return Promise.reject(error);
      return result;
    });
  }
}
