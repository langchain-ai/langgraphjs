import { InMemoryCache, MemorySaver } from "@langchain/langgraph-checkpoint";
import { interrupt } from "../../interrupt.js";
import { describe, expect, it } from "vitest";
import { Annotation, Command, END, START, StateGraph } from "../../index.js";
import type { ProtocolEvent } from "../../stream/types.js";

const State = Annotation.Root({ value: Annotation<number>() });

async function results(stream: AsyncIterable<ProtocolEvent>) {
  const out: Record<string, unknown>[] = [];
  for await (const event of stream) {
    if (event.method === "tasks" && event.params.data !== null && typeof event.params.data === "object" && "result" in event.params.data) {
      out.push({ ...event.params.data });
    }
  }
  return out;
}

function graph(output: { value: number } | Command | Command[]) {
  return new StateGraph(State)
    .addNode("update", () => output)
    .addEdge(START, "update")
    .addEdge("update", END)
    .compile();
}

describe("native task return carrier", () => {
  it("distinguishes identical writes from objects, Commands, and arrays", async () => {
    for (const [output, output_type] of [
      [{ value: 1 }, "Object"],
      [new Command({ update: { value: 1 } }), "Command"],
      [[new Command({ update: { value: 1 } })], "Array"],
    ] satisfies [Parameters<typeof graph>[0], string][]) {
      const events = await results(await graph(output).streamEvents({ value: 0 }, { version: "v3" }));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ name: "update", result: { value: 1 }, output_type });
    }
  });

  it("leaves legacy tasks and debug payloads unchanged", async () => {
    for (const streamMode of ["tasks", "debug"] as const) {
      for await (const event of await graph(new Command({ update: { value: 1 } })).stream({ value: 0 }, { streamMode })) {
        const payload = "payload" in event ? event.payload : event;
        expect(payload).not.toHaveProperty("output_type");
      }
    }
  });

  it("records the successful retry carrier", async () => {
    let attempts = 0;
    const retryGraph = new StateGraph(State)
      .addNode("update", () => {
        if (attempts++ === 0) throw new Error("retry");
        return new Command({ update: { value: 2 } });
      }, { retryPolicy: { maxAttempts: 2, initialInterval: 1, jitter: false, retryOn: () => true, logWarning: false } })
      .addEdge(START, "update")
      .addEdge("update", END)
      .compile();
    expect(await results(await retryGraph.streamEvents({ value: 0 }, { version: "v3" }))).toMatchObject([
      { result: { value: 2 }, output_type: "Command" },
    ]);
    expect(attempts).toBe(2);
  });

  it("does not label custom class instances as plain objects", async () => {
    class Update { value = 1; }
    const events = await results(await graph(new Update()).streamEvents({ value: 0 }, { version: "v3" }));
    expect(events[0]).toMatchObject({ result: { value: 1 } });
    expect(events[0]).not.toHaveProperty("output_type");
  });
  it("keeps concurrent nested runs isolated", async () => {
    async function run(output: { value: number } | Command) {
      const parent = new StateGraph(State)
        .addNode("child", graph(output))
        .addEdge(START, "child").addEdge("child", END).compile();
      return results(await parent.streamEvents({ value: 0 }, { version: "v3" }));
    }
    const [plain, command] = await Promise.all([run({ value: 1 }), run(new Command({ update: { value: 1 } }))]);
    expect(plain.find((e) => e.name === "update")).toHaveProperty("output_type", "Object");
    expect(command.find((e) => e.name === "update")).toHaveProperty("output_type", "Command");
  });

  it("omits provenance for interrupts and cache hits", async () => {
    const paused = new StateGraph(State)
      .addNode("pause", () => { interrupt("pause"); return { value: 1 }; })
      .addEdge(START, "pause").addEdge("pause", END)
      .compile({ checkpointer: new MemorySaver() });
    const events = await results(await paused.streamEvents({ value: 0 }, { version: "v3", configurable: { thread_id: "provenance" } }));
    for (const event of events) expect(event).not.toHaveProperty("output_type");
    let calls = 0;
    const cached = new StateGraph(State)
      .addNode("cached", () => { calls++; return new Command({ update: { value: 1 } }); }, { cachePolicy: true })
      .addEdge(START, "cached").addEdge("cached", END)
      .compile({ cache: new InMemoryCache() });
    expect(await results(await cached.streamEvents({ value: 0 }, { version: "v3" }))).toMatchObject([{ output_type: "Command" }]);
    const replay = await results(await cached.streamEvents({ value: 0 }, { version: "v3" }));
    for (const event of replay) expect(event).not.toHaveProperty("output_type");
    expect(calls).toBe(1);
  });

  it("does not attach provenance to failed tasks", async () => {
    const broken = new StateGraph(State)
      .addNode("broken", () => { throw new Error("expected failure"); })
      .addEdge(START, "broken").addEdge("broken", END).compile();
    const observed: ProtocolEvent[] = [];
    await expect((async () => {
      for await (const event of await broken.streamEvents({ value: 0 }, { version: "v3" })) observed.push(event);
    })()).rejects.toThrow("expected failure");
    for (const event of observed) {
      if (event.method === "tasks") expect(event.params.data).not.toHaveProperty("output_type");
    }
  });

});
