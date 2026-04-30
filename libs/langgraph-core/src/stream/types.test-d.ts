/* eslint-disable @typescript-eslint/no-explicit-any */
import { expectTypeOf, it, describe } from "vitest";
import { z } from "zod/v4";

import { StateGraph } from "../graph/state.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { MessagesValue } from "../state/prebuilt/messages.js";
import { END, START } from "../constants.js";
import type {
  ProtocolEvent,
  StreamTransformer,
  ChatModelStreamHandle,
  InferExtensions,
  ToolCallStream,
  ToolCallStatus,
  InterruptPayload,
} from "./types.js";
import type { GraphRunStream, SubgraphRunStream } from "./run-stream.js";

describe("streamEvents version v3 on a simple StateGraph", () => {
  const CounterState = new StateSchema({
    count: new ReducedValue(z.number().default(() => 0), {
      reducer: (a: number, b: number) => a + b,
    }),
    label: new ReducedValue(z.string().default(() => ""), {
      reducer: (_: string, b: string) => b,
    }),
  });

  const graph = new StateGraph(CounterState)
    .addNode("increment", () => ({ count: 1 }))
    .addNode("name", () => ({ label: "done" }))
    .addEdge(START, "increment")
    .addEdge("increment", "name")
    .addEdge("name", END)
    .compile();

  it("returns a Promise<GraphRunStream>", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run).toExtend<GraphRunStream>();
  });

  it("returns an encoded byte stream for text/event-stream", async () => {
    const stream = await graph.streamEvents(
      { count: 0 },
      { version: "v3", encoding: "text/event-stream" }
    );
    expectTypeOf(stream).toExtend<AsyncIterable<Uint8Array>>();
  });

  it("output resolves with the graph state type", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    const output = await run.output;
    expectTypeOf(output).toHaveProperty("count").toBeNumber();
    expectTypeOf(output).toHaveProperty("label").toBeString();
  });

  it("values is both AsyncIterable and PromiseLike of state type", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run.values).toExtend<
      AsyncIterable<{ count: number; label: string }>
    >();
    expectTypeOf(run.values).toExtend<
      PromiseLike<{ count: number; label: string }>
    >();
  });

  it("iterates ProtocolEvent", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    for await (const event of run) {
      expectTypeOf(event).toExtend<ProtocolEvent>();
      expectTypeOf(event.type).toEqualTypeOf<"event">();
      expectTypeOf(event.seq).toBeNumber();
      expectTypeOf(event.params.namespace).toEqualTypeOf<string[]>();
    }
  });

  it("messages yields ChatModelStreamHandle", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    for await (const msg of run.messages) {
      expectTypeOf(msg).toExtend<ChatModelStreamHandle>();
      expectTypeOf(msg.text).toExtend<AsyncIterable<string>>();
      expectTypeOf(msg.text).toExtend<PromiseLike<string>>();
      expectTypeOf(msg.reasoning).toExtend<AsyncIterable<string>>();
      expectTypeOf(msg.reasoning).toExtend<PromiseLike<string>>();
      expectTypeOf(msg.output).toExtend<PromiseLike<unknown>>();
    }
  });

  it("messagesFrom returns AsyncIterable<ChatModelStreamHandle>", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run.messagesFrom("increment")).toExtend<
      AsyncIterable<ChatModelStreamHandle>
    >();
  });

  it("subgraphs yields SubgraphRunStream", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    for await (const sub of run.subgraphs) {
      expectTypeOf(sub).toExtend<SubgraphRunStream>();
      expectTypeOf(sub.name).toBeString();
      expectTypeOf(sub.index).toBeNumber();
      expectTypeOf(sub.path).toEqualTypeOf<string[]>();
    }
  });

  it("interrupted and interrupts are typed", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run.interrupted).toBeBoolean();
    expectTypeOf(run.interrupts).toExtend<readonly InterruptPayload[]>();
  });

  it("abort and signal are typed", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run.abort).toBeCallableWith();
    expectTypeOf(run.abort).toBeCallableWith("reason");
    expectTypeOf(run.signal).toEqualTypeOf<AbortSignal>();
  });

  it("extensions defaults to empty record when no transformers", async () => {
    const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
    expectTypeOf(run.extensions).toEqualTypeOf<Record<string, never>>();
  });
});

