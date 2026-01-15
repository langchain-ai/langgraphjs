import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod/v4";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { StateSchema } from "./schema.js";
import { ReducedValue, UntrackedValue } from "./values/index.js";
import { MessagesValue } from "./prebuilt/index.js";
import {
  BinaryOperatorAggregate,
  LastValue,
  UntrackedValueChannel,
} from "../channels/index.js";
import { StateGraph } from "../graph/index.js";
import { Command, END, Send, START } from "../constants.js";

describe("StateSchema", () => {
  describe("type inference", () => {
    describe("plain schemas", () => {
      it("should infer State type correctly", () => {
        const AgentState = new StateSchema({
          name: z.string(),
          count: z.number(),
          active: z.boolean().default(false),
        });

        type MyState = typeof AgentState.State;

        // Verify state type is an object
        expectTypeOf<MyState>().toBeObject();
      });

      it("should infer Update type correctly (all optional)", () => {
        const AgentState = new StateSchema({
          name: z.string(),
          count: z.number(),
        });

        type MyUpdate = typeof AgentState.Update;

        // Verify update type is an object
        expectTypeOf<MyUpdate>().toBeObject();
      });
    });

    describe("ReducedValue types", () => {
      it("should infer different value vs update types", () => {
        const state = new StateSchema({
          // Note: Type assertions needed due to complex generic inference
          items: new ReducedValue(
            z.array(z.string()).default(() => []),
            {
              inputSchema: z.string(),
              reducer: (current: string[], next: string) => [...current, next],
            }
          ),
        });

        type MyState = typeof state.State;
        type MyUpdate = typeof state.Update;

        // Verify types exist
        expectTypeOf<MyState>().toBeObject();
        expectTypeOf<MyUpdate>().toBeObject();
      });

      it("should use value schema when input schema not provided", () => {
        const state = new StateSchema({
          // For z.number().default(0): output is `number`, input is `number | undefined`
          // because you can pass undefined and get the default
          count: new ReducedValue(z.number().default(0), {
            reducer: (a, b) => a + (b ?? 0),
          }),
        });

        // Verify types exist
        type MyState = typeof state.State;
        type MyUpdate = typeof state.Update;

        expectTypeOf<MyState>().toBeObject();
        expectTypeOf<MyUpdate>().toBeObject();
      });
    });

    describe("UntrackedValue types", () => {
      it("should infer types from schema", () => {
        const state = new StateSchema({
          temp: new UntrackedValue(z.string()),
        });

        type MyState = typeof state.State;
        type MyUpdate = typeof state.Update;

        expectTypeOf<MyState>().toBeObject();
        expectTypeOf<MyUpdate>().toBeObject();
      });
    });

    describe("type helper utilities", () => {
      it("State type is accessible", () => {
        const AgentState = new StateSchema({
          name: z.string(),
          count: z.number(),
        });

        type MyState = typeof AgentState.State;

        expectTypeOf<MyState>().toBeObject();
      });

      it("Update type is accessible", () => {
        const AgentState = new StateSchema({
          name: z.string(),
          count: z.number(),
        });

        type MyUpdate = typeof AgentState.Update;

        expectTypeOf<MyUpdate>().toBeObject();
      });
    });

    describe("mixed state definition", () => {
      it("should handle complex mixed state", () => {
        const ComplexState = new StateSchema({
          // Plain schema
          query: z.string(),
          // Schema with default
          retryCount: z.number().default(0),
          // ReducedValue with different input/output types
          history: new ReducedValue(
            z.array(z.string()).default(() => []),
            {
              inputSchema: z.string(),
              reducer: (current: string[], next: string) => [...current, next],
            }
          ),
          // UntrackedValue
          cacheKey: new UntrackedValue(z.string().optional()),
        });

        type MyState = typeof ComplexState.State;
        type MyUpdate = typeof ComplexState.Update;

        // Verify types compile successfully
        expectTypeOf<MyState>().toBeObject();
        expectTypeOf<MyUpdate>().toBeObject();

        // Basic type checks for simple schemas
        expectTypeOf<MyState["query"]>().toEqualTypeOf<string>();
        expectTypeOf<MyState["retryCount"]>().toEqualTypeOf<number>();
      });
    });

    it("should preserve State and Update types through compilation", async () => {
      const AgentState = new StateSchema({
        count: z.number().default(0),
        name: z.string(),
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      // Verify state type has correct structure
      expectTypeOf<typeof AgentState.State>().toMatchTypeOf<{
        count: number;
        name: string;
        items: string[];
      }>();

      // Update type should have optional fields
      expectTypeOf<typeof AgentState.Update>().toMatchTypeOf<{
        count?: number | undefined;
        name?: string | undefined;
        items?: string | undefined;
      }>();

      const graph = new StateGraph(AgentState)
        .addNode("node", (s) => {
          // Node receives State type
          expectTypeOf(s.count).toEqualTypeOf<number>();
          expectTypeOf(s.name).toEqualTypeOf<string>();
          expectTypeOf(s.items).toEqualTypeOf<string[]>();
          return { count: s.count + 1 };
        })
        .addEdge(START, "node")
        .addEdge("node", END)
        .compile();

      // invoke should accept Update type (partial)
      const result = await graph.invoke({ name: "test" });

      // Result should be State type
      expectTypeOf(result).toMatchTypeOf<typeof AgentState.State>();
      expectTypeOf(result.count).toEqualTypeOf<number>();
      expectTypeOf(result.name).toEqualTypeOf<string>();
      expectTypeOf(result.items).toEqualTypeOf<string[]>();

      expect(result.count).toBe(1);
      expect(result.name).toBe("test");
      expect(result.items).toEqual([]);
    });
  });

  describe("constructor", () => {
    it("should create a StateSchema with plain schemas", () => {
      const state = new StateSchema({
        name: z.string(),
        count: z.number().default(0),
      });

      expect(StateSchema.isInstance(state)).toBe(true);
      expect(state.getAllKeys()).toEqual(["name", "count"]);
    });

    it("should create a StateSchema with ReducedValue", () => {
      const state = new StateSchema({
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      expect(StateSchema.isInstance(state)).toBe(true);
      expect(state.getChannelKeys()).toEqual(["items"]);
    });

    it("should create a StateSchema with UntrackedValue", () => {
      const state = new StateSchema({
        temp: new UntrackedValue(z.string()),
      });

      expect(StateSchema.isInstance(state)).toBe(true);
      expect(state.getChannelKeys()).toEqual(["temp"]);
    });

    it("should create a StateSchema with MessagesValue", () => {
      const state = new StateSchema({
        messages: MessagesValue,
      });

      expect(StateSchema.isInstance(state)).toBe(true);
      expect(ReducedValue.isInstance(MessagesValue)).toBe(true);
    });
  });

  describe("getChannels", () => {
    it("should return LastValue channels for plain schemas", () => {
      const state = new StateSchema({
        name: z.string(),
        count: z.number().default(0),
      });

      const channels = state.getChannels();

      expect(channels.name).toBeInstanceOf(LastValue);
      expect(channels.count).toBeInstanceOf(LastValue);
    });

    it("should return BinaryOperatorAggregate for ReducedValue", () => {
      const state = new StateSchema({
        items: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      const channels = state.getChannels();

      expect(channels.items).toBeInstanceOf(BinaryOperatorAggregate);
    });

    it("should return UntrackedValueChannel for UntrackedValue", () => {
      const state = new StateSchema({
        temp: new UntrackedValue(z.string()),
      });

      const channels = state.getChannels();

      expect(channels.temp).toBeInstanceOf(UntrackedValueChannel);
    });
  });

  describe("JSON schema generation", () => {
    it("should generate JSON schema for simple state", () => {
      const state = new StateSchema({
        name: z.string(),
        count: z.number().default(0),
      });

      const schema = state.getJsonSchema() as {
        type: string;
        properties?: Record<string, unknown>;
      };

      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
      // Note: JSON schema generation requires StandardJSONSchema support
    });
  });

  describe("StateGraph integration", () => {
    it("should accept StateSchema in constructor", async () => {
      const AgentState = new StateSchema({
        count: z.number().default(0),
      });

      const graph = new StateGraph(AgentState)
        .addNode("increment", (state) => ({
          count: state.count + 1,
        }))
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.count).toBe(1);
    });

    it("should work with ReducedValue", async () => {
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
        .addNode("add", () => ({ items: "item1" }))
        .addEdge(START, "add")
        .addEdge("add", END)
        .compile();

      const result = await graph.invoke({});
      expect(result.items).toEqual(["item1"]);
    });

    it("should work with MessagesValue", async () => {
      const AgentState = new StateSchema({
        messages: MessagesValue,
      });

      const graph = new StateGraph(AgentState)
        .addNode("respond", () => ({
          messages: { role: "assistant", content: "Hello!" },
        }))
        .addEdge(START, "respond")
        .addEdge("respond", END)
        .compile();

      const result = (await graph.invoke({
        messages: [{ role: "user", content: "Hi" }],
      })) as { messages: Array<{ content: string }> };

      expect(result.messages.length).toBe(2);
      expect(result.messages[1].content).toBe("Hello!");
    });

    it("should validate input using StateSchema validation", async () => {
      const AgentState = new StateSchema({
        name: z.string(),
        count: z.number().default(0),
      });

      const graph = new StateGraph(AgentState)
        .addNode("process", (state) => ({
          count: state.count + 1,
        }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      // Valid input should work
      const result = await graph.invoke({ name: "test" });
      expect(result.count).toBe(1);
      expect(result.name).toBe("test");
    });

    it("should initialize channels with defaults", async () => {
      const AgentState = new StateSchema({
        count: z.number().default(42),
        items: z.array(z.string()).default(() => ["default"]),
        name: z.string(), // No default
      });

      const channels = AgentState.getChannels();

      // Check that LastValue channels have correct initial values
      const countChannel = channels.count as LastValue<number>;
      const itemsChannel = channels.items as LastValue<string[]>;
      const nameChannel = channels.name as LastValue<string>;

      // Channels with defaults should be available
      expect(countChannel.isAvailable()).toBe(true);
      expect(countChannel.get()).toBe(42);

      expect(itemsChannel.isAvailable()).toBe(true);
      expect(itemsChannel.get()).toEqual(["default"]);

      // Channel without default should not be available
      expect(nameChannel.isAvailable()).toBe(false);
    });

    it("should use ReducedValue defaults", async () => {
      const AgentState = new StateSchema({
        sum: new ReducedValue(z.number().default(100), {
          reducer: (a, b) => a + b,
        }),
      });

      const channels = AgentState.getChannels();
      const sumChannel = channels.sum as BinaryOperatorAggregate<
        number,
        number
      >;

      expect(sumChannel.isAvailable()).toBe(true);
      expect(sumChannel.get()).toBe(100);
    });
    it("should work with basic Command for goto", async () => {
      const AgentState = new StateSchema({
        value: z.string().default(""),
        visited: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      const graph = new StateGraph(AgentState)
        .addNode(
          "a",
          () =>
            new Command({
              update: { value: "from_a", visited: "a" },
              goto: "b",
            }),
          { ends: ["b", "c"] } // Required when using Command with goto
        )
        .addNode("b", () => ({ value: "from_b", visited: "b" }))
        .addNode("c", () => ({ value: "from_c", visited: "c" }))
        .addEdge(START, "a")
        .addEdge("b", END)
        .addEdge("c", END)
        .compile();

      const result = await graph.invoke({});

      expect(result.value).toBe("from_b");
      expect(result.visited).toEqual(["a", "b"]);
    });

    it("should work with Command.update containing ReducedValue inputs", async () => {
      const AgentState = new StateSchema({
        messages: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      const checkpointer = new MemorySaver();
      const graph = new StateGraph(AgentState)
        .addNode(
          "agent",
          () =>
            new Command({
              update: { messages: "agent response" },
            })
        )
        .addEdge(START, "agent")
        .addEdge("agent", END)
        .compile({ checkpointer });

      const config = { configurable: { thread_id: "1" } };
      const result = await graph.invoke({ messages: "user input" }, config);

      expect(result.messages).toEqual(["user input", "agent response"]);
    });

    it("should work with interruptBefore and resume", async () => {
      const AgentState = new StateSchema({
        step: z.number().default(0),
        data: z.string().default(""),
      });

      const checkpointer = new MemorySaver();
      const graph = new StateGraph(AgentState)
        .addNode("step1", () => {
          return { step: 1 };
        })
        .addNode("step2", () => {
          // Check for resume value passed via config
          return { step: 2, data: "step2_done" };
        })
        .addNode("step3", () => ({ step: 3 }))
        .addEdge(START, "step1")
        .addEdge("step1", "step2")
        .addEdge("step2", "step3")
        .addEdge("step3", END)
        .compile({
          checkpointer,
          interruptBefore: ["step2"],
        });

      const config = { configurable: { thread_id: "1" } };

      // First invocation - should interrupt before step2
      const result1 = await graph.invoke({}, config);
      expect(result1.step).toBe(1);

      // Resume execution (passing null to continue)
      const result2 = await graph.invoke(null, config);

      expect(result2.step).toBe(3);
      expect(result2.data).toBe("step2_done");
    });

    it("should work with Send for fan-out patterns via conditional edges", async () => {
      const AgentState = new StateSchema({
        tasks: z.array(z.string()).default(() => []),
        results: new ReducedValue(
          z.array(z.string()).default(() => []),
          {
            inputSchema: z.string(),
            reducer: (current: string[], next: string) => [...current, next],
          }
        ),
      });

      // Send should be returned from conditional edges, not from nodes
      // Note: The state passed in Send is used as input state for that node invocation,
      // but values passed through Send are NOT accumulated via the reducer -
      // only the node's return values are accumulated.
      const fanOut = (state: typeof AgentState.State) => {
        return state.tasks.map(
          (task) => new Send("process", { tasks: [task], results: task })
        );
      };

      const graph = new StateGraph(AgentState)
        .addNode("process", (state) => ({
          results: `processed:${state.tasks[0]}`,
        }))
        .addConditionalEdges(START, fanOut, ["process"])
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({
        tasks: ["task1", "task2", "task3"],
      });

      // Only the node return values are accumulated (not the Send input values)
      expect(result.results).toHaveLength(3);
      expect(result.results).toContain("processed:task1");
      expect(result.results).toContain("processed:task2");
      expect(result.results).toContain("processed:task3");
    });

    it("should validate Command.update against inputSchema", async () => {
      const AgentState = new StateSchema({
        count: new ReducedValue(z.number().default(0), {
          inputSchema: z.number().min(0),
          reducer: (a, b) => a + b,
        }),
      });

      const graph = new StateGraph(AgentState)
        .addNode("noop", () => ({}))
        .addEdge(START, "noop")
        .addEdge("noop", END)
        .compile();

      // Valid Command update should work
      const result = await graph.invoke(new Command({ update: { count: 5 } }));
      expect(result.count).toBe(5);

      // Invalid Command update should throw
      await expect(
        graph.invoke(new Command({ update: { count: -1 } }))
      ).rejects.toThrow();
    });

    describe("Mixed schema types", () => {
      it("should handle MessagesValue with other ReducedValues", async () => {
        const AgentState = new StateSchema({
          messages: MessagesValue,
          toolCalls: new ReducedValue(
            z.array(z.string()).default(() => []),
            {
              inputSchema: z.string(),
              reducer: (current: string[], next: string) => [...current, next],
            }
          ),
          currentAgent: z.string().default("assistant"),
        });

        const graph = new StateGraph(AgentState)
          .addNode("agent", () => ({
            messages: { role: "assistant", content: "Hello!" },
            toolCalls: "search",
            currentAgent: "search_agent",
          }))
          .addEdge(START, "agent")
          .addEdge("agent", END)
          .compile();

        const result = await graph.invoke({
          messages: [{ role: "user", content: "Hi" }],
        });

        expect(result.messages).toHaveLength(2);
        expect(result.toolCalls).toEqual(["search"]);
        expect(result.currentAgent).toBe("search_agent");
      });

      it("should handle UntrackedValue with ReducedValue", async () => {
        const AgentState = new StateSchema({
          cache: new UntrackedValue<Record<string, string>>(
            z.record(z.string(), z.string())
          ),
          results: new ReducedValue(
            z.array(z.string()).default(() => []),
            {
              inputSchema: z.string(),
              reducer: (current: string[], next: string) => [...current, next],
            }
          ),
        });

        const checkpointer = new MemorySaver();
        const graph = new StateGraph(AgentState)
          .addNode("process", () => ({
            cache: { key: "value" },
            results: "result1",
          }))
          .addEdge(START, "process")
          .addEdge("process", END)
          .compile({ checkpointer });

        const config = { configurable: { thread_id: "1" } };
        const result = await graph.invoke({}, config);

        expect(result.results).toEqual(["result1"]);
        expect(result.cache).toEqual({ key: "value" });

        // After checkpoint restore, UntrackedValue should be reset
        const state = await graph.getState(config);
        expect(state.values.cache).toBeUndefined();
      });
    });
  });

  describe("error handling", () => {
    it("should throw on invalid field type", () => {
      const invalidSchema = new StateSchema({
        // Invalid: plain object is not a valid field type
        invalid: { notASchema: true } as never,
      });

      expect(() => invalidSchema.getChannels()).toThrow(
        /Invalid state field "invalid"/
      );
    });

    it("should provide helpful error for validation failures", async () => {
      const AgentState = new StateSchema({
        email: z.string().email(),
      });

      const graph = new StateGraph(AgentState)
        .addNode("noop", () => ({}))
        .addEdge(START, "noop")
        .addEdge("noop", END)
        .compile();

      await expect(graph.invoke({ email: "not-valid" })).rejects.toThrow(
        /email/i
      );
    });
  });

  describe("key utilities", () => {
    it("getAllKeys returns all keys in order", () => {
      const state = new StateSchema({
        a: z.string(),
        b: new UntrackedValue(),
        c: z.number(),
      });

      expect(state.getAllKeys()).toEqual(["a", "b", "c"]);
    });

    it("getChannelKeys returns all channel keys", () => {
      const state = new StateSchema({
        channel1: z.string(),
        channel2: new UntrackedValue(),
        channel3: z.number(),
      });

      expect(state.getChannelKeys()).toEqual([
        "channel1",
        "channel2",
        "channel3",
      ]);
    });
  });
});
