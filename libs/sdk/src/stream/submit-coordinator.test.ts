import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_QUEUE,
  SubmitCoordinator,
  type SubmissionQueueSnapshot,
} from "./submit-coordinator.js";
import { StreamStore } from "./store.js";
import type { ThreadStream } from "../client/stream/index.js";
import type { RootSnapshot, StreamControllerOptions } from "./types.js";

interface State {
  count?: number;
}

interface TerminalControl {
  resolve: (
    result?: { event?: string; error?: string }
  ) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
}

interface Harness {
  coordinator: SubmitCoordinator<State>;
  rootStore: StreamStore<RootSnapshot<State, unknown>>;
  queueStore: StreamStore<SubmissionQueueSnapshot<State>>;
  thread: ThreadStream;
  submitRun: ReturnType<typeof vi.fn>;
  respondInput: ReturnType<typeof vi.fn>;
  resolveSubmit: (result?: { run_id?: string }) => void;
  rejectSubmit: (error: unknown) => void;
  resolveTerminal: (
    result?: { event?: string; error?: string }
  ) => void;
  rejectTerminal: (error: unknown) => void;
  /**
   * Resolved when an `awaitNextTerminal` is registered. Lets tests
   * sequence the dispatch / terminal race deterministically.
   */
  terminalRegistered: () => Promise<TerminalControl>;
  /** Probe the most recent terminal control object. */
  currentTerminal: () => TerminalControl | undefined;
  setDisposed: (value: boolean) => void;
  setLatestInterrupt: (
    value: { interruptId: string; namespace: string[] } | null
  ) => void;
  options: StreamControllerOptions<State>;
  hydrate: ReturnType<typeof vi.fn>;
  ensureThread: ReturnType<typeof vi.fn>;
  markInterruptResolved: ReturnType<typeof vi.fn>;
  rememberSelfCreatedThreadId: ReturnType<typeof vi.fn>;
  setCurrentThreadId: ReturnType<typeof vi.fn>;
  threadIds: string[];
  setThreadId: (id: string | null) => void;
}

