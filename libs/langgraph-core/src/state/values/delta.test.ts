import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { DeltaValue } from "./delta.js";
import { ReducedValue } from "./reduced.js";
import { UntrackedValue } from "./untracked.js";
import { DeltaChannel } from "../../channels/index.js";
import { StateGraph } from "../../graph/state.js";
import { StateSchema } from "../schema.js";
import {
  END,
  Overwrite,
  START,
  type OverwriteValue,
} from "../../constants.js";

describe("DeltaValue", () => {
  it("should store value and input schemas", () => {
    const delta = new DeltaValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer: (current: string[], writes: string[]) => [
          ...current,
          ...writes,
        ],
      }
    );

    expect(DeltaValue.isInstance(delta)).toBe(true);
    expect(delta.valueSchema).toBeDefined();
    expect(delta.inputSchema).toBeDefined();
  });

  it("should store reducer and snapshotFrequency", () => {
    const reducer = (a: string[], b: string[]) => [...a, ...b];
    const delta = new DeltaValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer,
        snapshotFrequency: 13,
      }
    );

    expect(delta.reducer).toBe(reducer);
    expect(delta.snapshotFrequency).toBe(13);
  });

  it("should default inputSchema to valueSchema when omitted", () => {
    const valueSchema = z.array(z.number()).default(() => []);
    const delta = new DeltaValue(valueSchema, {
      reducer: (current, writes) => [...current, ...writes.flat()],
    });

    expect(delta.inputSchema).toBe(valueSchema);
    expect(delta.snapshotFrequency).toBeUndefined();
  });

  describe("isInstance", () => {
    it("should identify DeltaValue instances", () => {
      const delta = new DeltaValue(z.array(z.number()).default(() => []), {
        reducer: (a, b) => [...a, ...b.flat()],
      });
      expect(DeltaValue.isInstance(delta)).toBe(true);
    });

    it("should reject non-DeltaValue objects", () => {
      expect(DeltaValue.isInstance({})).toBe(false);
      expect(DeltaValue.isInstance(null)).toBe(false);
      expect(DeltaValue.isInstance(undefined)).toBe(false);
      expect(DeltaValue.isInstance(new UntrackedValue())).toBe(false);
      expect(
        DeltaValue.isInstance(
          new ReducedValue(z.number().default(0), {
            reducer: (a: number, b: number) => a + b,
          })
        )
      ).toBe(false);
    });
  });

  describe("getChannels", () => {
    it("should map a DeltaValue to a DeltaChannel and forward snapshotFrequency", () => {
      const state = new StateSchema({
        history: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
            snapshotFrequency: 5,
          }
        ),
      });

      const channels = state.getChannels();
      expect(channels.history).toBeInstanceOf(DeltaChannel);
      const channel = channels.history as DeltaChannel<string[], string>;
      expect(channel.snapshotFrequency).toBe(5);
      // The value schema default seeds the initial value factory.
      expect(channel.initialValueFactory()).toEqual([]);
    });
  });

  describe("StateGraph usage", () => {
    it("should handle a reducer where input type differs from value type", async () => {
      const AgentState = new StateSchema({
        items: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode("add_item", () => ({ items: "new_item" }))
        .addEdge(START, "add_item")
        .addEdge("add_item", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.items).toEqual(["new_item"]);
    });

    it("should reconstruct accumulated state from a checkpointer", async () => {
      const AgentState = new StateSchema({
        items: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
          }
        ),
      });

      const checkpointer = new MemorySaver();
      const makeGraph = () =>
        new StateGraph(AgentState)
          .addNode("step", (state) => ({ items: `n${state.items.length}` }))
          .addEdge(START, "step")
          .addEdge("step", END)
          .compile({ checkpointer });

      const config = { configurable: { thread_id: "1" } };
      await makeGraph().invoke({ items: "a" }, config);
      await makeGraph().invoke({ items: "b" }, config);

      // Cold read from a fresh graph reconstructs purely from the saver.
      const state = await makeGraph().getState(config);
      expect(state.values.items).toEqual(["a", "n1", "b", "n3"]);
    });

    it("should apply an Overwrite as a hard reset", async () => {
      const AgentState = new StateSchema({
        items: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode("reset", () => ({ items: new Overwrite(["fresh"]) }))
        .addEdge(START, "reset")
        .addEdge("reset", END)
        .compile();

      const result = await graph.invoke({ items: "dropped" });
      expect(result.items).toEqual(["fresh"]);
    });

    it("should validate inputs against inputSchema on invoke", async () => {
      const AgentState = new StateSchema({
        emails: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string().email(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode("add_email", () => ({ emails: "test@example.com" }))
        .addEdge(START, "add_email")
        .addEdge("add_email", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.emails).toEqual(["test@example.com"]);

      await expect(graph.invoke({ emails: "not-an-email" })).rejects.toThrow();
    });

    it("should correctly type state vs update", () => {
      const AgentState = new StateSchema({
        items: new DeltaValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], writes: string[]) => [
              ...current,
              ...writes,
            ],
          }
        ),
        count: z.number().default(0),
      });

      type State = typeof AgentState.State;
      type Update = typeof AgentState.Update;

      expectTypeOf<State["items"]>().toEqualTypeOf<string[]>();
      expectTypeOf<State["count"]>().toEqualTypeOf<number>();

      expectTypeOf<Update["items"]>().toEqualTypeOf<
        string | OverwriteValue<string[]> | undefined
      >();
    });
  });
});
