import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "../web.js";
import { initializeAsyncLocalStorageSingleton } from "../node.js";

beforeAll(() => {
  initializeAsyncLocalStorageSingleton();
});

describe("bigint in graph state", () => {
  it("survives a MemorySaver checkpoint across an interrupt and resume", async () => {
    const big = 12345678901234567890n;
    const State = Annotation.Root({
      big: Annotation<bigint | undefined>,
      result: Annotation<string>,
    });
    const graph = new StateGraph(State)
      .addNode("write", () => ({ big }))
      .addNode("pause", () => {
        interrupt("pause");
        return {};
      })
      .addNode("read", (state) => ({
        result: `${typeof state.big}:${String(state.big)}`,
      }))
      .addEdge(START, "write")
      .addEdge("write", "pause")
      .addEdge("pause", "read")
      .addEdge("read", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "bigint-thread" } };

    await graph.invoke({}, config);

    const snapshot = await graph.getState(config);
    expect(snapshot.values.big).toBe(big);
    expect(snapshot.next).toEqual(["pause"]);

    const resumed = await graph.invoke(new Command({ resume: "go" }), config);
    expect(resumed.result).toBe(`bigint:${String(big)}`);
    expect(resumed.big).toBe(big);
  });
});
