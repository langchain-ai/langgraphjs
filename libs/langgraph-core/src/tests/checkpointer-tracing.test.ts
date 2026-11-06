import { describe, expect, it, vi } from "vitest";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import {
  BaseCheckpointSaver,
  MemorySaver,
} from "@langchain/langgraph-checkpoint";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "../index.js";
import { DeltaChannel } from "../channels/delta.js";

type Operation = "getTuple" | "put" | "putWrites";
type Span = {
  name: string;
  runId: string;
  parentRunId?: string;
  inputs: unknown;
  serialized: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  outputs: unknown[];
  errors: unknown[];
};

class CallbackRecorder extends BaseCallbackHandler {
  name = "checkpoint-recorder";
  spans = new Map<string, Span>();

  constructor() {
    super({ _awaitHandler: true });
  }

  handleChainStart(
    ...args: Parameters<NonNullable<BaseCallbackHandler["handleChainStart"]>>
  ) {
    const [serialized, inputs, runId, parentRunId, tags, metadata, , name] =
      args;
    this.spans.set(runId, {
      name: name ?? "",
      runId,
      parentRunId,
      inputs,
      serialized,
      tags,
      metadata,
      outputs: [],
      errors: [],
    });
  }

  handleChainEnd(outputs: unknown, runId: string) {
    this.spans.get(runId)?.outputs.push(outputs);
  }

  handleChainError(error: unknown, runId: string) {
    this.spans.get(runId)?.errors.push(error);
  }

  operations() {
    return [...this.spans.values()].filter((span) =>
      span.name.startsWith("checkpoint.")
    );
  }
}

class RecordingSaver extends MemorySaver {
  calls: { operation: Operation; args: unknown[] }[] = [];

  override getTuple(...args: Parameters<MemorySaver["getTuple"]>) {
    this.calls.push({ operation: "getTuple", args });
    return super.getTuple(...args);
  }

  override put(...args: Parameters<MemorySaver["put"]>) {
    this.calls.push({ operation: "put", args });
    return super.put(...args);
  }

  override putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    this.calls.push({ operation: "putWrites", args });
    return super.putWrites(...args);
  }
}

const State = Annotation.Root({ value: Annotation<string>() });

function simpleGraph(saver: MemorySaver) {
  return new StateGraph(State)
    .addNode("update", () => ({ value: "write-sentinel" }))
    .addEdge(START, "update")
    .addEdge("update", END)
    .compile({ checkpointer: saver });
}

