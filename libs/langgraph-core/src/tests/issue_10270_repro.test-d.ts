/**
 * Reproduction of https://github.com/langchain-ai/langchainjs/issues/10270
 *
 * Two bugs reported:
 * 1. TS2589 ("excessively deep type instantiation") on StateGraph constructor
 *    when using contextSchema (Zod).
 * 2. TS2322 on invoke() — context fields required inside `configurable` instead
 *    of top-level `context`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod/v4";
import { Annotation, StateGraph } from "../index.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

describe("Issue #10270 — StateGraph with contextSchema", () => {
  const contextSchema = z.object({
    userName: z.string(),
    userId: z.string(),
  });
  type Context = z.infer<typeof contextSchema>;

  const GraphAnnotation = Annotation.Root({
    input: Annotation<string>(),
    output: Annotation<string>(),
  });

  it("BUG 1: no TS2589 on StateGraph constructor with Zod contextSchema", () => {
    // This should compile without "Type instantiation is excessively deep"
    const graph = new StateGraph({
      state: GraphAnnotation,
      context: contextSchema,
    })
      .addNode(
        "myNode",
        async (
          _state: typeof GraphAnnotation.State,
          config: LangGraphRunnableConfig<Context>
        ) => {
          const ctx = config.context;
          expectTypeOf(ctx).toEqualTypeOf<Context | undefined>();
          return { output: "done" };
        }
      )
      .addEdge("__start__", "myNode")
      .compile();

    expect(graph).toBeDefined();
  });

  it("BUG 2: invoke() accepts context as top-level key, not in configurable", async () => {
    const graph = new StateGraph({
      state: GraphAnnotation,
      context: contextSchema,
    })
      .addNode("myNode", async () => {
        return { output: "done" };
      })
      .addEdge("__start__", "myNode")
      .compile();

    const context: Context = { userName: "alice", userId: "user1" };

    // This should compile — context is a top-level key, not inside configurable
    await graph.invoke(
      { input: "hello" },
      {
        configurable: { thread_id: "t1" },
        context,
      }
    );

    // configurable should accept arbitrary keys without requiring context fields
    // (runtime will fail Zod validation without context, but types should compile)
    expect(
      graph.invoke(
        { input: "hello" },
        {
          configurable: { thread_id: "t1" },
        }
      )
    ).rejects.toThrow();
  });
});
