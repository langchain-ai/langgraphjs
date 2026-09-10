import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client.js";
import type { Run } from "../schema.js";
import type { StreamControllerOptions } from "./types.js";
import type { SubmissionQueueSnapshot } from "./submit-coordinator.js";
import { StreamStore } from "./store.js";
import { ServerQueue, awaitRunTerminal } from "./server-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function run(id: string, status: Run["status"] = "pending"): Run {
  return { run_id: id, thread_id: "thread", assistant_id: "agent", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", status, metadata: {}, multitask_strategy: "enqueue" };
}

const queues: ServerQueue<Record<string, unknown>>[] = [];
function harness() {
  let nextId = 0;
  const records = new Map<string, Run>();
  const runs = {
    create: vi.fn(async () => { const result = run(`run-${++nextId}`); records.set(result.run_id, result); return result; }),
    list: vi.fn(async () => [] as Run[]),
    get: vi.fn(async (_thread: string, id: string) => records.get(id) ?? run(id)),
    join: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    cancelMany: vi.fn(async () => undefined),
  };
  const options = { client: { runs }, serverQueue: runs, assistantId: "agent", onCreated: vi.fn(), onCompleted: vi.fn() } as unknown as StreamControllerOptions;
  const store = new StreamStore<SubmissionQueueSnapshot>([]);
  store.setState(() => []);
  const onError = vi.fn();
  const queue = new ServerQueue(options, store, onError);
  queues.push(queue);
  const enqueue = (threadId: string, input: unknown, submitOptions?: Parameters<typeof queue.enqueue>[2]) => queue.enqueue(threadId, input, submitOptions, runs.create);
    return { queue, enqueue, runs, records, options, store, onError };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const queue of queues.splice(0)) queue.detach(); vi.useRealTimers(); });

