import { v7 as uuidv7 } from "@langchain/core/utils/uuid";
import type { AgentServerAdapter } from "../client/stream/transport.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { Run } from "../schema.js";
import { prepareOptimisticInput } from "./optimistic-input.js";
import type { StreamStore } from "./store.js";
import type { StreamControllerOptions, StreamSubmitOptions } from "./types.js";
import type {
  SubmissionQueueEntry,
  SubmissionQueueSnapshot,
} from "./submit-coordinator.js";

type Runs = NonNullable<AgentServerAdapter["serverQueue"]>;
type Terminal = {
  event: "completed" | "failed" | "interrupted" | "aborted";
  error?: string;
};

function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    return;
  }
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export function queueRuns<StateType extends object>(
  options: StreamControllerOptions<StateType>
): Runs | undefined {
  return (
    options.serverQueue ??
    (typeof options.transport === "object"
      ? options.transport.serverQueue
      : undefined)
  );
}

export async function awaitRunTerminal(
  runs: Runs,
  threadId: string,
  runId: string,
  signal: AbortSignal
): Promise<Terminal> {
  while (!signal.aborted) {
    const run = await runs.get(threadId, runId, { signal });
    if (run.status === "success") return { event: "completed" };
    if (run.status === "interrupted") return { event: "interrupted" };
    if (run.status === "error" || run.status === "timeout") {
      return { event: "failed", error: `Run ${runId} ${run.status}` };
    }
    await runs.join(threadId, runId, { signal, cancelOnDisconnect: false });
    await delay(signal);
  }
  return { event: "aborted" };
}

/** Mirrors accepted server runs without replacing the thread's content stream. */
export class ServerQueue<StateType extends object> {
  readonly #options: StreamControllerOptions<StateType>;
  readonly #store: StreamStore<SubmissionQueueSnapshot<StateType>>;
  readonly #onError: (error: unknown) => void;
  readonly #onActivity: () => void;
  #abort = new AbortController();
  #threadId: string | undefined;
  #watches = new Map<string, AbortController>();
  #acceptances = new Map<string, Promise<{ run_id?: string }>>();
  #refresh: Promise<void> | undefined;
  #removed = new Set<string>();
  #runOptions = new Map<string, StreamSubmitOptions<StateType> | undefined>();
  #activeRunId: string | undefined;
  #terminals = new Map<string, Terminal>();
  #localRuns = new Set<string>();

  constructor(
    options: StreamControllerOptions<StateType>,
    store: StreamStore<SubmissionQueueSnapshot<StateType>>,
    onError: (error: unknown) => void,
    onActivity: () => void = () => undefined
  ) {
    this.#options = options;
    this.#store = store;
    this.#onError = onError;
    this.#onActivity = onActivity;
  }

  get activeRunId(): string | undefined {
    return this.#activeRunId;
  }

