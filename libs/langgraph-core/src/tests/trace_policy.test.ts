import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import type { Run } from "@langchain/core/tracers/base";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  MessagesAnnotation,
  omitPayload,
  START,
  StateGraph,
  type TracePolicy,
} from "../web.js";
import { gatherIterator } from "../utils.js";
import { FakeTracer } from "./utils.js";

const State = Annotation.Root({ value: Annotation<number> });
const increment = (state: typeof State.State) => ({ value: state.value + 1 });

function nodeRuns(tracer: FakeTracer, name = "node"): Run[] {
  function flatten(runs: Run[]): Run[] {
    return runs.flatMap((run) => [run, ...flatten(run.child_runs)]);
  }
  return flatten(tracer.runs).filter((run) => run.name === name);
}

function makeGraph(tracePolicy?: TracePolicy) {
  return new StateGraph(State)
    .addNode("node", increment, { tracePolicy })
    .addEdge(START, "node")
    .addEdge("node", END)
    .compile();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("TracePolicy", () => {
  it.each([
    { policy: undefined, inputs: { value: 1 }, outputs: { value: 2 } },
    { policy: {}, inputs: { value: 1 }, outputs: { value: 2 } },
    {
      policy: { processInputs: omitPayload },
      inputs: {},
      outputs: { value: 2 },
    },
    {
      policy: { processOutputs: omitPayload },
      inputs: { value: 1 },
      outputs: {},
    },
    {
      policy: { processInputs: omitPayload, processOutputs: omitPayload },
      inputs: {},
      outputs: {},
    },
  ])(
    "records the configured payloads: $policy",
    async ({ policy, inputs, outputs }) => {
      const tracer = new FakeTracer();
      expect(
        await makeGraph(policy).invoke({ value: 1 }, { callbacks: [tracer] })
      ).toEqual({ value: 2 });
      const [run] = nodeRuns(tracer);
      expect(nodeRuns(tracer)).toHaveLength(1);
      expect(run.inputs).toEqual(inputs);
      expect(run.outputs).toEqual(outputs);
      expect(run.child_runs).toEqual([]);
      expect(tracer.runs[0].inputs).toEqual({ value: 1 });
      expect(tracer.runs[0].outputs).toEqual({ value: 2 });
      expect(run.end_time).toBeDefined();
    }
  );

  it("transforms raw values without changing execution or checkpoints", async () => {
    const processInputs = vi.fn(() => ({ summarizedInput: true }));
    const processOutputs = vi.fn(() => ({ summarizedOutput: true }));
    const result = new Command({ update: { value: 2 } });
    const action = vi.fn(async (state: typeof State.State) => {
      expect(state).toEqual({ value: 1 });
      return result;
    });
    const graph = new StateGraph(State)
      .addNode("node", action, {
        tracePolicy: { processInputs, processOutputs },
      })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile({ checkpointer: new MemorySaver() });
    const tracer = new FakeTracer();
    const config = {
      configurable: { thread_id: "trace-policy" },
      callbacks: [tracer],
    };
    expect(await graph.invoke({ value: 1 }, config)).toEqual({ value: 2 });
    expect((await graph.getState(config)).values).toEqual({ value: 2 });
    expect(processInputs).toHaveBeenCalledExactlyOnceWith({ value: 1 });
    expect(processOutputs).toHaveBeenCalledExactlyOnceWith(result);
    const [run] = nodeRuns(tracer);
    expect(run.inputs).toEqual({ summarizedInput: true });
    expect(run.outputs).toEqual({ summarizedOutput: true });
  });

  it.each(["processInputs", "processOutputs"] as const)(
    "falls back after %s errors, with and without callbacks",
    async (key) => {
      vi.stubEnv("LANGSMITH_TRACING", "false");
      vi.stubEnv("LANGCHAIN_TRACING_V2", "false");
      const failure = new Error("processor failed");
      const processor = vi.fn(() => {
        throw failure;
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const graph = makeGraph({ [key]: processor });
      const tracer = new FakeTracer();
      expect(await graph.invoke({ value: 1 }, { callbacks: [tracer] })).toEqual(
        { value: 2 }
      );
      expect(await graph.invoke({ value: 1 })).toEqual({ value: 2 });
      expect(processor).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("untransformed payload"),
        failure
      );
      expect(nodeRuns(tracer)[0].inputs).toEqual({ value: 1 });
      expect(nodeRuns(tracer)[0].outputs).toEqual({ value: 2 });
    }
  );

  it("preserves child spans, run hierarchy, tags, and metadata", async () => {
    const tracer = new FakeTracer();
    const child = RunnableLambda.from(increment).withConfig({
      runName: "child",
    });
    const graph = new StateGraph(State)
      .addNode("node", child, {
        tracePolicy: {
          processInputs: omitPayload,
          processOutputs: omitPayload,
        },
        metadata: { nodeMetadata: true },
      })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile();
    await graph.invoke(
      { value: 1 },
      { callbacks: [tracer], tags: ["user-tag"] }
    );
    const [run] = nodeRuns(tracer);
    const [childRun] = nodeRuns(tracer, "child");
    expect(run.inputs).toEqual({});
    expect(run.outputs).toEqual({});
    expect(run.parent_run_id).toBe(tracer.runs[0].id);
    expect(childRun.parent_run_id).toBe(run.id);
    expect(childRun.inputs).toEqual({ value: 1 });
    expect(childRun.outputs).toEqual({ value: 2 });
    expect(childRun.tags).toContain("user-tag");
    expect(childRun.tags?.some((tag) => tag.startsWith("seq:step:"))).toBe(
      false
    );
    expect(run.extra?.metadata).toMatchObject({ nodeMetadata: true });
  });

  it("preserves subgraph traces and other nodes' policies", async () => {
    const tracer = new FakeTracer();
    const graph = new StateGraph(State)
      .addNode("nested", makeGraph(), {
        tracePolicy: {
          processInputs: omitPayload,
          processOutputs: omitPayload,
        },
      })
      .addNode("plain", increment)
      .addEdge(START, "nested")
      .addEdge("nested", "plain")
      .addEdge("plain", END)
      .compile();
    expect(await graph.invoke({ value: 1 }, { callbacks: [tracer] })).toEqual({
      value: 3,
    });
    expect(nodeRuns(tracer, "nested")[0].inputs).toEqual({});
    expect(nodeRuns(tracer)[0].inputs).toEqual({ value: 1 });
    expect(nodeRuns(tracer, "plain")[0].inputs).toEqual({ value: 2 });
  });

  it("keeps policies with tuple registration, node input schemas, and defaults", async () => {
    const FullState = Annotation.Root({
      value: Annotation<number>,
      extra: Annotation<string>,
    });
    const tracer = new FakeTracer();
    const processInputs = vi.fn(omitPayload);
    const graph = new StateGraph(FullState)
      .addNode([
        ["node", increment, { input: State, tracePolicy: { processInputs } }],
      ])
      .setNodeDefaults({ retryPolicy: { maxAttempts: 1 } })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile();
    expect(
      await graph.invoke({ value: 1, extra: "keep" }, { callbacks: [tracer] })
    ).toEqual({ value: 2, extra: "keep" });
    expect(processInputs).toHaveBeenCalledExactlyOnceWith({ value: 1 });
    expect(nodeRuns(tracer)[0].inputs).toEqual({});
  });

  it("processes inputs on every retry and outputs only on success", async () => {
    const tracer = new FakeTracer();
    const processInputs = vi.fn(omitPayload);
    const processOutputs = vi.fn(omitPayload);
    const action = vi.fn(increment).mockImplementationOnce(() => {
      throw new Error("retry");
    });
    const graph = new StateGraph(State)
      .addNode("node", action, {
        tracePolicy: { processInputs, processOutputs },
        retryPolicy: {
          maxAttempts: 2,
          initialInterval: 1,
          jitter: false,
          logWarning: false,
        },
      })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile();
    expect(await graph.invoke({ value: 1 }, { callbacks: [tracer] })).toEqual({
      value: 2,
    });
    expect(action).toHaveBeenCalledTimes(2);
    expect(processInputs).toHaveBeenCalledTimes(2);
    expect(processOutputs).toHaveBeenCalledTimes(1);
    const runs = nodeRuns(tracer);
    expect(runs).toHaveLength(2);
    expect(runs[0].error).toContain("retry");
    expect(runs[1].outputs).toEqual({});
  });

  it("preserves update streams while transforming node trace events", async () => {
    const graph = makeGraph({
      processInputs: omitPayload,
      processOutputs: omitPayload,
    });
    const tracer = new FakeTracer();
    expect(
      await gatherIterator(
        graph.stream(
          { value: 1 },
          { callbacks: [tracer], streamMode: "updates" }
        )
      )
    ).toEqual([{ node: { value: 2 } }]);
    expect(nodeRuns(tracer)[0].inputs).toEqual({});
    expect(nodeRuns(tracer)[0].outputs).toEqual({});
    const events = await gatherIterator(
      graph.streamEvents({ value: 1 }, { version: "v2" })
    );
    expect(
      events.find(
        (event) => event.name === "node" && event.event === "on_chain_start"
      )?.data.input
    ).toEqual({});
    expect(
      events.find(
        (event) => event.name === "node" && event.event === "on_chain_end"
      )?.data.output
    ).toEqual({});
    expect(
      events.find(
        (event) => event.name === "LangGraph" && event.event === "on_chain_end"
      )?.data.output
    ).toEqual({ value: 2 });
  });

  it.each(["legacy", "protocol"] as const)(
    "omits directly returned messages from %s message streams",
    async (mode) => {
      async function collectMessages(tracePolicy?: TracePolicy) {
        const graph = new StateGraph(MessagesAnnotation)
          .addNode("node", () => ({ messages: [new AIMessage("hello")] }), {
            tracePolicy,
          })
          .addEdge(START, "node")
          .addEdge("node", END)
          .compile();
        if (mode === "legacy") {
          return gatherIterator(
            graph.stream({ messages: [] }, { streamMode: "messages" })
          );
        }
        const run = await graph.streamEvents(
          { messages: [] },
          { version: "v3" }
        );
        const events = await gatherIterator(run);
        expect((await run.output).messages[0].content).toBe("hello");
        return events.filter((event) => event.method === "messages");
      }
      const baseline = await collectMessages();
      expect(baseline.length).toBeGreaterThan(0);
      const omitted = await collectMessages({ processOutputs: omitPayload });
      expect(omitted).toEqual([]);
    }
  );

  it("matches Python input omission's effect on message deduplication", async () => {
    function graph(tracePolicy?: TracePolicy) {
      return new StateGraph(MessagesAnnotation)
        .addNode("node", (state) => ({ messages: state.messages }), {
          tracePolicy,
        })
        .addEdge(START, "node")
        .addEdge("node", END)
        .compile();
    }
    const input = {
      messages: [new HumanMessage({ content: "old", id: "old-id" })],
    };
    expect(
      await gatherIterator(graph().stream(input, { streamMode: "messages" }))
    ).toEqual([]);
    const replayed = await gatherIterator(
      graph({ processInputs: omitPayload }).stream(input, {
        streamMode: "messages",
      })
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0][0].content).toBe("old");
  });
});
