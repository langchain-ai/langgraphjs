import { describe, expect, it, vi } from "vitest";
import type { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  MemorySaver,
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { PregelLoop } from "../pregel/loop.js";
import { IterableReadableWritableStream } from "../pregel/stream.js";
import { DeltaChannel } from "../channels/delta.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let already-settled callback promises finish without waiting on a clock.
async function drainCallbacks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

type Span = { name: string; terminal: string[]; errors: unknown[] };

function recorder(
  options: {
    start?: () => Promise<void> | void;
    end?: () => Promise<void> | void;
    error?: () => Promise<void> | void;
  } = {}
) {
  const spans: Span[] = [];
  const child = {
    handleChainStart: vi.fn((...args: unknown[]) => {
      const span: Span = { name: args[6] as string, terminal: [], errors: [] };
      spans.push(span);
      const run = {
        handleChainEnd: vi.fn(() => {
          span.terminal.push("end");
          return options.end?.();
        }),
        handleChainError: vi.fn((error: unknown) => {
          span.terminal.push("error");
          span.errors.push(error);
          return options.error?.();
        }),
      };
      const started = options.start?.();
      return Promise.resolve(started).then(() => run);
    }),
  };
  const manager = {
    handlers: [{}],
    getChild: vi.fn(() => child),
  } as unknown as CallbackManagerForChainRun;
  return { spans, manager, child };
}

class RecordingSaver extends MemorySaver {
  calls: string[] = [];
  onPut?: (
    config: RunnableConfig,
    checkpoint: Checkpoint
  ) => Promise<RunnableConfig>;
  onWrites?: () => Promise<void>;

  override put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    this.calls.push(`put:${checkpoint.id}`);
    return (
      this.onPut?.(config, checkpoint) ??
      super.put(config, checkpoint, metadata)
    );
  }

  override putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string
  ): Promise<void> {
    this.calls.push(`writes:${taskId}`);
    return (
      this.onWrites?.() ?? super.putWrites(config, writes, taskId, taskPath)
    );
  }
}

class TestLoop extends PregelLoop {
  constructor(saver: RecordingSaver, manager?: CallbackManagerForChainRun) {
    const checkpoint = emptyCheckpoint();
    const config = { configurable: { thread_id: "ordering-thread" } };
    super({
      config,
      checkpointer: saver,
      checkpoint,
      checkpointMetadata: { source: "loop", step: 0, parents: {} },
      checkpointPreviousVersions: {},
      checkpointPendingWrites: [],
      checkpointConfig: config,
      channels: {},
      step: 0,
      stop: 25,
      outputKeys: [],
      streamKeys: [],
      nodes: {},
      checkpointNamespace: [],
      addressed: false,
      isNested: false,
      resumeAtHead: false,
      addressedCheckpointSuperseded: false,
      manager,
      stream: new IterableReadableWritableStream({ modes: new Set() }),
      prevCheckpointConfig: undefined,
      interruptAfter: [],
      interruptBefore: [],
      durability: "async",
      debug: false,
      triggerToNodes: {},
    });
  }

  save(id: string) {
    this._checkpointerPutAfterPrevious({
      config: this.config,
      checkpoint: { ...emptyCheckpoint(), id },
      metadata: { source: "loop", step: 0, parents: {} },
      newVersions: {},
    });
  }

  pendingDelta(promise: Promise<unknown>) {
    this._pendingDeltaWrites.push(promise);
  }

  deltaPromises() {
    return this._pendingDeltaWrites;
  }

  waitPersistence() {
    return this._awaitCheckpointerPromises();
  }

  flush() {
    return this._flushPendingWrites();
  }

  exitWrites() {
    return this._putExitDeltaWrites();
  }

  stageExitWrites() {
    this.durability = "exit";
    this.channels = {
      value: new DeltaChannel<string[], string>((state, values) => [
        ...state,
        ...values,
      ]),
    };
    this._exitFirstStep = 0;
    this._exitDeltaWrites = [
      [0, "00000000-0000-4000-8000-000000000001", "~first", "value", "first"],
      [0, "00000000-0000-4000-8000-000000000002", "~second", "value", "second"],
    ];
    this._hasPersistedParent = true;
    this._loadedLatest = true;
    this._initialCheckpointConfig = this.config;
  }
}

