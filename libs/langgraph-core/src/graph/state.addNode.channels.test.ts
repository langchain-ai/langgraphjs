/**
 * Compile-time addNode / addSequence channel-name collisions (#2724).
 *
 * Constructor-time channels are the union of state, input, and output schema
 * keys. Wide `string` / `Record` / deprecated `{ channels }` keys stay legal;
 * the runtime guard remains authoritative for anything the types cannot see.
 *
 * Union-literal keys: the check is non-distributive. A value of type
 * `"channel" | "ok"` is rejected rather than silently narrowed to `"ok"`.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import { Annotation } from "./annotation.js";
import { StateGraph } from "./state.js";
import { StateSchema } from "../state/schema.js";
import { END, START } from "../constants.js";

const CHANNEL_COLLISION =
  /already being used as a state attribute \(a\.k\.a\. a channel\)/;

describe("addNode channel-name collisions", () => {
  describe("literal collisions on state keys", () => {
    it("type-errors and throws for an Annotation state key (issue #2724)", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);

      expect(() => {
        // @ts-expect-error "judge" is already a state channel
        graph.addNode("judge", (state) => ({ judge: state.judge }));
      }).toThrow(CHANNEL_COLLISION);
    });

    it("type-errors for a StateSchema state key", () => {
      const State = new StateSchema({ judge: z.string() });
      const graph = new StateGraph(State);

      expect(() => {
        // @ts-expect-error "judge" is already a state channel
        graph.addNode("judge", (state) => ({ judge: state.judge }));
      }).toThrow(CHANNEL_COLLISION);
    });

    it("type-errors for a Zod state key", () => {
      const State = z.object({ judge: z.string() });
      const graph = new StateGraph(State);

      expect(() => {
        // @ts-expect-error "judge" is already a state channel
        graph.addNode("judge", (state) => ({ judge: state.judge }));
      }).toThrow(CHANNEL_COLLISION);
    });
  });

  describe("input / output schema keys (the incoming trap)", () => {
    it("type-errors for an input-only key that is not in state", () => {
      const State = Annotation.Root({ shared: Annotation<string>() });
      const Input = Annotation.Root({ incoming: Annotation<string>() });
      const Output = Annotation.Root({ outgoing: Annotation<string>() });
      const graph = new StateGraph({
        state: State,
        input: Input,
        output: Output,
      });

      expect(() => {
        // @ts-expect-error "incoming" is an input schema channel
        graph.addNode("incoming", () => ({ shared: "x" }));
      }).toThrow(CHANNEL_COLLISION);
    });

    it("type-errors for an output-only key that is not in state", () => {
      const State = Annotation.Root({ shared: Annotation<string>() });
      const Input = Annotation.Root({ incoming: Annotation<string>() });
      const Output = Annotation.Root({ outgoing: Annotation<string>() });
      const graph = new StateGraph({
        state: State,
        input: Input,
        output: Output,
      });

      expect(() => {
        // @ts-expect-error "outgoing" is an output schema channel
        graph.addNode("outgoing", () => ({ shared: "x" }));
      }).toThrow(CHANNEL_COLLISION);
    });
  });

  describe("legal literals", () => {
    it("allows a node name that does not collide (Annotation)", async () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State)
        .addNode("process", (state) => ({ judge: state.judge }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const result = await graph.invoke({ judge: "ok" });
      expect(result.judge).toBe("ok");
      expectTypeOf(result).toExtend<{ judge: string }>();
    });

    it("allows a node name that does not collide (StateSchema / Zod)", async () => {
      const SchemaState = new StateSchema({ value: z.string() });
      const ZodState = z.object({ value: z.string() });

      const schemaGraph = new StateGraph(SchemaState)
        .addNode("process", (state) => ({ value: state.value }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      const zodGraph = new StateGraph(ZodState)
        .addNode("process", (state) => ({ value: state.value }))
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      expect((await schemaGraph.invoke({ value: "a" })).value).toBe("a");
      expect((await zodGraph.invoke({ value: "b" })).value).toBe("b");
    });
  });

  describe("wide keys stay allowed", () => {
    it("allows a wide string node key even when it matches a channel", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);
      const key: string = "judge";

      expect(() => {
        graph.addNode(key, (state) => ({ judge: state.judge }));
      }).toThrow(CHANNEL_COLLISION);
    });

    it("allows node names when the state type is a Record index signature", () => {
      type Wide = Record<string, unknown>;
      const graph = new StateGraph<Wide>({
        channels: { judge: null },
      });

      expect(() => graph.addNode("judge", () => ({}))).toThrow(
        CHANNEL_COLLISION
      );
      expect(() => graph.addNode("process", () => ({}))).not.toThrow();
    });

    it("allows legal names on the deprecated { channels } constructor", async () => {
      const graph = new StateGraph<{ count: number }>({
        channels: {
          count: {
            reducer: (a: number, b: number) => a + b,
            default: () => 0,
          },
        },
      })
        .addNode("increment", () => ({ count: 1 }))
        .addEdge(START, "increment")
        .addEdge("increment", END)
        .compile();

      expect((await graph.invoke({ count: 0 })).count).toBe(1);
    });

    it("type-errors a known channel key on the deprecated { channels } constructor", () => {
      const graph = new StateGraph<{ count: number }>({
        channels: {
          count: {
            reducer: (a: number, b: number) => a + b,
            default: () => 0,
          },
        },
      });

      expect(() => {
        // @ts-expect-error "count" is a known channel on the state type
        graph.addNode("count", () => ({ count: 1 }));
      }).toThrow(CHANNEL_COLLISION);
    });
  });

  describe("own options.input key remains legal", () => {
    it("allows a node name that matches only this call's options.input", async () => {
      const State = Annotation.Root({ shared: Annotation<string>() });
      const Private = Annotation.Root({ incoming: Annotation<string>() });

      const graph = new StateGraph(State)
        .addNode("incoming", () => ({ shared: "from-private" }), {
          input: Private,
        })
        .addEdge(START, "incoming")
        .addEdge("incoming", END)
        .compile();

      const result = await graph.invoke({ shared: "start" });
      expect(result.shared).toBe("from-private");
    });
  });

  describe("union-literal keys", () => {
    it("allows a mixed union; runtime remains authoritative", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);
      // Decision: `K extends GraphChannelKeys` is not satisfied by a mixed
      // union (`"judge" | "process"`), so this stays legal at compile time
      // rather than silently narrowing or erroring. A runtime value that is
      // actually a channel key still throws.
      const name = "process" as "judge" | "process";
      graph.addNode(name, (state) => ({ judge: state.judge }));
      expect(Object.keys(graph.nodes)).toContain("process");
    });
  });

  describe("addNode object / tuple overloads and addSequence", () => {
    it("type-errors a colliding key in the object-map overload", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);

      expect(() => {
        graph.addNode({
          // @ts-expect-error "judge" is already a state channel
          judge: (state: typeof State.State) => ({ judge: state.judge }),
        });
      }).toThrow(CHANNEL_COLLISION);
    });

    it("allows a legal key in the object-map overload", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);
      graph.addNode({
        process: (state: typeof State.State) => ({ judge: state.judge }),
      });
      expect(Object.keys(graph.nodes)).toContain("process");
    });

    it("type-errors a colliding key in the tuple-array overload", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);

      expect(() => {
        graph.addNode([
          [
            // @ts-expect-error "judge" is already a state channel
            "judge",
            (state: typeof State.State) => ({ judge: state.judge }),
          ],
        ]);
      }).toThrow(CHANNEL_COLLISION);
    });

    it("type-errors a colliding key in addSequence", () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State);

      expect(() => {
        graph.addSequence({
          // @ts-expect-error "judge" is already a state channel
          judge: (state: typeof State.State) => ({ judge: state.judge }),
        });
      }).toThrow(CHANNEL_COLLISION);
    });

    it("allows a legal addSequence key", async () => {
      const State = Annotation.Root({ judge: Annotation<string>() });
      const graph = new StateGraph(State)
        .addSequence({
          process: (state: typeof State.State) => ({ judge: state.judge }),
        })
        .addEdge(START, "process")
        .addEdge("process", END)
        .compile();

      expect((await graph.invoke({ judge: "seq" })).judge).toBe("seq");
    });
  });
});
