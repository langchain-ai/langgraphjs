/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod/v4";
import { RunnableLambda } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

import { StateGraph } from "../graph/index.js";
import { Command, END, START } from "../constants.js";
import { interrupt } from "../interrupt.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import { StreamChannel } from "../stream/stream-channel.js";
import type { ProtocolEvent, StreamTransformer } from "../stream/types.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

async function collectEvents(
  run: AsyncIterable<ProtocolEvent>
): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const event of run) {
    events.push(event);
  }
  return events;
}

function byMethod(events: ProtocolEvent[], method: string): ProtocolEvent[] {
  return events.filter((e) => e.method === method);
}

const CounterState = new StateSchema({
  count: new ReducedValue(z.number().default(() => 0), {
    reducer: (a: number, b: number) => a + b,
  }),
});

function buildCounterGraph() {
  return new StateGraph(CounterState)
    .addNode("add_one", () => ({ count: 1 }))
    .addEdge(START, "add_one")
    .addEdge("add_one", END)
    .compile();
}

function buildTwoStepGraph() {
  return new StateGraph(CounterState)
    .addNode("step1", () => ({ count: 1 }))
    .addNode("step2", () => ({ count: 10 }))
    .addEdge(START, "step1")
    .addEdge("step1", "step2")
    .addEdge("step2", END)
    .compile();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamEvents version v3", () => {
  describe("values mode", () => {
    it("emits values events matching state snapshots", async () => {
      const graph = buildTwoStepGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const valuesEvents = byMethod(events, "values");
      expect(valuesEvents.length).toBeGreaterThanOrEqual(2);

      const data = valuesEvents.map((e) => e.params.data) as Array<{
        count: number;
      }>;
      expect(data.at(-1)!.count).toBe(11);
    });

    it("resolves run.output with the final state", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 5 }, { version: "v3" });

      const output = await run.output;
      expect(output).toEqual({ count: 6 });
    });

    it("encodes protocol events as text/event-stream", async () => {
      const graph = buildCounterGraph();
      const stream = await graph.streamEvents(
        { count: 0 },
        { version: "v3", encoding: "text/event-stream" }
      );
      const decoder = new TextDecoder();
      let body = "";

      for await (const chunk of stream) {
        body += decoder.decode(chunk, { stream: true });
      }
      body += decoder.decode();

      expect(body).toContain("event: values\n");
      expect(body).toContain('data: {"count":1}');
    });

    it("run.values resolves as a Promise to the final state", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });

      const values = await run.values;
      expect(values).toEqual({ count: 1 });
    });

    it("run.values can be iterated for intermediate snapshots", async () => {
      const graph = buildTwoStepGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });

      const snapshots: unknown[] = [];
      for await (const snapshot of run.values) {
        snapshots.push(snapshot);
      }
      expect(snapshots).toEqual([
        { count: 0 },
        { count: 1 },
        { count: 11 }
      ])
    });
  });

  describe("updates mode", () => {
    it("emits updates events for each node execution", async () => {
      const graph = buildTwoStepGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const updatesEvents = byMethod(events, "updates");
      expect(updatesEvents.map((e) => e.params.data)).toEqual([
        {
          node: "step1",
          values: {
            count: 1,
          },
        },
        {
          node: "step2",
          values: {
            count: 10,
          },
        },
      ]);
    });

    it("updates events carry the node delta values", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const updatesEvents = byMethod(events, "updates");
      const addOneUpdate = updatesEvents.find(
        (e) => (e.params.data as any)?.node === "add_one"
      );
      expect(addOneUpdate?.params.data).toEqual({
        node: "add_one",
        values: { count: 1 }
      });
    });
  });

  describe("custom mode", () => {
    it("emits custom events written via config.writer", async () => {
      const CustomState = new StateSchema({
        value: new ReducedValue(z.string().default(() => ""), {
          reducer: (_: string, b: string) => b,
        }),
      });

      const graph = new StateGraph(CustomState)
        .addNode(
          "writer_node",
          RunnableLambda.from(
            (_state: typeof CustomState.State, config) => {
              const writer = (config as LangGraphRunnableConfig).writer;
              writer?.({ custom_key: "custom_value" });
              return { value: "done" };
            }
          )
        )
        .addEdge(START, "writer_node")
        .addEdge("writer_node", END)
        .compile();

      const run = await graph.streamEvents({ value: "" }, { version: "v3" });
      const events = await collectEvents(run);

      const customEvents = byMethod(events, "custom");
      expect(customEvents.length).toBeGreaterThanOrEqual(1);

      const payloads = customEvents.map((e) => e.params.data);
      expect(payloads).toEqual([{
        payload: { custom_key: "custom_value" },
      }]);
    });
  });

  describe("checkpoint envelope on values events", () => {
    // `streamEvents(..., { version: "v3" })` intentionally does not include
    // the `debug` stream mode —
    // it was a thin re-wrap of `checkpoints` + `tasks`. Branching and
    // time-travel use cases are served by a dedicated `checkpoints`
    // channel, emitted as a companion event immediately before each
    // `values` event so clients can correlate the pair by adjacent `seq`
    // or by `(namespace, step)`.
    it("does not emit 'debug' events", async () => {
      const graph = new StateGraph(CounterState)
        .addNode("add_one", () => ({ count: 1 }))
        .addEdge(START, "add_one")
        .addEdge("add_one", END)
        .compile({ checkpointer: new MemorySaver() });

      const run = await graph.streamEvents(
        { count: 0 },
        { version: "v3", configurable: { thread_id: "no-debug" } }
      );
      const events = await collectEvents(run);

      expect(byMethod(events, "debug" as never)).toHaveLength(0);
    });

    it("emits a companion 'checkpoints' event before each 'values' event when a checkpointer is configured", async () => {
      const graph = new StateGraph(CounterState)
        .addNode("add_one", () => ({ count: 1 }))
        .addEdge(START, "add_one")
        .addEdge("add_one", END)
        .compile({ checkpointer: new MemorySaver() });

      const run = await graph.streamEvents(
        { count: 0 },
        { version: "v3", configurable: { thread_id: "ckpt-values" } }
      );
      const events = await collectEvents(run);

      const checkpointsEvents = byMethod(events, "checkpoints");
      const valuesEvents = byMethod(events, "values");
      expect(valuesEvents.length).toBeGreaterThan(0);
      expect(checkpointsEvents.length).toBe(valuesEvents.length);

      // `values` events no longer carry an inline `checkpoint` field.
      for (const ev of valuesEvents) {
        expect((ev.params as any).checkpoint).toBeUndefined();
      }

      for (const ev of checkpointsEvents) {
        const ckpt = ev.params.data as any;
        expect(typeof ckpt.id).toBe("string");
        expect(typeof ckpt.step).toBe("number");
        expect(["input", "loop", "update", "fork"]).toContain(ckpt.source);
      }

      // Parent/child linkage: subsequent `checkpoints` events should
      // reference the previous event's checkpoint id as their parent_id.
      const ckpts = checkpointsEvents.map((e) => e.params.data as any);
      for (let i = 1; i < ckpts.length; i += 1) {
        if (ckpts[i].parent_id != null) {
          expect(ckpts[i].parent_id).toBe(ckpts[i - 1].id);
        }
      }

      // Ordering: each `checkpoints` event should immediately precede its
      // companion `values` event on the same namespace.
      const indexFor = (e: (typeof events)[number]) => events.indexOf(e);
      for (let i = 0; i < valuesEvents.length; i += 1) {
        expect(indexFor(checkpointsEvents[i])).toBeLessThan(
          indexFor(valuesEvents[i])
        );
      }
    });

    it("does not inline checkpoint metadata on values events", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const valuesEvents = byMethod(events, "values");
      expect(valuesEvents.length).toBeGreaterThan(0);

      // Without a persistent checkpointer the in-memory working
      // checkpoint still produces a companion `checkpoints` event, but
      // `values` events never carry an inline `checkpoint` field — the
      // envelope is only ever delivered on its own channel.
      for (const ev of valuesEvents) {
        expect((ev.params as any).checkpoint).toBeUndefined();
      }

      for (const ev of byMethod(events, "checkpoints")) {
        const ckpt = ev.params.data as any;
        expect(typeof ckpt.id).toBe("string");
      }
    });
  });

  describe("tasks mode", () => {
    it("emits tasks events during execution", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const tasksEvents = byMethod(events, "tasks");
      expect(tasksEvents).toHaveLength(2);

      const [taskStart, taskResult] = tasksEvents.map(
        (e) => e.params.data as any
      );

      expect(taskStart).toMatchObject({
        name: "add_one",
        input: { count: 0 },
        triggers: ["branch:to:add_one"],
        interrupts: [],
      });
      expect(taskStart.id).toEqual(expect.any(String));

      expect(taskResult).toMatchObject({
        name: "add_one",
        result: { count: 1 },
        interrupts: [],
      });
      expect(taskResult.id).toBe(taskStart.id);
    });
  });

  describe("all modes together", () => {
    it("emits events for multiple stream modes in a single run", async () => {
      const graph = buildTwoStepGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      expect(events.length).toBeGreaterThan(0);

      const methods = new Set(events.map((e) => e.method));
      expect(methods.has("values")).toBe(true);
      expect(methods.has("updates")).toBe(true);
      expect(methods.has("tasks")).toBe(true);
    });

    it("events have monotonically increasing seq numbers", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      for (let i = 1; i < events.length; i++) {
        expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
      }
    });

    it("all events have type 'event'", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      for (const event of events) {
        expect(event.type).toBe("event");
      }
    });

    it("all events carry a timestamp", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      for (const event of events) {
        expect(typeof event.params.timestamp).toBe("number");
        expect(event.params.timestamp).toBeGreaterThan(0);
      }
    });
  });

  describe("subgraphs", () => {
    it("emits events with nested namespaces for subgraph nodes", async () => {
      const inner = new StateGraph(CounterState)
        .addNode("inner_step", () => ({ count: 100 }))
        .addEdge(START, "inner_step")
        .addEdge("inner_step", END)
        .compile();

      const outer = new StateGraph(CounterState)
        .addNode("outer_step", () => ({ count: 1 }))
        .addNode("subgraph", inner)
        .addEdge(START, "outer_step")
        .addEdge("outer_step", "subgraph")
        .addEdge("subgraph", END)
        .compile();

      const run = await outer.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const subgraphEvents = events.filter(
        (e) => e.params.namespace.length > 0
      );
      expect(subgraphEvents.length).toBeGreaterThan(0);

      const output = await run.output;
      expect(output!.count).toBeGreaterThanOrEqual(100);
    });

    it("run.subgraphs yields SubgraphRunStream instances", async () => {
      const inner = new StateGraph(CounterState)
        .addNode("inner_step", () => ({ count: 5 }))
        .addEdge(START, "inner_step")
        .addEdge("inner_step", END)
        .compile();

      const outer = new StateGraph(CounterState)
        .addNode("sub", inner)
        .addEdge(START, "sub")
        .addEdge("sub", END)
        .compile();

      const run = await outer.streamEvents({ count: 0 }, { version: "v3" });

      const subgraphs: any[] = [];
      const allSubEvents: ProtocolEvent[][] = [];
      for await (const sub of run.subgraphs) {
        subgraphs.push(sub);
        allSubEvents.push(await collectEvents(sub));
      }

      expect(subgraphs).toHaveLength(1);
      expect(subgraphs[0].name).toBe("sub");
      expect(subgraphs[0].index).toBe(0);

      const events = allSubEvents[0];
      expect(events).toHaveLength(9);

      for (const event of events) {
        expect(event.params.namespace[0]).toMatch(/^sub:/);
      }

      const eventSequence = events.map((e) => e.method);
      // Each `values` event is preceded by its companion `checkpoints`
      // envelope event on the same namespace.  The subgraph is bracketed
      // by the `LifecycleTransformer`'s synthesized started/completed
      // events.
      expect(eventSequence).toEqual([
        "lifecycle",
        "checkpoints",
        "values",
        "tasks",
        "updates",
        "tasks",
        "checkpoints",
        "values",
        "lifecycle",
      ]);

      const subValues = byMethod(events, "values").map(
        (e) => e.params.data as any
      );
      expect(subValues).toEqual([{ count: 0 }, { count: 5 }]);

      const subUpdates = byMethod(events, "updates").map(
        (e) => e.params.data as any
      );
      expect(subUpdates).toEqual([
        { node: "inner_step", values: { count: 5 } },
      ]);

      const subTasks = byMethod(events, "tasks").map(
        (e) => e.params.data as any
      );
      expect(subTasks[0]).toMatchObject({
        name: "inner_step",
        input: { count: 0 },
        triggers: ["branch:to:inner_step"],
      });
      expect(subTasks[1]).toMatchObject({
        name: "inner_step",
        result: { count: 5 },
      });
      expect(subTasks[1].id).toBe(subTasks[0].id);

      // Debug mode is not part of STREAM_EVENTS_V3_MODES; confirm it isn't emitted.
      expect(byMethod(events, "debug" as never)).toHaveLength(0);
    });
  });

  describe("interrupts", () => {
    const StringState = new StateSchema({
      value: new ReducedValue(z.string().default(() => ""), {
        reducer: (_: string, b: string) => b,
      }),
    });

    it("sets run.interrupted and run.interrupts when interrupt() is called", async () => {
      const graph = new StateGraph(StringState)
        .addNode("ask", () => {
          const answer = interrupt("question?");
          return { value: String(answer) };
        })
        .addEdge(START, "ask")
        .addEdge("ask", END)
        .compile({ checkpointer: new MemorySaver() });

      const run = await graph.streamEvents(
        { value: "start" },
        { version: "v3", configurable: { thread_id: "int-1" } }
      );

      // Drain events
      await collectEvents(run);

      expect(run.interrupted).toBe(true);
      expect(run.interrupts.length).toBeGreaterThanOrEqual(1);
      expect(run.interrupts[0].payload).toBe("question?");
    });

    it("can resume after interrupt with Command({ resume })", async () => {
      const graph = new StateGraph(StringState)
        .addNode("ask", () => {
          const answer = interrupt("question?");
          return { value: String(answer) };
        })
        .addEdge(START, "ask")
        .addEdge("ask", END)
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "int-resume-1" } };

      const run1 = await graph.streamEvents(
        { value: "start" },
        { ...config, version: "v3" }
      );
      await collectEvents(run1);
      expect(run1.interrupted).toBe(true);

      const run2 = await graph.streamEvents(
        new Command({ resume: "yes" }),
        { ...config, version: "v3" }
      );
      const output = await run2.output;
      expect(output!.value).toBe("yes");
      expect(run2.interrupted).toBe(false);
    });
  });

  describe("abort", () => {
    it("exposes abort() and signal on the run stream", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });

      expect(typeof run.abort).toBe("function");
      expect(run.signal).toBeInstanceOf(AbortSignal);
      expect(run.signal.aborted).toBe(false);

      // Drain events so the run completes
      await collectEvents(run);
    });
  });

  describe("extensions (user-supplied transformers)", () => {
    it("merges transformer projections into run.extensions", async () => {
      const graph = buildCounterGraph();

      const eventCounter = (): StreamTransformer<{
        eventCount: Promise<number>;
      }> => {
        let count = 0;
        let resolve: (n: number) => void;
        const promise = new Promise<number>((r) => {
          resolve = r;
        });
        return {
          init: () => ({ eventCount: promise }),
          process: () => {
            count += 1;
            return true;
          },
          finalize: () => resolve(count),
        };
      };

      const run = await graph.streamEvents(
        { count: 0 },
        { version: "v3", transformers: [eventCounter] }
      );

      // Drain events
      await collectEvents(run);

      const totalEvents = await run.extensions.eventCount;
      expect(totalEvents).toBeGreaterThan(0);
    });

    it("transformer can suppress events by returning false from process", async () => {
      const graph = buildCounterGraph();

      const noDebug = (): StreamTransformer<Record<string, never>> => ({
        init: () => ({}) as Record<string, never>,
        process: (event) => event.method !== "debug",
      });

      const run = await graph.streamEvents(
        { count: 0 },
        { version: "v3", transformers: [noDebug] }
      );

      const events = await collectEvents(run);
      const debugEvents = byMethod(events, "debug");
      expect(debugEvents).toHaveLength(0);

      const valuesEvents = byMethod(events, "values");
      expect(valuesEvents.length).toBeGreaterThan(0);
    });

    it("StreamChannel pushes appear as protocol events and are iterable via extensions", async () => {
      const graph = buildTwoStepGraph();

      type StepLog = { node: string; count: number };

      const createStepLogger = (): StreamTransformer<{
        steps: StreamChannel<StepLog>;
      }> => {
        const steps = StreamChannel.remote<StepLog>("steps");
        return {
          init: () => ({ steps }),
          process: (event) => {
            if (event.method === "updates") {
              const data = event.params.data as any;
              if (data.node) {
                steps.push({ node: data.node, count: data.values?.count });
              }
            }
            return true;
          },
        };
      };

      const run = await graph.streamEvents(
        { count: 0 },
        { version: "v3", transformers: [createStepLogger] }
      );

      const events = await collectEvents(run);

      const stepEvents = events.filter(
        (e) => e.method === ("steps" as any)
      );
      expect(stepEvents).toHaveLength(2);
      expect(stepEvents[0].params.data).toEqual({ node: "step1", count: 1 });
      expect(stepEvents[1].params.data).toEqual({
        node: "step2",
        count: 10,
      });

      const logged: StepLog[] = [];
      for await (const step of run.extensions.steps) {
        logged.push(step);
      }
      expect(logged).toEqual([
        { node: "step1", count: 1 },
        { node: "step2", count: 10 },
      ]);
    });
  });

  describe("protocol event structure", () => {
    it("values events carry state data in params.data", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 5 }, { version: "v3" });
      const events = await collectEvents(run);

      const valuesEvents = byMethod(events, "values");
      expect(valuesEvents.length).toBeGreaterThan(0);

      for (const event of valuesEvents) {
        expect(event.params).toHaveProperty("namespace");
        expect(event.params).toHaveProperty("timestamp");
        expect(event.params).toHaveProperty("data");
        expect(Array.isArray(event.params.namespace)).toBe(true);
      }
    });

    it("updates events carry node and values in params.data", async () => {
      const graph = buildCounterGraph();
      const run = await graph.streamEvents({ count: 0 }, { version: "v3" });
      const events = await collectEvents(run);

      const updatesEvents = byMethod(events, "updates");
      const nodeUpdate = updatesEvents.find(
        (e) => (e.params.data as any)?.node === "add_one"
      );
      expect(nodeUpdate).toBeDefined();
      expect((nodeUpdate!.params.data as any).values).toBeDefined();
    });

    it("custom events wrap payload in { payload: ... }", async () => {
      const ValState = new StateSchema({
        val: new ReducedValue(z.string().default(() => ""), {
          reducer: (_: string, b: string) => b,
        }),
      });

      const graph = new StateGraph(ValState)
        .addNode(
          "node",
          RunnableLambda.from(
            (_state: typeof ValState.State, config) => {
              const writer = (config as LangGraphRunnableConfig).writer;
              writer?.({ hello: "world" });
              return { val: "ok" };
            }
          )
        )
        .addEdge(START, "node")
        .addEdge("node", END)
        .compile();

      const run = await graph.streamEvents({ val: "" }, { version: "v3" });
      const events = await collectEvents(run);

      const customEvents = byMethod(events, "custom");
      expect(customEvents.length).toBeGreaterThanOrEqual(1);
      expect(customEvents[0].params.data).toEqual({
        payload: { hello: "world" },
      });
    });
  });
});