  claimLocalRun(threadId: string, runId: string): void {
    this.#bind(threadId);
    this.#localRuns.add(runId);
    this.#watches.get(runId)?.abort();
    this.#watches.delete(runId);
    if (this.#activeRunId === runId) this.#activeRunId = undefined;
    this.#runOptions.delete(runId);
  }

  tracksRun(runId: string | undefined): boolean {
    return (
      runId != null && (this.#watches.has(runId) || this.#removed.has(runId))
    );
  }

  detach(): void {
    this.#abort.abort();
    for (const abort of this.#watches.values()) abort.abort();
    this.#watches.clear();
    this.#acceptances.clear();
    this.#removed.clear();
    this.#runOptions.clear();
    this.#activeRunId = undefined;
    this.#terminals.clear();
    this.#localRuns.clear();
    this.#refresh = undefined;
    this.#abort = new AbortController();
    this.#threadId = undefined;
    this.#store.setState(() => []);
  }

  #bind(threadId: string): AbortSignal {
    if (this.#threadId !== threadId) {
      this.detach();
      this.#threadId = threadId;
    }
    return this.#abort.signal;
  }

  async enqueue(
    threadId: string,
    input: unknown,
    options: StreamSubmitOptions<StateType> | undefined,
    dispatch: (
      params: Parameters<ThreadStream["submitRun"]>[0]
    ) => Promise<{ run_id?: string }>
  ): Promise<void> {
    const signal = this.#bind(threadId);
    const runs = queueRuns(this.#options);
    let id: string | undefined;
    try {
      if (!runs)
        throw new Error(
          "Server-backed enqueue requires an explicit serverQueue capability."
        );
      const values =
        input != null && typeof input === "object" && !Array.isArray(input)
          ? prepareOptimisticInput(
              input as Record<string, unknown>,
              this.#options.messagesKey ?? "messages",
              uuidv7
            ).dispatchInput
          : input;
      id = uuidv7();
      const entry: SubmissionQueueEntry<StateType> = {
        id,
        values: values as Partial<StateType> | null | undefined,
        options,
        createdAt: new Date(),
      };
      this.#store.setState((entries) => [...entries, entry]);
      const acceptance = dispatch({
        input: values ?? null,
        config: {
          ...options?.config,
          configurable: {
            ...options?.config?.configurable,
            thread_id: threadId,
          },
        },
        metadata: options?.metadata,
        multitaskStrategy: "enqueue",
        forkFrom: options?.forkFrom,
      });
      this.#acceptances.set(id, acceptance);
      const run = await acceptance;
      if (signal.aborted) return;
      const runId = run.run_id;
      if (!runId) throw new Error("Run acceptance did not include a run id");
      if (!this.#terminals.has(runId)) this.#runOptions.set(runId, options);
      this.#store.setState((entries) =>
        entries
          .filter((item) =>
            this.#removed.has(runId)
              ? item.id !== id && item.runId !== runId
              : item.id === id || item.runId !== runId
          )
          .map((item) =>
            item.id === id
              ? {
                  ...item,
                  runId,
                }
              : item
          )
      );
      notify(() => this.#options.onCreated?.({ runId }));
      const terminal = this.#terminals.get(runId);
      if (terminal?.event === "failed")
        notify(() => options?.onError?.(new Error(terminal.error)));
      this.#watch(runs, threadId, runId, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.#store.setState((entries) =>
        entries.filter((entry) => entry.id !== id)
      );
      this.#onError(error);
      notify(() => options?.onError?.(error));
      throw error;
    } finally {
      if (!signal.aborted && id != null) this.#acceptances.delete(id);
    }
  }

  refresh(threadId: string): Promise<void> {
    const signal = this.#bind(threadId);
    const runs = queueRuns(this.#options);
    if (!runs) return Promise.resolve();
    if (this.#refresh) return this.#refresh;
    const refresh = this.#hydrate(runs, threadId, signal)
      .catch((error) => {
        if (!signal.aborted) this.#onError(error);
      })
      .finally(() => {
        if (this.#refresh === refresh) this.#refresh = undefined;
      });
    this.#refresh = refresh;
    return refresh;
  }

  async #hydrate(
    runs: Runs,
    threadId: string,
    signal: AbortSignal
  ): Promise<void> {
    const running = await runs.list(threadId, {
      status: "running",
      limit: 100,
      signal,
    });
    if (signal.aborted) return;
    for (const run of running) {
      if (this.#removed.has(run.run_id) || this.#localRuns.has(run.run_id))
        continue;
      this.#activeRunId = run.run_id;
      this.#watch(runs, threadId, run.run_id, signal);
    }
    if (this.#activeRunId) this.#onActivity();
    const pending: Run[] = [];
    for (let offset = 0; !signal.aborted; offset += 100) {
      const page = await runs.list(threadId, {
        status: "pending",
        limit: 100,
        offset,
        signal,
        select: [
          "run_id",
          "thread_id",
          "assistant_id",
          "created_at",
          "status",
          "metadata",
          "kwargs",
          "multitask_strategy",
        ],
      });
      pending.push(...page);
      if (page.length < 100) break;
    }
    if (signal.aborted) return;
    this.#store.setState((entries) => {
      const known = new Set(entries.map((entry) => entry.runId));
      const restored = pending
        .filter(
          (run) =>
            !this.#localRuns.has(run.run_id) &&
            !known.has(run.run_id) &&
            !this.#removed.has(run.run_id) &&
            !this.#watches.has(run.run_id)
        )
        .map((run) => ({
          id: run.run_id,
          runId: run.run_id,
          values: run.kwargs?.input as Partial<StateType> | null | undefined,
          options: {
            metadata: run.metadata ?? undefined,
            config: run.kwargs?.config,
            multitaskStrategy: "enqueue" as const,
          },
          createdAt: new Date(run.created_at),
        }));
      return [...entries, ...restored].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      );
    });
    for (const run of pending) this.#watch(runs, threadId, run.run_id, signal);
    for (const entry of this.#store.getSnapshot()) {
      if (entry.runId) this.#watch(runs, threadId, entry.runId, signal);
    }
  }

  #watch(
    runs: Runs,
    threadId: string,
    runId: string,
    scope: AbortSignal
  ): void {
    if (
      this.#localRuns.has(runId) ||
      this.#watches.has(runId) ||
      this.#removed.has(runId) ||
      scope.aborted
    )
      return;
    const abort = new AbortController();
    this.#watches.set(runId, abort);
    if (!this.#runOptions.has(runId))
      this.#runOptions.set(
        runId,
        this.#store.getSnapshot().find((entry) => entry.runId === runId)
          ?.options
      );
    void (async () => {
      while (!abort.signal.aborted && !scope.aborted) {
        try {
          const run = await runs.get(threadId, runId, { signal: abort.signal });
          if (abort.signal.aborted || scope.aborted) return;
          if (run.status === "pending") {
            await delay(abort.signal);
            continue;
          }
          if (run.status === "running") {
            this.#activeRunId = runId;
            this.#onActivity();
          }
          this.#removed.add(runId);
          this.#store.setState((entries) =>
            entries.filter((entry) => entry.runId !== runId)
          );
          const terminal = await awaitRunTerminal(
            runs,
            threadId,
            runId,
            abort.signal
          );
          if (abort.signal.aborted || scope.aborted) return;
          this.#terminals.set(runId, terminal);
          if (terminal.event === "failed") {
            const error = new Error(terminal.error);
            this.#onError(error);
            notify(() => this.#runOptions.get(runId)?.onError?.(error));
          }
          notify(() =>
            this.#options.onCompleted?.({
              runId,
              reason:
                terminal.event === "completed"
                  ? "success"
                  : terminal.event === "interrupted"
                    ? "interrupt"
                    : "error",
            })
          );
          return;
        } catch (error) {
          if (abort.signal.aborted || scope.aborted) return;
          this.#onError(error);
          await delay(abort.signal);
        }
      }
    })().finally(() => {
      if (this.#watches.get(runId) === abort) {
        this.#watches.delete(runId);
        this.#runOptions.delete(runId);
        if (this.#activeRunId === runId) {
          void runs
            .list(threadId, { status: "running", limit: 100, signal: scope })
            .then((running) => {
              if (scope.aborted || this.#activeRunId !== runId) return;
              this.#activeRunId = running.find(
                (run) => run.run_id !== runId
              )?.run_id;
              this.#onActivity();
              for (const run of running)
                this.#watch(runs, threadId, run.run_id, scope);
            })
            .catch((error) => {
              if (!scope.aborted) this.#onError(error);
            });
        }
      }
    });
  }

  async cancelRunning(threadId: string): Promise<void> {
    const signal = this.#bind(threadId);
    const runs = queueRuns(this.#options);
    if (!runs) return;
    let running = await runs.list(threadId, {
      status: "running",
      limit: 100,
      signal,
    });
    if (!running.length && this.#acceptances.size) {
      await Promise.allSettled(this.#acceptances.values());
      if (signal.aborted) return;
      running = await runs.list(threadId, {
        status: "running",
        limit: 100,
        signal,
      });
    }
    if (signal.aborted) return;
    await Promise.all(running.map((run) => runs.cancel(threadId, run.run_id)));
  }

  async cancel(id: string): Promise<boolean> {
    const entry = this.#store.getSnapshot().find((item) => item.id === id);
    if (!entry || !this.#threadId) return false;
    const threadId = this.#threadId;
    const signal = this.#abort.signal;
    const runs = queueRuns(this.#options)!;
    const runId = entry.runId ?? (await this.#acceptances.get(id))?.run_id;
    if (!runId) return false;
    await runs.cancel(threadId, runId);
    if (!signal.aborted) this.#remove(new Set([runId]));
    return true;
  }

  async clear(): Promise<void> {
    const entries = this.#store.getSnapshot();
    if (!entries.length || !this.#threadId) return;
    const threadId = this.#threadId;
    const signal = this.#abort.signal;
    const runs = queueRuns(this.#options)!;
    const ids = await Promise.allSettled(
      entries.map(
        async (entry) =>
          entry.runId ?? (await this.#acceptances.get(entry.id))?.run_id
      )
    );
    const runIds = ids.flatMap((result) =>
      result.status === "fulfilled" && result.value != null
        ? [result.value]
        : []
    );
    if (!runIds.length) return;
    await runs.cancelMany({ threadId, runIds });
    if (!signal.aborted) this.#remove(new Set(runIds));
  }

  #remove(ids: Set<string>): void {
    this.#store.setState((entries) =>
      entries.filter((entry) => !entry.runId || !ids.has(entry.runId))
    );
    for (const id of ids) {
      this.#removed.add(id);
      this.#watches.get(id)?.abort();
      this.#watches.delete(id);
      this.#runOptions.delete(id);
      if (this.#activeRunId === id) this.#activeRunId = undefined;
    }
  }
}
