import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import {
  Annotation,
  END,
  MemorySaver,
  MessagesAnnotation,
  omitPayload,
  START,
  StateGraph,
  type TracePolicy,
} from "../web.js";
import { gatherIterator } from "../utils.js";

const State = Annotation.Root({ value: Annotation<number> });
const increment = (state: typeof State.State) => ({ value: state.value + 1 });

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type SentRun = Record<string, any>;

/** A LangChainTracer whose client records what would be sent to LangSmith. */
function mockTracer() {
  const client = { createRun: vi.fn(), updateRun: vi.fn() };
  const tracer = new LangChainTracer({
    client: client as unknown as LangChainTracer["client"],
  });
  const created = (name: string): SentRun[] =>
    client.createRun.mock.calls
      .map(([run]) => run)
      .filter((run) => run.name === name);
  const ended = (run: SentRun): SentRun =>
    client.updateRun.mock.calls.filter(([id]) => id === run.id).at(-1)?.[1];
  return { tracer, created, ended };
}

function makeGraph(tracePolicy?: TracePolicy) {
  return new StateGraph(State)
    .addNode("node", increment, { tracePolicy })
    .addEdge(START, "node")
    .addEdge("node", END)
    .compile();
}

describe("TracePolicy", () => {
  it.each([
    { policy: undefined, inputs: { value: 1 }, outputs: { value: 2 } },
    {
      policy: { processInputs: omitPayload },
      inputs: {},
      outputs: { value: 2 },
    },
    {
      policy: { processInputs: omitPayload, processOutputs: omitPayload },
      inputs: {},
      outputs: {},
    },
  ])(
    "sends the configured payloads: $policy",
    async ({ policy, inputs, outputs }) => {
      const { tracer, created, ended } = mockTracer();
      expect(
        await makeGraph(policy).invoke({ value: 1 }, { callbacks: [tracer] })
      ).toEqual({ value: 2 });
      const [run] = created("node");
      expect(run.inputs).toEqual(inputs);
      expect(ended(run).outputs).toEqual(outputs);
      const [root] = created("LangGraph");
      expect(root.inputs).toEqual({ value: 1 });
      expect(ended(root).outputs).toEqual({ value: 2 });
    }
  );

  it("doesn't change execution, checkpoints, or child runs", async () => {
    const { tracer, created } = mockTracer();
    const processInputs = vi.fn(omitPayload);
    const child = RunnableLambda.from(increment).withConfig({
      runName: "child",
    });
    const graph = new StateGraph(State)
      .addNode("node", child, { tracePolicy: { processInputs } })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "1" }, callbacks: [tracer] };

    expect(await graph.invoke({ value: 1 }, config)).toEqual({ value: 2 });
    expect((await graph.getState(config)).values).toEqual({ value: 2 });
    expect(processInputs).toHaveBeenCalledWith({ value: 1 });
    expect(created("node")[0].inputs).toEqual({});
    expect(created("child")[0].inputs).toEqual({ value: 1 });
  });

  it("only trims the node it's set on", async () => {
    const { tracer, created } = mockTracer();
    const graph = new StateGraph(State)
      .addNode("nested", makeGraph(), {
        tracePolicy: { processInputs: omitPayload },
      })
      .addNode("plain", increment)
      .addEdge(START, "nested")
      .addEdge("nested", "plain")
      .addEdge("plain", END)
      .compile();

    expect(await graph.invoke({ value: 1 }, { callbacks: [tracer] })).toEqual({
      value: 3,
    });
    expect(created("nested")[0].inputs).toEqual({});
    expect(created("node")[0].inputs).toEqual({ value: 1 });
    expect(created("plain")[0].inputs).toEqual({ value: 2 });
  });

  it("keeps the policy through tuple registration, input schemas, and defaults", async () => {
    const FullState = Annotation.Root({
      value: Annotation<number>,
      extra: Annotation<string>,
    });
    const { tracer, created } = mockTracer();
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
    expect(processInputs).toHaveBeenCalledWith({ value: 1 });
    expect(created("node")[0].inputs).toEqual({});
  });

  it("applies the policy to every retry attempt", async () => {
    const { tracer, created, ended } = mockTracer();
    const action = vi.fn(increment).mockImplementationOnce(() => {
      throw new Error("retry");
    });
    const graph = new StateGraph(State)
      .addNode("node", action, {
        tracePolicy: { processInputs: omitPayload, processOutputs: omitPayload },
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
    const runs = created("node");
    expect(runs.map((run) => run.inputs)).toEqual([{}, {}]);
    expect(ended(runs[0]).error).toContain("retry");
    expect(ended(runs[1]).outputs).toEqual({});
  });

  it("doesn't send a run whose processor throws", async () => {
    const { tracer, created } = mockTracer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const graph = makeGraph({
      processInputs: () => {
        throw new Error("boom");
      },
    });

    expect(await graph.invoke({ value: 1 }, { callbacks: [tracer] })).toEqual({
      value: 2,
    });
    expect(created("node")).toEqual([]);
    vi.restoreAllMocks();
  });

  it("leaves streamEvents and message streams untouched", async () => {
    const policy = { processInputs: omitPayload, processOutputs: omitPayload };
    const events = await gatherIterator(
      makeGraph(policy).streamEvents({ value: 1 }, { version: "v2" })
    );
    const nodeEvent = (event: string) =>
      events.find((e) => e.name === "node" && e.event === event)?.data;
    expect(nodeEvent("on_chain_start")?.input).toEqual({ value: 1 });
    expect(nodeEvent("on_chain_end")?.output).toEqual({ value: 2 });

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("node", () => ({ messages: [new AIMessage("hello")] }), {
        tracePolicy: policy,
      })
      .addEdge(START, "node")
      .addEdge("node", END)
      .compile();
    const messages = await gatherIterator(
      graph.stream({ messages: [] }, { streamMode: "messages" })
    );
    expect(messages.map(([message]) => message.content)).toEqual(["hello"]);
  });
});