describe("server submission queue", () => {
  it("sends immediately, retains the provisional key and mints stable message ids", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", { messages: [{ role: "user", content: "next" }] }, { metadata: { source: "chat" }, forkFrom: "checkpoint" });
    const provisional = h.store.getSnapshot()[0];
    expect(h.runs.create).toHaveBeenCalledWith(expect.objectContaining({ multitaskStrategy: "enqueue", forkFrom: "checkpoint", config: { configurable: { thread_id: "thread" } } }));
    expect(provisional.runId).toBeUndefined();
    const payload = (h.runs.create.mock.calls[0] as unknown as [{ input: unknown }])[0].input;
    expect(payload).toEqual(provisional.values);
    expect(payload).toMatchObject({ messages: [{ id: expect.any(String) }] });
    acceptance.resolve(run("accepted"));
    await submit;
    expect(h.store.getSnapshot()[0]).toMatchObject({ id: provisional.id, runId: "accepted", options: { metadata: { source: "chat" } } });
    expect(h.options.onCreated).toHaveBeenCalledExactlyOnceWith({ runId: "accepted" });
  });

  it("correlates completion to each run rather than another run's terminal", async () => {
    const h = harness();
    await h.enqueue("thread", {});
    await h.enqueue("thread", {});
    h.records.set("run-2", run("run-2", "success"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.options.onCompleted).toHaveBeenCalledExactlyOnceWith({ runId: "run-2", reason: "success" });
    expect(h.store.getSnapshot().map((entry) => entry.runId)).toEqual(["run-1"]);
    h.records.set("run-1", run("run-1", "interrupted"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.options.onCompleted).toHaveBeenLastCalledWith({ runId: "run-1", reason: "interrupt" });
  });

  it("joins running runs without cancel-on-disconnect and reports their failures", async () => {
    const h = harness();
    const onError = vi.fn();
    await h.enqueue("thread", {}, { onError });
    h.records.set("run-1", run("run-1", "running"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.store.getSnapshot()).toEqual([]);
    expect(h.runs.join).toHaveBeenCalledWith("thread", "run-1", expect.objectContaining({ cancelOnDisconnect: false }));
    h.records.set("run-1", run("run-1", "error"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Run run-1 error" }));
    expect(h.options.onCompleted).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", reason: "error" });
  });

  it("removes only a failed acceptance and rejects with its error", async () => {
    const h = harness();
    await h.enqueue("thread", {});
    const error = new Error("not authorized");
    const onError = vi.fn();
    h.runs.create.mockRejectedValueOnce(error);
    await expect(h.enqueue("thread", {}, { onError })).rejects.toBe(error);
    expect(h.store.getSnapshot()).toHaveLength(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.onError).toHaveBeenCalledWith(error);
  });

  it("cancels the accepted id even when requested before acceptance", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", {});
    const cancel = h.queue.cancel(h.store.getSnapshot()[0].id);
    expect(h.runs.cancel).not.toHaveBeenCalled();
    acceptance.resolve(run("accepted"));
    await submit;
    await expect(cancel).resolves.toBe(true);
    expect(h.runs.cancel).toHaveBeenCalledExactlyOnceWith("thread", "accepted");
    expect(h.store.getSnapshot()).toEqual([]);
  });

  it("keeps failed cancellation retryable and scopes bulk cancellation to a snapshot", async () => {
    const h = harness();
    await h.enqueue("thread", {});
    const id = h.store.getSnapshot()[0].id;
    h.runs.cancel.mockRejectedValueOnce(new Error("offline"));
    await expect(h.queue.cancel(id)).rejects.toThrow("offline");
    expect(h.store.getSnapshot()).toHaveLength(1);
    const cancellation = deferred<undefined>();
    h.runs.cancelMany.mockReturnValueOnce(cancellation.promise);
    const clear = h.queue.clear();
    await h.enqueue("thread", {});
    cancellation.resolve(undefined);
    await clear;
    expect(h.runs.cancelMany).toHaveBeenCalledExactlyOnceWith({ threadId: "thread", runIds: ["run-1"] });
    expect(h.store.getSnapshot().map((entry) => entry.runId)).toEqual(["run-2"]);
    expect(await h.queue.cancel("missing")).toBe(false);
  });

  it("hydrates all pending pages and optional stored input after reload", async () => {
    const h = harness();
    const firstPage = Array.from({ length: 100 }, (_, i) => run(`restored-${i}`));
    h.runs.list.mockResolvedValueOnce([]).mockResolvedValueOnce(firstPage).mockResolvedValueOnce([{ ...run("last"), kwargs: { input: { count: 2 } }, metadata: { source: "another-tab" } }]);
    await h.queue.refresh("thread");
    expect(h.runs.list).toHaveBeenNthCalledWith(3, "thread", expect.objectContaining({ offset: 100, limit: 100, status: "pending", select: expect.arrayContaining(["kwargs"]) }));
    expect(h.store.getSnapshot()).toHaveLength(101);
    expect(h.store.getSnapshot()[0].values).toBeUndefined();
    expect(h.store.getSnapshot().at(-1)).toMatchObject({ id: "last", runId: "last", values: { count: 2 }, options: { metadata: { source: "another-tab" } } });
    h.runs.list.mockResolvedValueOnce([]).mockResolvedValueOnce([run("last")]);
    await h.queue.refresh("thread");
    expect(h.store.getSnapshot()).toHaveLength(101);
  });

  it("clears accepted entries even if a simultaneous acceptance fails", async () => {
    const h = harness();
    await h.enqueue("thread", {});
    const acceptance = deferred<Run>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", {});
    const rejected = expect(submit).rejects.toThrow("rejected");
    const clear = h.queue.clear();
    acceptance.reject(new Error("rejected"));
    await rejected;
    await clear;
    expect(h.runs.cancelMany).toHaveBeenCalledWith({ threadId: "thread", runIds: ["run-1"] });
    expect(h.store.getSnapshot()).toEqual([]);
  });

  it("ignores old observer completion after a thread switch", async () => {
    const h = harness();
    const status = deferred<Run>();
    h.runs.get.mockReturnValueOnce(status.promise);
    await h.enqueue("thread", {});
    h.queue.detach();
    await h.enqueue("new-thread", {});
    status.resolve(run("run-1", "success"));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.options.onCompleted).not.toHaveBeenCalled();
    expect(h.store.getSnapshot()[0].runId).toBe("run-2");
  });

  it("preserves local callbacks and keys across hydration", async () => {
    const h = harness();
    const onError = vi.fn();
    await h.enqueue("thread", { count: 3 }, { onError });
    const entry = h.store.getSnapshot()[0];
    h.runs.list.mockResolvedValueOnce([]).mockResolvedValueOnce([run("run-1")]);
    await h.queue.refresh("thread");
    expect(h.store.getSnapshot()).toEqual([entry]);
  });

  it("does not restore cancelled runs from a stale list response", async () => {
    const h = harness();
    await h.enqueue("thread", {});
    const listing = deferred<Run[]>();
    h.runs.list.mockResolvedValueOnce([]).mockReturnValueOnce(listing.promise);
    const refresh = h.queue.refresh("thread");
    await h.queue.clear();
    listing.resolve([run("run-1")]);
    await refresh;
    expect(h.store.getSnapshot()).toEqual([]);
  });

  it("detaches in-flight acceptance and hydration without cancelling server runs", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    const listing = deferred<Run[]>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    h.runs.list.mockReturnValueOnce(listing.promise);
    const submit = h.enqueue("old-thread", {});
    const refresh = h.queue.refresh("old-thread");
    h.queue.detach();
    await h.queue.refresh("new-thread");
    acceptance.resolve(run("old"));
    listing.resolve([run("old")]);
    await Promise.all([submit, refresh]);
    expect(h.store.getSnapshot()).toEqual([]);
    expect(h.options.onCreated).not.toHaveBeenCalled();
    expect(h.runs.cancel).not.toHaveBeenCalled();
    expect(h.runs.cancelMany).not.toHaveBeenCalled();
  });

  it("retries a disconnected run observer without losing the queue", async () => {
    const h = harness();
    h.runs.get.mockRejectedValueOnce(new Error("offline"));
    await h.enqueue("thread", {});
    expect(h.store.getSnapshot()).toHaveLength(1);
    h.records.set("run-1", run("run-1", "success"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.options.onCompleted).toHaveBeenCalledWith({ runId: "run-1", reason: "success" });
  });

  it("never uses HTTP runs for custom adapters without a runs capability", async () => {
    const h = harness();
    h.options.serverQueue = undefined;
      h.options.transport = {} as never;
    await h.queue.refresh("thread");
    await expect(h.enqueue("thread", {})).rejects.toThrow("serverQueue");
    expect(h.runs.list).not.toHaveBeenCalled();
    expect(h.runs.create).not.toHaveBeenCalled();
    h.options.transport = { serverQueue: h.runs } as never;
    await h.enqueue("thread", {});
    expect(h.runs.create).toHaveBeenCalledTimes(1);
  });

  it("hydrates running A independently from pending B and completes each once", async () => {
    const h = harness();
    h.records.set("A", run("A", "running"));
    h.records.set("B", run("B"));
    h.runs.list.mockResolvedValueOnce([run("A", "running")]).mockResolvedValueOnce([run("B")]);
    await h.queue.refresh("thread");
    expect(h.queue.activeRunId).toBe("A");
    expect(h.queue.tracksRun("A")).toBe(true);
    expect(h.queue.tracksRun("B")).toBe(true);
    expect(h.store.getSnapshot().map((entry) => entry.runId)).toEqual(["B"]);
    h.records.set("A", run("A", "success"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.options.onCompleted).toHaveBeenCalledExactlyOnceWith({ runId: "A", reason: "success" });
    expect(h.queue.activeRunId).toBeUndefined();
    h.records.set("B", run("B", "success"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.options.onCompleted).toHaveBeenLastCalledWith({ runId: "B", reason: "success" });
    expect(h.options.onCompleted).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a provisional entry after hydration observed its terminal", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    const onError = vi.fn();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", {}, { onError });
    h.runs.list.mockResolvedValueOnce([]).mockResolvedValueOnce([run("accepted")]);
    h.records.set("accepted", run("accepted", "error"));
    await h.queue.refresh("thread");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.options.onCompleted).toHaveBeenCalledTimes(1);
    acceptance.resolve(run("accepted"));
    await submit;
    expect(h.store.getSnapshot()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.options.onCompleted).toHaveBeenCalledTimes(1);
    expect(h.options.onCreated).toHaveBeenCalledExactlyOnceWith({ runId: "accepted" });
  });

  it("stop resolves the server running run during acceptance and polling gaps, not pending B", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", {});
    h.runs.list.mockResolvedValueOnce([run("A", "running")]);
    await h.queue.cancelRunning("thread");
    expect(h.runs.cancel).toHaveBeenCalledExactlyOnceWith("thread", "A");
    acceptance.resolve(run("A"));
    await submit;
    await h.enqueue("thread", {});
    h.runs.list.mockResolvedValueOnce([run("A", "running")]);
    await h.queue.cancelRunning("thread");
    expect(h.runs.cancel).toHaveBeenLastCalledWith("thread", "A");
    expect(h.runs.cancelMany).not.toHaveBeenCalled();
  });

  it("stop waits for in-flight acceptance only when no run is currently running", async () => {
    const h = harness();
    const acceptance = deferred<Run>();
    h.runs.create.mockReturnValueOnce(acceptance.promise);
    const submit = h.enqueue("thread", {});
    h.runs.list.mockResolvedValueOnce([]).mockResolvedValueOnce([run("A", "running")]);
    const stop = h.queue.cancelRunning("thread");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runs.cancel).not.toHaveBeenCalled();
    acceptance.resolve(run("A"));
    await Promise.all([submit, stop]);
    expect(h.runs.cancel).toHaveBeenCalledExactlyOnceWith("thread", "A");
  });

  it("uses the configured client auth, hooks and fetch for queue observation/cancellation", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("/runs") ? [] : path.endsWith("/join") ? {} : path.endsWith("/cancel") ? null : run("A", "success");
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    const client = new Client<Record<string, unknown>>({ apiUrl: "https://queue.example", apiKey: "test-key", callerOptions: { fetch, maxRetries: 0 }, defaultHeaders: { "x-tenant": "tenant" }, onRequest: (_url, init) => { const headers = new Headers(init.headers); headers.set("x-hook", "hook"); return { ...init, headers }; } });
    const options = { client, assistantId: "agent", serverQueue: client.runs };
    const store = new StreamStore<SubmissionQueueSnapshot>([]);
    const queue = new ServerQueue(options, store, vi.fn());
    queues.push(queue);
    await queue.refresh("thread");
    await queue.enqueue("thread", {}, undefined, async () => ({ run_id: "A" }));
    await client.runs.join("thread", "A", { cancelOnDisconnect: false });
    await client.runs.cancel("thread", "A");
    await client.runs.cancelMany({ threadId: "thread", runIds: ["B"] });
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(String(url)).origin).toBe("https://queue.example");
      expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
      expect(new Headers(init.headers).get("x-tenant")).toBe("tenant");
      expect(new Headers(init.headers).get("x-hook")).toBe("hook");
    }
  });

  it("does not clear active B when A's terminal status arrives late", async () => {
    const h = harness();
    h.runs.list.mockResolvedValueOnce([run("A", "running")]).mockResolvedValueOnce([run("B")]);
    h.records.set("A", run("A", "running"));
    await h.queue.refresh("thread");
    h.runs.list.mockResolvedValueOnce([run("B", "running")]);
    h.records.set("A", run("A", "success"));
    h.records.set("B", run("B", "running"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.queue.activeRunId).toBe("B");
    expect(h.options.onCompleted).toHaveBeenCalledExactlyOnceWith({ runId: "A", reason: "success" });
  });

  it("does not settle a running run until its per-run status is terminal", async () => {
    const h = harness();
    const abort = new AbortController();
    h.records.set("active", run("active", "running"));
    const completion = vi.fn();
    const pending = awaitRunTerminal(h.runs, "thread", "active", abort.signal).then(completion);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completion).not.toHaveBeenCalled();
    h.records.set("active", run("active", "success"));
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(completion).toHaveBeenCalledExactlyOnceWith({ event: "completed" });
  });
});