describe("streamEvents version v3 with MessagesValue state", () => {
  const ChatState = new StateSchema({
    messages: MessagesValue,
    topic: new ReducedValue(z.string().default(() => ""), {
      reducer: (_: string, b: string) => b,
    }),
  });

  const graph = new StateGraph(ChatState)
    .addNode("respond", () => ({ topic: "answered" }))
    .addEdge(START, "respond")
    .addEdge("respond", END)
    .compile();

  it("output includes messages and topic", async () => {
    const run = await graph.streamEvents({ topic: "test" }, { version: "v3" });
    const output = await run.output;
    expectTypeOf(output).toHaveProperty("topic").toBeString();
    expectTypeOf(output).toHaveProperty("messages");
  });
});

describe("streamEvents version v3 with compile-time transformers", () => {
  const eventCounter = (): StreamTransformer<{
    eventCount: Promise<number>;
  }> => ({
    init: () => ({ eventCount: Promise.resolve(0) }),
    process: () => true,
    finalize: () => {},
    fail: () => {},
  });

  const CompileState = new StateSchema({
    value: new ReducedValue(z.string().default(() => ""), {
      reducer: (_: string, b: string) => b,
    }),
  });

  it("merges compile-time and call-site transformer projections", async () => {
    const graph = new StateGraph(CompileState)
      .addNode("echo", (s) => ({ value: s.value }))
      .addEdge(START, "echo")
      .addEdge("echo", END)
      .compile({ transformers: [eventCounter] });

    const callSiteTransformer = (): StreamTransformer<{
      flag: boolean;
    }> => ({
      init: () => ({ flag: true }),
      process: () => true,
      finalize: () => {},
      fail: () => {},
    });

    const run = await graph.streamEvents(
      { value: "test" },
      { version: "v3", transformers: [callSiteTransformer] }
    );

    expectTypeOf(run.extensions.eventCount).toEqualTypeOf<Promise<number>>();
    expectTypeOf(run.extensions.flag).toBeBoolean();
  });
});

describe("streamEvents version v3 with call-site transformers", () => {
  const ValueState = new StateSchema({
    value: new ReducedValue(z.string().default(() => ""), {
      reducer: (_: string, b: string) => b,
    }),
  });

  const graph = new StateGraph(ValueState)
    .addNode("echo", (s) => ({ value: s.value }))
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile();

  it("infers single reducer projection type on extensions", async () => {
    const tokenReducer = (): StreamTransformer<{
      totalTokens: Promise<number>;
    }> => ({
      init: () => ({ totalTokens: Promise.resolve(0) }),
      process: () => true,
      finalize: () => {},
      fail: () => {},
    });

    const run = await graph.streamEvents(
      { value: "test" },
      { version: "v3", transformers: [tokenReducer] }
    );

    expectTypeOf(run.extensions.totalTokens).toEqualTypeOf<Promise<number>>();
  });

  it("intersects projections from multiple transformers", async () => {
    const countReducer = (): StreamTransformer<{
      eventCount: Promise<number>;
    }> => ({
      init: () => ({ eventCount: Promise.resolve(0) }),
      process: () => true,
      finalize: () => {},
      fail: () => {},
    });

    const labelReducer = (): StreamTransformer<{
      lastNode: Promise<string>;
    }> => ({
      init: () => ({ lastNode: Promise.resolve("") }),
      process: () => true,
      finalize: () => {},
      fail: () => {},
    });

    const run = await graph.streamEvents(
      { value: "test" },
      { version: "v3", transformers: [countReducer, labelReducer] }
    );

    expectTypeOf(run.extensions.eventCount).toEqualTypeOf<Promise<number>>();
    expectTypeOf(run.extensions.lastNode).toEqualTypeOf<Promise<string>>();
  });

  it("output type is preserved alongside custom extensions", async () => {
    const reducer = (): StreamTransformer<{ flag: boolean }> => ({
      init: () => ({ flag: true }),
      process: () => true,
      finalize: () => {},
      fail: () => {},
    });

    const run = await graph.streamEvents(
      { value: "test" },
      { version: "v3", transformers: [reducer] }
    );

    const output = await run.output;
    expectTypeOf(output).toHaveProperty("value").toBeString();
    expectTypeOf(run.extensions.flag).toBeBoolean();
  });
});