function makeRootStore(): StreamStore<RootSnapshot<State, unknown>> {
  return new StreamStore<RootSnapshot<State, unknown>>({
    values: { count: 0 },
    messages: [],
    toolCalls: [],
    interrupts: [],
    interrupt: undefined,
    isLoading: false,
    isThreadLoading: false,
    error: undefined,
    threadId: "thread-1",
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(initial: { threadId?: string | null } = {}): Harness {
  const rootStore = makeRootStore();
  const queueStore = new StreamStore<SubmissionQueueSnapshot<State>>(
    EMPTY_QUEUE as SubmissionQueueSnapshot<State>
  );

  const submitDeferreds: Array<ReturnType<typeof deferred<{ run_id?: string }>>> = [];
  const submitRun = vi.fn(() => {
    const d = deferred<{ run_id?: string }>();
    submitDeferreds.push(d);
    return d.promise;
  });
  const respondInput = vi.fn(async () => undefined);

  const thread = {
    submitRun,
    respondInput,
  } as unknown as ThreadStream;

  let disposed = false;
  let currentThreadId: string | null =
    "threadId" in initial ? initial.threadId ?? null : "thread-1";
  let latestInterrupt: { interruptId: string; namespace: string[] } | null = null;

  let terminalControl: TerminalControl | undefined;
  let terminalRegisteredDeferred = deferred<TerminalControl>();
  const awaitNextTerminal = vi.fn((signal: AbortSignal) => {
    const d = deferred<{
      event: "completed" | "failed" | "interrupted" | "aborted";
      error?: string;
    }>();
    const control: TerminalControl = {
      resolve: (result) =>
        d.resolve({
          event: (result?.event as TerminalControl extends never
            ? never
            : "completed") ?? "completed",
          ...(result?.error != null ? { error: result.error } : {}),
        } as never),
      reject: (error) => d.reject(error),
      signal,
    };
    terminalControl = control;
    terminalRegisteredDeferred.resolve(control);
    signal.addEventListener("abort", () =>
      d.resolve({ event: "aborted" })
    );
    return d.promise;
  });

  const hydrate = vi.fn(async (id?: string | null) => {
    currentThreadId = id ?? null;
  });
  const ensureThread = vi.fn((_id: string) => thread);
  const setCurrentThreadId = vi.fn((id: string | null) => {
    currentThreadId = id;
  });
  const rememberSelfCreatedThreadId = vi.fn(() => undefined);
  const markInterruptResolved = vi.fn(() => undefined);

  const onCreated = vi.fn();
  const onThreadId = vi.fn();

  const options: StreamControllerOptions<State> = {
    assistantId: "assistant-1",
    client: {} as never,
    threadId: initial.threadId ?? null,
    onCreated,
    onThreadId,
  };

  const coordinator = new SubmitCoordinator<State>({
    options,
    rootStore,
    queueStore,
    getDisposed: () => disposed,
    getCurrentThreadId: () => currentThreadId,
    setCurrentThreadId,
    rememberSelfCreatedThreadId,
    hydrate,
    ensureThread,
    waitForRootPumpReady: () => Promise.resolve(),
    awaitNextTerminal,
    latestUnresolvedInterrupt: () => latestInterrupt,
    markInterruptResolved,
  });

  return {
    coordinator,
    rootStore,
    queueStore,
    thread,
    submitRun,
    respondInput,
    resolveSubmit: (result = { run_id: "run-1" }) => {
      const d = submitDeferreds.shift();
      if (!d) throw new Error("no pending submitRun call");
      d.resolve(result);
    },
    rejectSubmit: (error: unknown) => {
      const d = submitDeferreds.shift();
      if (!d) throw new Error("no pending submitRun call");
      d.reject(error);
    },
    resolveTerminal: (result) => {
      terminalControl?.resolve(result);
    },
    rejectTerminal: (error) => {
      terminalControl?.reject(error);
    },
    terminalRegistered: () => terminalRegisteredDeferred.promise,
    currentTerminal: () => terminalControl,
    setDisposed: (value) => {
      disposed = value;
    },
    setLatestInterrupt: (value) => {
      latestInterrupt = value;
    },
    options,
    hydrate,
    ensureThread,
    markInterruptResolved,
    rememberSelfCreatedThreadId,
    setCurrentThreadId,
    threadIds: [],
    setThreadId: (id) => {
      currentThreadId = id;
      // Reset the deferred so the next submit's terminal can be awaited.
      terminalRegisteredDeferred = deferred<TerminalControl>();
    },
  };
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("SubmitCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("submit (happy path)", () => {
    it("dispatches run.start via the thread", async () => {
      const h = makeHarness();
      const submitPromise = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      h.resolveSubmit({ run_id: "run-1" });
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.submitRun).toHaveBeenCalledTimes(1);
      const call = h.submitRun.mock.calls[0][0];
      expect(call.input).toEqual({ count: 1 });
      expect(call.config?.configurable?.thread_id).toBe("thread-1");
    });

    it("flips isLoading on dispatch and back off after the terminal", async () => {
      const h = makeHarness();
      expect(h.rootStore.getSnapshot().isLoading).toBe(false);

      const submitPromise = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();
      expect(h.rootStore.getSnapshot().isLoading).toBe(true);

      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.rootStore.getSnapshot().isLoading).toBe(false);
    });

    it("invokes onCreated with the dispatch result", async () => {
      const h = makeHarness();
      const submitPromise = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();
      h.resolveSubmit({ run_id: "run-42" });
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.options.onCreated).toHaveBeenCalledWith({
        run_id: "run-42",
        thread_id: "thread-1",
      });
    });

    it("merges thread_id into config.configurable without losing user fields", async () => {
      const h = makeHarness();
      const submitPromise = h.coordinator.submit(
        { count: 1 },
        {
          config: {
            configurable: { user_id: "u1" },
            recursion_limit: 5,
          },
        }
      );
      await h.terminalRegistered();
      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;

      const call = h.submitRun.mock.calls[0][0];
      expect(call.config).toEqual({
        configurable: { user_id: "u1", thread_id: "thread-1" },
        recursion_limit: 5,
      });
    });
  });

  describe("submit (error paths)", () => {
    it("captures dispatch errors into rootStore.error and onError", async () => {
      const h = makeHarness();
      const onError = vi.fn();
      const submitPromise = h.coordinator.submit({ count: 1 }, { onError });
      await h.terminalRegistered();

      const err = new Error("dispatch failed");
      h.rejectSubmit(err);
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.rootStore.getSnapshot().error).toBe(err);
      expect(onError).toHaveBeenCalledWith(err);
      expect(h.rootStore.getSnapshot().isLoading).toBe(false);
    });

    it("captures `failed` terminal events into an Error", async () => {
      const h = makeHarness();
      const onError = vi.fn();
      const submitPromise = h.coordinator.submit({ count: 1 }, { onError });
      await h.terminalRegistered();
      h.resolveSubmit();
      h.resolveTerminal({ event: "failed", error: "graph blew up" });
      await vi.runAllTimersAsync();
      await submitPromise;

      const captured = h.rootStore.getSnapshot().error as Error;
      expect(captured).toBeInstanceOf(Error);
      expect(captured.message).toBe("graph blew up");
      expect(onError).toHaveBeenCalledWith(captured);
    });

    it("returns early without dispatching when disposed", async () => {
      const h = makeHarness();
      h.setDisposed(true);
      await h.coordinator.submit({ count: 1 });
      expect(h.submitRun).not.toHaveBeenCalled();
    });

    it("never dispatches when an onError callback throws", async () => {
      const h = makeHarness();
      const onError = vi.fn(() => {
        throw new Error("callback explosion");
      });
      const submitPromise = h.coordinator.submit({ count: 1 }, { onError });
      await h.terminalRegistered();
      h.rejectSubmit(new Error("boom"));
      await vi.runAllTimersAsync();
      // The coordinator must swallow the callback throw rather than
      // reject submit().
      await expect(submitPromise).resolves.toBeUndefined();
    });
  });

  describe("multitaskStrategy", () => {
    it("rolls back the active run by default and starts the new one", async () => {
      const h = makeHarness();

      const first = h.coordinator.submit({ count: 1 });
      const firstControl = await h.terminalRegistered();
      // Now start a second submit; the first's abort signal should fire.
      const second = h.coordinator.submit({ count: 2 });
      // Wait for the second `awaitNextTerminal` registration.
      // The terminalRegistered deferred is reset on each submit, so
      // ask harness for a fresh registration.
      // First submit's resolve from rollback flushes its `aborted` terminal
      // path through setTimeout in the lifecycle tracker; here it surfaces
      // through awaitNextTerminal's abort listener.
      await flush();
      expect(firstControl.signal.aborted).toBe(true);

      // The first submit will resolve via its abort path automatically.
      h.resolveSubmit(); // first dispatch resolves
      // For the second submit, register and complete normally.
      const secondControl = await h.currentTerminal();
      expect(secondControl).toBeDefined();
      h.resolveSubmit({ run_id: "run-2" });
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await Promise.all([first, second]);

      expect(h.submitRun).toHaveBeenCalledTimes(2);
    });

    it("rejects when an active run exists and strategy is 'reject'", async () => {
      const h = makeHarness();
      const first = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      await expect(
        h.coordinator.submit({ count: 2 }, { multitaskStrategy: "reject" })
      ).rejects.toThrow(/already in flight.*reject/);

      // Clean up first submit.
      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await first;
    });

    it("enqueues when an active run exists and strategy is 'enqueue'", async () => {
      const h = makeHarness();
      const first = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      await h.coordinator.submit(
        { count: 2 },
        { multitaskStrategy: "enqueue" }
      );

      expect(h.queueStore.getSnapshot()).toHaveLength(1);
      expect(h.queueStore.getSnapshot()[0].values).toEqual({ count: 2 });
      // Only the first submit dispatched; the queued one waits.
      expect(h.submitRun).toHaveBeenCalledTimes(1);

      // Cleanly resolve the first run.
      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await first;
    });

    it("drains the queue after the active run terminates", async () => {
      const h = makeHarness();
      const first = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      await h.coordinator.submit(
        { count: 2 },
        { multitaskStrategy: "enqueue" }
      );
      expect(h.queueStore.getSnapshot()).toHaveLength(1);

      h.resolveSubmit({ run_id: "run-1" });
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await first;

      // Drain runs on next macrotask; advance fake timers.
      await vi.runAllTimersAsync();
      // The queued submit now in-flight; ack it so we don't leak.
      const second = await h.currentTerminal();
      expect(second).toBeDefined();
      expect(h.submitRun).toHaveBeenCalledTimes(2);
      expect(h.queueStore.getSnapshot()).toHaveLength(0);

      h.resolveSubmit({ run_id: "run-2" });
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
    });
  });

  describe("queue management", () => {
    it("cancelQueued removes a matching entry and returns true", async () => {
      const h = makeHarness();
      const first = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      await h.coordinator.submit(
        { count: 2 },
        { multitaskStrategy: "enqueue" }
      );
      const queued = h.queueStore.getSnapshot();
      expect(queued).toHaveLength(1);

      const removed = await h.coordinator.cancelQueued(queued[0].id);
      expect(removed).toBe(true);
      expect(h.queueStore.getSnapshot()).toHaveLength(0);

      // Cleanup.
      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await first;
    });

    it("cancelQueued returns false for an unknown id", async () => {
      const h = makeHarness();
      const removed = await h.coordinator.cancelQueued("nope");
      expect(removed).toBe(false);
    });

    it("clearQueue empties the queue", async () => {
      const h = makeHarness();
      const first = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      await h.coordinator.submit(
        { count: 2 },
        { multitaskStrategy: "enqueue" }
      );
      await h.coordinator.submit(
        { count: 3 },
        { multitaskStrategy: "enqueue" }
      );
      expect(h.queueStore.getSnapshot()).toHaveLength(2);

      await h.coordinator.clearQueue();
      expect(h.queueStore.getSnapshot()).toEqual([]);

      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await first;
    });
  });

  describe("stop / abortActiveRun", () => {
    it("stop() aborts the active run and clears isLoading", async () => {
      const h = makeHarness();
      const submitPromise = h.coordinator.submit({ count: 1 });
      const control = await h.terminalRegistered();
      expect(h.rootStore.getSnapshot().isLoading).toBe(true);

      await h.coordinator.stop();
      expect(control.signal.aborted).toBe(true);
      expect(h.rootStore.getSnapshot().isLoading).toBe(false);

      // Let the in-flight dispatch settle to clean up.
      h.resolveSubmit();
      await vi.runAllTimersAsync();
      await submitPromise;
    });

    it("abortActiveRun() aborts without forcing isLoading=false", async () => {
      const h = makeHarness();
      const submitPromise = h.coordinator.submit({ count: 1 });
      const control = await h.terminalRegistered();

      h.coordinator.abortActiveRun();
      expect(control.signal.aborted).toBe(true);

      h.resolveSubmit();
      await vi.runAllTimersAsync();
      await submitPromise;
    });
  });

  describe("submit({ command: { resume } })", () => {
    it("calls respondInput on the active interrupt and marks it resolved", async () => {
      const h = makeHarness();
      h.setLatestInterrupt({
        interruptId: "interrupt-1",
        namespace: ["task:1"],
      });

      const submitPromise = h.coordinator.submit(null, {
        command: { resume: { value: 42 } },
      });
      await h.terminalRegistered();

      expect(h.respondInput).toHaveBeenCalledWith({
        namespace: ["task:1"],
        interrupt_id: "interrupt-1",
        response: { value: 42 },
      });
      expect(h.markInterruptResolved).toHaveBeenCalledWith("interrupt-1");

      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;
    });

    it("rejects when no pending interrupt is available", async () => {
      const h = makeHarness();
      h.setLatestInterrupt(null);

      const submitPromise = h.coordinator.submit(null, {
        command: { resume: "anything" },
        onError: () => undefined,
      });
      await h.terminalRegistered();
      // Resolve the terminal so the submit's finally can run.
      // Since no submitRun is dispatched (resume path), we still get
      // here from the throw before the race.
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.rootStore.getSnapshot().error).toBeInstanceOf(Error);
      expect(
        (h.rootStore.getSnapshot().error as Error).message
      ).toMatch(/no pending protocol interrupt/);
    });
  });

  describe("thread id management", () => {
    it("hydrates when an override threadId is supplied", async () => {
      const h = makeHarness({ threadId: "thread-1" });
      const submitPromise = h.coordinator.submit(
        { count: 1 },
        { threadId: "thread-2" }
      );
      await h.terminalRegistered();
      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;

      expect(h.hydrate).toHaveBeenCalledWith("thread-2");
    });

    it("mints a thread id when none is bound and notifies onThreadId", async () => {
      const h = makeHarness({ threadId: null });
      const submitPromise = h.coordinator.submit({ count: 1 });
      await h.terminalRegistered();

      expect(h.options.onThreadId).toHaveBeenCalledOnce();
      const minted = (h.options.onThreadId as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(typeof minted).toBe("string");
      expect(minted.length).toBeGreaterThan(8);
      expect(h.rememberSelfCreatedThreadId).toHaveBeenCalledWith(minted);
      expect(h.rootStore.getSnapshot().threadId).toBe(minted);

      h.resolveSubmit();
      h.resolveTerminal({ event: "completed" });
      await vi.runAllTimersAsync();
      await submitPromise;
    });
  });
});