describe("checkpoint I/O tracing ordering", () => {
  it("starts put only after its previous checkpoint and Delta writes succeed", async () => {
    const saver = new RecordingSaver();
    const trace = recorder();
    const first = deferred<RunnableConfig>();
    const second = deferred<RunnableConfig>();
    const entered = deferred();
    const delta = deferred();
    saver.onPut = (_config, checkpoint) => {
      if (checkpoint.id === "first") {
        entered.resolve();
        return first.promise;
      }
      return second.promise;
    };
    const loop = new TestLoop(saver, trace.manager);
    loop.save("first");
    await entered.promise;
    loop.pendingDelta(delta.promise);
    loop.save("second");
    await drainCallbacks();
    expect(saver.calls).toEqual(["put:first"]);
    expect(trace.spans.map(({ name }) => name)).toEqual(["checkpoint.put"]);
    expect(trace.spans[0].terminal).toEqual([]);

    first.resolve(loop.config);
    await drainCallbacks();
    expect(trace.spans[0].terminal).toEqual(["end"]);
    expect(trace.spans).toHaveLength(1);
    expect(saver.calls).toEqual(["put:first"]);

    delta.resolve();
    await drainCallbacks();
    expect(saver.calls).toEqual(["put:first", "put:second"]);
    expect(trace.spans.map(({ terminal }) => terminal)).toEqual([["end"], []]);
    second.resolve(loop.config);
    await loop.waitPersistence();
    await drainCallbacks();
    expect(trace.spans.map(({ terminal }) => terminal)).toEqual([
      ["end"],
      ["end"],
    ]);
  });

  it.each(["previous checkpoint", "pending Delta write"])(
    "skips queued puts after a failed %s",
    async (failed) => {
      const saver = new RecordingSaver();
      const trace = recorder();
      const failure = { sentinel: `failure:${failed}` };
      const gate = deferred<RunnableConfig>();
      const entered = deferred();
      saver.onPut = () => {
        entered.resolve();
        return gate.promise;
      };
      const loop = new TestLoop(saver, trace.manager);
      if (failed === "previous checkpoint") {
        loop.save("first");
        await entered.promise;
        loop.save("skipped");
        gate.reject(failure);
      } else {
        const delta = deferred();
        loop.pendingDelta(delta.promise);
        loop.save("skipped");
        delta.reject(failure);
      }
      await expect(loop.waitPersistence()).rejects.toBe(failure);
      await drainCallbacks();
      expect(saver.calls).toEqual(
        failed === "previous checkpoint" ? ["put:first"] : []
      );
      expect(trace.spans).toHaveLength(
        failed === "previous checkpoint" ? 1 : 0
      );
      if (trace.spans.length) {
        expect(trace.spans[0].terminal).toEqual(["error"]);
        expect(String(trace.spans[0].errors[0])).not.toContain(
          failure.sentinel
        );
      }
    }
  );

  it.each(["normal", "flush", "exit"])(
    "initiates concurrent %s writes synchronously while callback start is pending",
    async (path) => {
      const saver = new RecordingSaver();
      const callback = deferred();
      const io = deferred();
      const trace = recorder({ start: () => callback.promise });
      saver.onWrites = () => io.promise;
      const loop = new TestLoop(saver, trace.manager);
      if (path === "normal") {
        loop.putWrites("first", [["value", "first"]]);
        loop.putWrites("second", [["value", "second"]]);
      } else if (path === "flush") {
        loop.putWrites("first", [["value", "first"]]);
        loop.putWrites("second", [["value", "second"]]);
        saver.calls = [];
        trace.spans.length = 0;
        loop.flush();
      } else {
        loop.stageExitWrites();
        await loop.exitWrites();
      }
      expect(saver.calls).toHaveLength(2);
      expect(saver.calls.every((call) => call.startsWith("writes:"))).toBe(
        true
      );
      expect(trace.spans.map(({ name }) => name)).toEqual([
        "checkpoint.putWrites",
        "checkpoint.putWrites",
      ]);
      io.resolve();
      await loop.waitPersistence();
      expect(trace.spans.map(({ terminal }) => terminal)).toEqual([[], []]);
      callback.resolve();
      await drainCallbacks();
      expect(trace.spans.map(({ terminal }) => terminal)).toEqual([
        ["end"],
        ["end"],
      ]);
    }
  );

  it("does not trace or persist an empty task write", async () => {
    const saver = new RecordingSaver();
    const trace = recorder();
    const loop = new TestLoop(saver, trace.manager);
    loop.putWrites("empty", []);
    await loop.waitPersistence();
    expect(saver.calls).toEqual([]);
    expect(trace.spans).toEqual([]);
  });
});