function expectCompletedOperations(
  saver: RecordingSaver,
  recorder: CallbackRecorder
) {
  const spans = recorder.operations();
  expect(spans.length).toBeGreaterThan(0);
  for (const operation of ["getTuple", "put", "putWrites"] as const) {
    expect(
      spans.filter((span) => span.name === `checkpoint.${operation}`)
    ).toHaveLength(
      saver.calls.filter((call) => call.operation === operation).length
    );
  }
  for (const span of spans) {
    expect(span.inputs).toEqual({});
    expect(span.outputs).toEqual([{}]);
    expect(span.errors).toEqual([]);
    expect(span.parentRunId).toBeDefined();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("runtime checkpoint operation tracing", () => {
  it.each(["async", "sync", "exit"] as const)(
    "traces each saver call once under %s durability without checkpoint payloads",
    async (durability) => {
      const saver = new RecordingSaver();
      const recorder = new CallbackRecorder();
      const graph = simpleGraph(saver);
      await expect(
        graph.invoke(
          { value: "state-sentinel" },
          {
            configurable: {
              thread_id: "thread-sentinel",
              private: "config-sentinel",
            },
            callbacks: [recorder],
            tags: ["context-tag"],
            metadata: { application: "context-metadata" },
            durability,
          }
        )
      ).resolves.toEqual({ value: "write-sentinel" });
      await awaitAllCallbacks();
      expectCompletedOperations(saver, recorder);
      const root = [...recorder.spans.values()].find(
        (span) => span.name === "LangGraph"
      );
      expect(root).toBeDefined();
      for (const span of recorder.operations()) {
        expect(span.parentRunId).toBe(root!.runId);
        expect(span.tags).toContain("context-tag");
        expect(span.metadata?.application).toBe("context-metadata");
        // Existing context is inherited, including configurable values already
        // promoted to metadata. No saver arguments are newly collected.
        const operationData = JSON.stringify({
          serialized: span.serialized,
          inputs: span.inputs,
          outputs: span.outputs,
          errors: span.errors,
        });
        for (const sentinel of [
          "state-sentinel",
          "write-sentinel",
          "thread-sentinel",
          "config-sentinel",
        ]) {
          expect(operationData).not.toContain(sentinel);
        }
        for (const call of saver.calls.filter(
          (call) => call.operation === "put"
        )) {
          const checkpointId = (call.args[1] as { id: string }).id;
          expect(JSON.stringify(span)).not.toContain(checkpointId);
        }
      }
    }
  );

  it("keeps shared saver spans under their own concurrent graph parents", async () => {
    const first = deferred();
    const second = deferred();
    const bothEntered = deferred();
    class GatedSaver extends RecordingSaver {
      entered = 0;
      override getTuple(...args: Parameters<MemorySaver["getTuple"]>) {
        const result = super.getTuple(...args);
        this.entered += 1;
        if (this.entered === 2) bothEntered.resolve();
        const gate =
          args[0].configurable?.thread_id === "first" ? first : second;
        return gate.promise.then(() => result);
      }
    }
    const saver = new GatedSaver();
    const methods = [saver.getTuple, saver.put, saver.putWrites];
    const recorder = new CallbackRecorder();
    const graph = simpleGraph(saver);
    const firstRun = graph.invoke(
      { value: "first" },
      {
        configurable: { thread_id: "first" },
        callbacks: [recorder],
        runName: "first-graph",
        tags: ["first-tag"],
        metadata: { owner: "first" },
      }
    );
    const secondRun = graph.invoke(
      { value: "second" },
      {
        configurable: { thread_id: "second" },
        callbacks: [recorder],
        runName: "second-graph",
        tags: ["second-tag"],
        metadata: { owner: "second" },
      }
    );
    await bothEntered.promise;
    const gets = recorder
      .operations()
      .filter((span) => span.name === "checkpoint.getTuple");
    try {
      expect(gets).toHaveLength(2);
      for (const owner of ["first", "second"]) {
        const graphSpan = [...recorder.spans.values()].find(
          (span) => span.name === `${owner}-graph`
        )!;
        const span = gets.find(
          (candidate) => candidate.parentRunId === graphSpan.runId
        )!;
        expect(span).toBeDefined();
        expect(span.outputs).toHaveLength(0);
        expect(span.tags).toContain(`${owner}-tag`);
        expect(span.tags).not.toContain(
          `${owner === "first" ? "second" : "first"}-tag`
        );
        expect(span.metadata?.owner).toBe(owner);
      }
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([firstRun, secondRun]);
    }
    await awaitAllCallbacks();
    expectCompletedOperations(saver, recorder);
    expect([saver.getTuple, saver.put, saver.putWrites]).toEqual(methods);
    for (const span of recorder.operations()) {
      const parent = recorder.spans.get(span.parentRunId!);
      expect(parent?.name).toBe(`${span.metadata?.owner}-graph`);
    }
  });

  it.each(["async", "sync", "exit"] as const)(
    "traces interrupt and resume saver calls under %s durability",
    async (durability) => {
      const saver = new RecordingSaver();
      const recorder = new CallbackRecorder();
      const graph = new StateGraph(State)
        .addNode("ask", () => ({
          value: interrupt("interrupt-payload-sentinel"),
        }))
        .addEdge(START, "ask")
        .compile({ checkpointer: saver });
      const config = {
        configurable: { thread_id: `resume-${durability}` },
        callbacks: [recorder],
        durability,
      };
      await graph.invoke({ value: "input-payload-sentinel" }, config);
      await expect(
        graph.invoke(new Command({ resume: "answer-payload-sentinel" }), config)
      ).resolves.toEqual({ value: "answer-payload-sentinel" });
      await awaitAllCallbacks();
      expectCompletedOperations(saver, recorder);
      for (const span of recorder.operations()) {
        expect(JSON.stringify(span)).not.toContain(
          "interrupt-payload-sentinel"
        );
        expect(JSON.stringify(span)).not.toContain("input-payload-sentinel");
        expect(JSON.stringify(span)).not.toContain("answer-payload-sentinel");
      }
    }
  );

  it("uses each nested graph's callback parent", async () => {
    const saver = new RecordingSaver();
    const recorder = new CallbackRecorder();
    const inner = new StateGraph(State)
      .addNode("inner-node", () => ({ value: "nested-write-sentinel" }))
      .addEdge(START, "inner-node")
      .compile({ name: "Inner" });
    const graph = new StateGraph(State)
      .addNode("inner", inner)
      .addEdge(START, "inner")
      .compile({ name: "Outer", checkpointer: saver });
    await graph.invoke(
      { value: "nested-input-sentinel" },
      {
        configurable: { thread_id: "nested" },
        callbacks: [recorder],
      }
    );
    await awaitAllCallbacks();
    expectCompletedOperations(saver, recorder);
    const parents = new Set(
      recorder
        .operations()
        .map((span) => recorder.spans.get(span.parentRunId!)?.name)
    );
    expect(parents).toEqual(new Set(["Outer", "Inner"]));
  });

  it("traces the exit stub, accumulated Delta writes, and final checkpoint", async () => {
    const saver = new RecordingSaver();
    const recorder = new CallbackRecorder();
    const DeltaState = Annotation.Root({
      log: new DeltaChannel<string[], string[]>((current, writes) =>
        current.concat(...writes)
      ),
    });
    const graph = new StateGraph(DeltaState)
      .addNode("append", () => ({ log: ["delta-write-sentinel"] }))
      .addEdge(START, "append")
      .compile({ checkpointer: saver });
    await expect(
      graph.invoke(
        { log: ["delta-input-sentinel"] },
        {
          configurable: { thread_id: "exit-stub" },
          callbacks: [recorder],
          durability: "exit",
        }
      )
    ).resolves.toEqual({
      log: ["delta-input-sentinel", "delta-write-sentinel"],
    });
    await awaitAllCallbacks();
    expectCompletedOperations(saver, recorder);
    expect(saver.calls.filter((call) => call.operation === "put")).toHaveLength(
      2
    );
    expect(
      saver.calls.filter((call) => call.operation === "putWrites").length
    ).toBeGreaterThan(0);
    for (const span of recorder.operations()) {
      expect(JSON.stringify(span)).not.toContain("delta-input-sentinel");
      expect(JSON.stringify(span)).not.toContain("delta-write-sentinel");
    }
  });

  it("traces both addressed checkpoint loading and the latest-checkpoint check", async () => {
    const saver = new RecordingSaver();
    const recorder = new CallbackRecorder();
    const graph = simpleGraph(saver);
    const config = {
      configurable: { thread_id: "addressed" },
      callbacks: [recorder],
    };
    await graph.invoke({ value: "input" }, config);
    const history = [];
    for await (const snapshot of graph.getStateHistory(config))
      history.push(snapshot);
    const beforeUpdate = history.find((snapshot) =>
      snapshot.next.includes("update")
    )!;
    expect(beforeUpdate).toBeDefined();
    await awaitAllCallbacks();
    saver.calls.length = 0;
    recorder.spans.clear();
    await expect(
      graph.invoke(null, { ...beforeUpdate.config, callbacks: [recorder] })
    ).resolves.toEqual({ value: "write-sentinel" });
    await awaitAllCallbacks();
    expectCompletedOperations(saver, recorder);
    expect(
      saver.calls.filter((call) => call.operation === "getTuple")
    ).toHaveLength(2);
  });

  it("traces subsequent visits to a stateful subgraph during parent replay", async () => {
    const saver = new RecordingSaver();
    const recorder = new CallbackRecorder();
    const ReplayState = Annotation.Root({ count: Annotation<number>() });
    const inner = new StateGraph(ReplayState)
      .addNode("increment", (state) => ({ count: state.count + 1 }))
      .addEdge(START, "increment")
      .compile({ name: "Counter", checkpointer: true });
    const graph = new StateGraph(ReplayState)
      .addNode("counter", inner)
      .addEdge(START, "counter")
      .addConditionalEdges("counter", (state) =>
        state.count < 3 ? "counter" : END
      )
      .compile({ name: "ReplayParent", checkpointer: saver });
    const config = {
      configurable: { thread_id: "replay-subgraph" },
      callbacks: [recorder],
    };
    await expect(graph.invoke({ count: 0 }, config)).resolves.toEqual({
      count: 3,
    });
    const history = [];
    for await (const snapshot of graph.getStateHistory(config))
      history.push(snapshot);
    const beforeCounter = history
      .filter((snapshot) => snapshot.next.includes("counter"))
      .at(-1)!;
    expect(beforeCounter).toBeDefined();
    await awaitAllCallbacks();
    saver.calls.length = 0;
    recorder.spans.clear();
    await expect(
      graph.invoke(null, { ...beforeCounter.config, callbacks: [recorder] })
    ).resolves.toEqual({ count: 3 });
    await awaitAllCallbacks();
    expectCompletedOperations(saver, recorder);
    // Two parent loads plus later subgraph visits; the first subgraph visit
    // uses list(before), which is deliberately outside this slice.
    expect(
      saver.calls.filter((call) => call.operation === "getTuple").length
    ).toBeGreaterThanOrEqual(4);
    expect(
      recorder
        .operations()
        .some(
          (span) =>
            span.name === "checkpoint.getTuple" &&
            recorder.spans.get(span.parentRunId!)?.name === "Counter"
        )
    ).toBe(true);
  });

  it("does not trace getTuple calls used by Delta history hydration", async () => {
    class HydratingSaver extends RecordingSaver {
      inHydration = false;
      hydrationReads = 0;
      override getTuple(...args: Parameters<MemorySaver["getTuple"]>) {
        if (this.inHydration) this.hydrationReads += 1;
        return super.getTuple(...args);
      }
      override async getDeltaChannelHistory(
        options: Parameters<BaseCheckpointSaver["getDeltaChannelHistory"]>[0]
      ) {
        this.inHydration = true;
        try {
          return await BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(
            this,
            options
          );
        } finally {
          this.inHydration = false;
        }
      }
    }
    const saver = new HydratingSaver();
    const recorder = new CallbackRecorder();
    const DeltaState = Annotation.Root({
      log: new DeltaChannel<string[], string[]>((current, writes) =>
        current.concat(...writes)
      ),
    });
    const graph = new StateGraph(DeltaState)
      .addNode("append", () => ({ log: ["hydrated-write-sentinel"] }))
      .addEdge(START, "append")
      .compile({ checkpointer: saver });
    const config = {
      configurable: { thread_id: "delta-hydration" },
      callbacks: [recorder],
    };
    await graph.invoke({ log: ["hydrated-input-sentinel"] }, config);
    await awaitAllCallbacks();
    saver.calls.length = 0;
    saver.hydrationReads = 0;
    recorder.spans.clear();
    await expect(graph.invoke(null, config)).resolves.toEqual({
      log: ["hydrated-input-sentinel", "hydrated-write-sentinel"],
    });
    await awaitAllCallbacks();
    expect(saver.hydrationReads).toBeGreaterThan(0);
    const runtimeReads =
      saver.calls.filter((call) => call.operation === "getTuple").length -
      saver.hydrationReads;
    expect(runtimeReads).toBe(1);
    expect(
      recorder
        .operations()
        .filter((span) => span.name === "checkpoint.getTuple")
    ).toHaveLength(runtimeReads);
    for (const span of recorder.operations()) {
      expect(JSON.stringify(span)).not.toContain("hydrated-input-sentinel");
      expect(JSON.stringify(span)).not.toContain("hydrated-write-sentinel");
    }
  });

  it.each(["getTuple", "put"] as const)(
    "sanitizes %s failures while preserving the saver rejection identity",
    async (operation) => {
      const failure = { secret: `${operation}-error-payload-sentinel` };
      const recorder = new CallbackRecorder();
      class FailingSaver extends RecordingSaver {
        override getTuple(...args: Parameters<MemorySaver["getTuple"]>) {
          if (operation === "getTuple") throw failure;
          return super.getTuple(...args);
        }
        override put(...args: Parameters<MemorySaver["put"]>) {
          if (operation === "put") return Promise.reject(failure);
          return super.put(...args);
        }
      }
      await expect(
        simpleGraph(new FailingSaver()).invoke(
          { value: "state-payload-sentinel" },
          {
            configurable: { thread_id: `failure-${operation}` },
            callbacks: [recorder],
          }
        )
      ).rejects.toBe(failure);
      await awaitAllCallbacks();
      const failed = recorder
        .operations()
        .filter((span) => span.name === `checkpoint.${operation}`);
      expect(failed).toHaveLength(1);
      expect(failed[0].outputs).toEqual([]);
      expect(failed[0].errors).toHaveLength(1);
      expect(failed[0].errors[0]).not.toBe(failure);
      expect(String(failed[0].errors[0])).toBe(
        "Error: Checkpoint operation failed"
      );
      expect(JSON.stringify(failed)).not.toContain(failure.secret);
    }
  );

  it("keeps the node failure ahead of pending saver and callback failures", async () => {
    const nodeEntered = deferred();
    const nodeExit = deferred();
    let rejectPut!: (error: unknown) => void;
    const put = new Promise<never>((_resolve, reject) => {
      rejectPut = reject;
    });
    const nodeFailure = new Error("node-error-payload-sentinel");
    const saverFailure = { private: "saver-error-payload-sentinel" };
    class FailingSaver extends RecordingSaver {
      override put(...args: Parameters<MemorySaver["put"]>) {
        this.calls.push({ operation: "put", args });
        return put;
      }
    }
    class FailingCallback extends CallbackRecorder {
      override async handleChainError(error: unknown, runId: string) {
        super.handleChainError(error, runId);
        if (this.spans.get(runId)?.name.startsWith("checkpoint.")) {
          throw new Error("callback-error-payload-sentinel");
        }
      }
    }
    const saver = new FailingSaver();
    const recorder = new FailingCallback();
    recorder.raiseError = true;
    const graph = new StateGraph(State)
      .addNode("fail", async () => {
        nodeEntered.resolve();
        await nodeExit.promise;
        throw nodeFailure;
      })
      .addEdge(START, "fail")
      .compile({ checkpointer: saver });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = graph.invoke(
        { value: "input-payload-sentinel" },
        {
          configurable: { thread_id: "error-priority" },
          callbacks: [recorder],
          durability: "async",
        }
      );
      const outcome = expect(result).rejects.toBe(nodeFailure);
      await nodeEntered.promise;
      rejectPut(saverFailure);
      nodeExit.resolve();
      await outcome;
      await awaitAllCallbacks();
      const failed = recorder
        .operations()
        .filter((span) => span.errors.length > 0);
      expect(failed).toHaveLength(1);
      expect(failed[0].outputs).toEqual([]);
      expect(String(failed[0].errors[0])).toBe(
        "Error: Checkpoint operation failed"
      );
      expect(failed[0].errors[0]).not.toBe(saverFailure);
      expect(JSON.stringify(failed)).not.toContain(
        "saver-error-payload-sentinel"
      );
      expect(JSON.stringify(failed)).not.toContain(
        "node-error-payload-sentinel"
      );
    } finally {
      nodeExit.resolve();
      logged.mockRestore();
    }
  });

  it("does not add runtime spans for getState or history reads", async () => {
    const saver = new RecordingSaver();
    const recorder = new CallbackRecorder();
    const graph = simpleGraph(saver);
    const config = {
      configurable: { thread_id: "inspection" },
      callbacks: [recorder],
    };
    await graph.invoke({ value: "input" }, config);
    await awaitAllCallbacks();
    const operations = recorder.operations().length;
    expect(operations).toBeGreaterThan(0);
    await graph.getState(config);
    for await (const _state of graph.getStateHistory(config)) {
      // Reading history is deliberately outside runtime checkpoint tracing.
    }
    await awaitAllCallbacks();
    expect(recorder.operations()).toHaveLength(operations);
  });

  it("leaves saver methods unchanged and runs without tracing callbacks", async () => {
    const saver = new RecordingSaver();
    const methods = [saver.getTuple, saver.put, saver.putWrites];
    await expect(
      simpleGraph(saver).invoke(
        { value: "disabled" },
        {
          configurable: { thread_id: "disabled" },
        }
      )
    ).resolves.toEqual({ value: "write-sentinel" });
    expect([saver.getTuple, saver.put, saver.putWrites]).toEqual(methods);
    expect(saver.calls.some((call) => call.operation === "getTuple")).toBe(
      true
    );
    expect(saver.calls.some((call) => call.operation === "put")).toBe(true);
    expect(saver.calls.some((call) => call.operation === "putWrites")).toBe(
      true
    );
  });
});