describe("streamEvents version v3 with subgraph nodes", () => {
  const ItemsState = new StateSchema({
    items: new ReducedValue(
      z.array(z.string()).default(() => []),
      { reducer: (a: string[], b: string[]) => [...a, ...b] }
    ),
  });

  const childGraph = new StateGraph(ItemsState)
    .addNode("worker", () => ({ items: ["processed"] }))
    .addEdge(START, "worker")
    .addEdge("worker", END)
    .compile();

  const graph = new StateGraph(ItemsState)
    .addNode("child", childGraph)
    .addEdge(START, "child")
    .addEdge("child", END)
    .compile();

  it("subgraphs yield SubgraphRunStream with correct types", async () => {
    const run = await graph.streamEvents({ items: [] }, { version: "v3" });

    for await (const sub of run.subgraphs) {
      expectTypeOf(sub).toExtend<SubgraphRunStream>();
      expectTypeOf(sub.name).toBeString();
      expectTypeOf(sub.index).toBeNumber();

      for await (const msg of sub.messages) {
        expectTypeOf(msg).toExtend<ChatModelStreamHandle>();
      }

      const subOutput = await sub.output;
      expectTypeOf(subOutput).toExtend<Record<string, unknown>>();
    }
  });

  it("recursive subgraphs are also SubgraphRunStream", async () => {
    const run = await graph.streamEvents({ items: [] }, { version: "v3" });

    for await (const sub of run.subgraphs) {
      for await (const nested of sub.subgraphs) {
        expectTypeOf(nested).toExtend<SubgraphRunStream>();
        expectTypeOf(nested.name).toBeString();
      }
    }
  });
});

describe("InferExtensions utility type", () => {
  it("produces Record<string, never> for empty tuple", () => {
    expectTypeOf<InferExtensions<[]>>().toEqualTypeOf<
      Record<string, never>
    >();
  });

  it("infers a single projection", () => {
    type Factories = [() => StreamTransformer<{ count: number }>];
    expectTypeOf<InferExtensions<Factories>>().toExtend<{
      count: number;
    }>();
  });

  it("intersects multiple projections", () => {
    type Factories = [
      () => StreamTransformer<{ a: number }>,
      () => StreamTransformer<{ b: string }>,
      () => StreamTransformer<{ c: boolean }>,
    ];
    type Result = InferExtensions<Factories>;
    expectTypeOf<Result>().toExtend<{ a: number }>();
    expectTypeOf<Result>().toExtend<{ b: string }>();
    expectTypeOf<Result>().toExtend<{ c: boolean }>();
  });

  it("falls back to Record<string, unknown> for widened arrays", () => {
    type Widened = InferExtensions<Array<() => StreamTransformer<any>>>;
    expectTypeOf<Widened>().toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("ToolCallStream discriminated union", () => {
  it("narrows input and output by name", () => {
    type Union =
      | ToolCallStream<"search", { query: string }, string[]>
      | ToolCallStream<"calc", { expr: string }, number>;

    const call = {} as Union;
    if (call.name === "search") {
      expectTypeOf(call.input).toEqualTypeOf<{ query: string }>();
      expectTypeOf(call.output).toEqualTypeOf<Promise<string[]>>();
    }
    if (call.name === "calc") {
      expectTypeOf(call.input).toEqualTypeOf<{ expr: string }>();
      expectTypeOf(call.output).toEqualTypeOf<Promise<number>>();
    }
  });

  it("status and error types are always available", () => {
    const call = {} as ToolCallStream<"test", unknown, unknown>;
    expectTypeOf(call.status).toEqualTypeOf<Promise<ToolCallStatus>>();
    expectTypeOf(call.error).toEqualTypeOf<Promise<string | undefined>>();
  });
});