describe("checkpoint tracing callback isolation", () => {
  it.each(["sync throw", "rejection"])(
    "preserves a synchronous saver throw when callback error has a %s",
    async (callbackFailure) => {
      const failure = { sentinel: "sync-saver-error-private" };
      const trace = recorder({
        error: () => {
          if (callbackFailure === "sync throw")
            throw new Error("callback error");
          return Promise.reject("callback rejection");
        },
      });
      const saver = new RecordingSaver();
      saver.onWrites = () => {
        throw failure;
      };
      const loop = new TestLoop(saver, trace.manager);
      let thrown: unknown;
      try {
        loop.putWrites("first", [["value", "write-private"]]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(saver.calls).toEqual(["writes:first"]);
      expect(loop.checkpointerPromises.size).toBe(0);
      await drainCallbacks();
      expect(trace.spans).toHaveLength(1);
      expect(trace.spans[0].terminal).toEqual(["error"]);
      expect(String(trace.spans[0].errors[0])).toBe(
        "Error: Checkpoint operation failed"
      );
      expect(trace.spans[0].errors[0]).not.toBe(failure);
    }
  );

  it.each(["sync throw", "rejection"])(
    "keeps a saver rejection and handles callback error %s",
    async (callbackFailure) => {
      const failure = { sentinel: "rejected-saver-error-private" };
      const trace = recorder({
        error: () => {
          if (callbackFailure === "sync throw")
            throw new Error("callback error");
          return Promise.reject("callback rejection");
        },
      });
      const saver = new RecordingSaver();
      const io = deferred();
      saver.onWrites = () => io.promise;
      const loop = new TestLoop(saver, trace.manager);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        loop.putWrites("first", [["value", "private-write"]]);
        io.reject(failure);
        await expect(loop.waitPersistence()).rejects.toBe(failure);
        await drainCallbacks();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(trace.spans).toHaveLength(1);
        expect(trace.spans[0].terminal).toEqual(["error"]);
        expect(String(trace.spans[0].errors[0])).toBe(
          "Error: Checkpoint operation failed"
        );
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    }
  );

  it.each(["sync throw", "rejection"])(
    "does not report a second terminal event after callback end %s",
    async (callbackFailure) => {
      const trace = recorder({
        end: () => {
          if (callbackFailure === "sync throw") throw new Error("callback end");
          return Promise.reject("callback end rejection");
        },
      });
      const saver = new RecordingSaver();
      saver.onWrites = () => Promise.resolve();
      const loop = new TestLoop(saver, trace.manager);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        loop.putWrites("first", [["value", "write"]]);
        await expect(loop.waitPersistence()).resolves.toBeUndefined();
        await drainCallbacks();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(trace.spans).toHaveLength(1);
        expect(trace.spans[0].terminal).toEqual(["end"]);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    }
  );

  it.each(["sync throw", "rejection"])(
    "does not let callback start %s affect persistence or saver error identity",
    async (callbackFailure) => {
      const trace = recorder({
        start: () => {
          if (callbackFailure === "sync throw")
            throw new Error("callback start");
          return Promise.reject("callback start rejection");
        },
      });
      const saver = new RecordingSaver();
      const loop = new TestLoop(saver, trace.manager);
      saver.onWrites = () => Promise.resolve();
      loop.putWrites("success", [["value", "first"]]);
      await expect(loop.waitPersistence()).resolves.toBeUndefined();
      const failure = "non-Error saver rejection";
      saver.onWrites = () => Promise.reject(failure);
      loop.putWrites("failure", [["value", "second"]]);
      await expect(loop.waitPersistence()).rejects.toBe(failure);
      await drainCallbacks();
      expect(saver.calls).toEqual(["writes:success", "writes:failure"]);
      expect(trace.spans).toHaveLength(2);
      expect(trace.spans.map(({ terminal }) => terminal)).toEqual([[], []]);
    }
  );

  it("uses the saver fast path when no tracing callbacks exist", async () => {
    const saver = new RecordingSaver();
    const getChild = vi.fn(() => {
      throw new Error("empty callback manager must not be consulted");
    });
    const manager = {
      handlers: [],
      getChild,
    } as unknown as CallbackManagerForChainRun;
    const loop = new TestLoop(saver, manager);
    saver.onWrites = () => Promise.resolve();
    loop.putWrites("first", [["value", "write"]]);
    loop.save("checkpoint");
    await loop.waitPersistence();
    expect(saver.calls).toEqual(["writes:first", "put:checkpoint"]);
    expect(getChild).not.toHaveBeenCalled();
  });
});

it("keeps the original saver promise as the Delta write dependency", async () => {
  const saver = new RecordingSaver();
  const callback = deferred();
  const io = deferred();
  const trace = recorder({ start: () => callback.promise });
  const loop = new TestLoop(saver, trace.manager);
  loop.channels = {
    value: new DeltaChannel<string[], string>((state, values) => [
      ...state,
      ...values,
    ]),
  };
  saver.onWrites = () => io.promise;
  loop.putWrites("task", [["value", "write"]]);
  expect(loop.deltaPromises()).toEqual([io.promise]);
  expect(loop.deltaPromises()[0]).toBe(io.promise);
  io.resolve();
  await loop.waitPersistence();
  callback.resolve();
  await drainCallbacks();
  expect(trace.spans[0].terminal).toEqual(["end"]);
});

it("keeps a synchronous put failure in the checkpoint chain and skips its successor", async () => {
  const saver = new RecordingSaver();
  const trace = recorder({
    error: () => Promise.reject(new Error("callback failure")),
  });
  const failure = new Error("put-error-payload-sentinel");
  saver.onPut = () => {
    throw failure;
  };
  const loop = new TestLoop(saver, trace.manager);
  loop.save("first");
  loop.save("skipped");
  await expect(loop.waitPersistence()).rejects.toBe(failure);
  await drainCallbacks();
  expect(saver.calls).toEqual(["put:first"]);
  expect(trace.spans).toHaveLength(1);
  expect(trace.spans[0].terminal).toEqual(["error"]);
  expect(String(trace.spans[0].errors[0])).toBe(
    "Error: Checkpoint operation failed"
  );
});
