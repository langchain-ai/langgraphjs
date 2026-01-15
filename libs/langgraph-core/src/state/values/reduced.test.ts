import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod/v4";
import { ReducedValue } from "./reduced.js";
import { UntrackedValue } from "./untracked.js";
import { StateGraph } from "../../graph/state.js";
import { StateSchema } from "../schema.js";
import { END, START } from "../../constants.js";

describe("ReducedValue", () => {
  it("should store value and input schemas", () => {
    const reduced = new ReducedValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer: (current: string[], next: string) => [...current, next],
      }
    );

    expect(ReducedValue.isInstance(reduced)).toBe(true);
    expect(reduced.valueSchema).toBeDefined();
    expect(reduced.inputSchema).toBeDefined();
  });

  it("should store reducer function", () => {
    const reducer = (a: string[], b: string) => [...a, b];
    const reduced = new ReducedValue(
      z.array(z.string()).default(() => []),
      {
        inputSchema: z.string(),
        reducer,
      }
    );

    expect(reduced.reducer).toBe(reducer);
  });

  describe("isInstance", () => {
    it("should identify ReducedValue instances", () => {
      const reduced = new ReducedValue(z.number().default(0), {
        inputSchema: z.number() as never,
        reducer: (a: number, b: number) => a + b,
      });
      expect(ReducedValue.isInstance(reduced)).toBe(true);
    });

    it("should reject non-ReducedValue objects", () => {
      expect(ReducedValue.isInstance({})).toBe(false);
      expect(ReducedValue.isInstance(null)).toBe(false);
      expect(ReducedValue.isInstance(undefined)).toBe(false);
      expect(ReducedValue.isInstance(new UntrackedValue())).toBe(false);
    });
  });

  describe("StateGraph usage", () => {
    it("should handle reducer where input type differs from value type", async () => {
      // Value is string[], but input is a single string
      const AgentState = new StateSchema({
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode("add_item", () => ({
          // Input type: string (not string[])
          items: "new_item",
        }))
        .addEdge(START, "add_item")
        .addEdge("add_item", END)
        .compile();

      const result = await graph.invoke({});

      // Value type: string[]
      expect(result.items).toEqual(["new_item"]);
    });

    it("should handle multiple sequential updates with different types", async () => {
      const AgentState = new StateSchema({
        // Value: number, Input: { amount: number }
        total: new ReducedValue(z.number().default(0), {
          inputSchema: z.object({ amount: z.number() }),
          reducer: (current: number, next: { amount: number }) =>
            current + next.amount,
        }),
      });

      const graph = new StateGraph(AgentState)
        .addNode("add1", () => ({ total: { amount: 10 } }))
        .addNode("add2", () => ({ total: { amount: 25 } }))
        .addEdge(START, "add1")
        .addEdge("add1", "add2")
        .addEdge("add2", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.total).toBe(35);
    });

    it("should correctly type the state vs update", async () => {
      const AgentState = new StateSchema({
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
        count: z.number().default(0),
      });

      // Type assertions at compile time
      type State = typeof AgentState.State;
      type Update = typeof AgentState.Update;

      // Verify State type has items as string[]
      expectTypeOf<State["items"]>().toEqualTypeOf<string[]>();
      expectTypeOf<State["count"]>().toEqualTypeOf<number>();

      // Verify Update type has items as string | undefined (the input type, optional)
      expectTypeOf<Update["items"]>().toEqualTypeOf<string | undefined>();
      expectTypeOf<Update["count"]>().toEqualTypeOf<
        number | undefined | undefined
      >();
    });

    it("should handle value schema with transform in reducer", async () => {
      const AgentState = new StateSchema({
        log: new ReducedValue(
          z
            .array(z.object({ timestamp: z.date(), message: z.string() }))
            .default(() => []),
          {
            inputSchema: z.string(),
            reducer: (
              current: Array<{ timestamp: Date; message: string }>,
              next: string
            ) => [...current, { timestamp: new Date(), message: next }],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode("log_message", () => ({
          log: "Hello world",
        }))
        .addEdge(START, "log_message")
        .addEdge("log_message", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.log).toHaveLength(1);
      expect(result.log[0].message).toBe("Hello world");
      expect(result.log[0].timestamp).toBeInstanceOf(Date);
    });
    describe("input validation", () => {
      it("should validate input against inputSchema on graph invoke", async () => {
        const AgentState = new StateSchema({
          count: new ReducedValue(z.number().default(0), {
            inputSchema: z.number().min(0),
            reducer: (current, next) => current + next,
          }),
        });

        const graph = new StateGraph(AgentState)
          .addNode("add_ten", () => ({
            count: 10,
          }))
          .addEdge(START, "add_ten")
          .addEdge("add_ten", END)
          .compile();

        // Valid input: 0 (default) + 5 (input) + 10 (node) = 15
        const result = await graph.invoke({ count: 5 });
        expect(result.count).toBe(15);

        // Invalid input should throw (negative number violates min(0))
        await expect(graph.invoke({ count: -1 })).rejects.toThrow();
      });

      it("should validate string patterns", async () => {
        const AgentState = new StateSchema({
          emails: new ReducedValue(
            z.array(z.string()).default(() => []),
            {
              inputSchema: z.string().email(),
              reducer: (current: string[], next: string) => [...current, next],
            }
          ),
        });

        const graph = new StateGraph(AgentState)
          .addNode("add_email", () => ({
            emails: "test@example.com",
          }))
          .addEdge(START, "add_email")
          .addEdge("add_email", END)
          .compile();

        // Valid email should work
        const result = await graph.invoke({});
        expect(result.emails).toEqual(["test@example.com"]);

        // Test with invalid email input (this tests if invoke validates)
        await expect(
          graph.invoke({ emails: "not-an-email" })
        ).rejects.toThrow();
      });

      it("should validate complex object inputs", async () => {
        const AgentState = new StateSchema({
          users: new ReducedValue(
            z
              .array(z.object({ id: z.string(), name: z.string() }))
              .default(() => []),
            {
              inputSchema: z.object({
                id: z.string().min(1),
                name: z.string().min(2),
              }),
              reducer: (
                current: Array<{ id: string; name: string }>,
                next: { id: string; name: string }
              ) => [...current, next],
            }
          ),
        });

        const graph = new StateGraph(AgentState)
          .addNode("add_user", () => ({
            users: { id: "1", name: "Alice" },
          }))
          .addEdge(START, "add_user")
          .addEdge("add_user", END)
          .compile();

        const result = await graph.invoke({});
        expect(result.users).toEqual([{ id: "1", name: "Alice" }]);

        // Invalid: empty id
        await expect(
          graph.invoke({ users: { id: "", name: "Bob" } })
        ).rejects.toThrow();

        // Invalid: name too short
        await expect(
          graph.invoke({ users: { id: "2", name: "B" } })
        ).rejects.toThrow();
      });
    });
  });
});
