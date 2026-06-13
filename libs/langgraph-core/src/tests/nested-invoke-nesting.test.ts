import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { StateGraph } from "../graph/index.js";
import { END, START } from "../constants.js";
import { StateSchema } from "../state/schema.js";
import { ReducedValue } from "../state/values/reduced.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type { ProtocolEvent } from "../stream/types.js";

const State = new StateSchema({
  value: new ReducedValue(z.string().default(() => ""), {
    reducer: (_a: string, b: string) => b,
  }),
});

/**
 * Regression tests for nesting preservation when a compiled graph is invoked
 * imperatively from inside another graph's running task.
 *
 * Historically, passing an explicit `configurable` to the nested `invoke()`
 * (as `createAgent`/`ReactAgent` does via its default config) caused
 * langchain-core's `ensureConfig` to replace the ambient `configurable`
 * wholesale, dropping the langgraph-internal nesting keys (`__pregel_read`,
 * `checkpoint_ns`, ...). The nested run was then treated as a fresh root run
 * and its streamed events were flattened to the root namespace.
 */
describe("nested imperative invoke nesting", () => {
  function buildChild(captured: { ns?: string }) {
    return new StateGraph(State)
      .addNode("child_node", async (_s, config?: LangGraphRunnableConfig) => {
        captured.ns = config?.configurable?.checkpoint_ns as string | undefined;
        return { value: "child-done" };
      })
      .addEdge(START, "child_node")
      .addEdge("child_node", END)
      .compile({ name: "Child" });
  }

  it("nests the child checkpoint_ns when invoked WITH an explicit configurable", async () => {
    const captured: { ns?: string } = {};
    const child = buildChild(captured);

    const parent = new StateGraph(State)
      .addNode("parent_node", async () => {
        // Mirrors ReactAgent.invoke: pass an explicit `configurable` that does
        // NOT carry the langgraph-internal nesting keys.
        await child.invoke(
          { value: "go" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { configurable: { ls_agent_type: "weather" } } as any
        );
        return { value: "parent-done" };
      })
      .addEdge(START, "parent_node")
      .addEdge("parent_node", END)
      .compile({ name: "Parent" });

    await parent.invoke({ value: "input" });

    expect(captured.ns).toBeDefined();
    // Must nest under the triggering task, not run at the root namespace.
    expect(captured.ns).toContain("parent_node:");
    expect(captured.ns).toContain("|child_node:");
  });

  it("surfaces the child's streamed events nested under the triggering task", async () => {
    const captured: { ns?: string } = {};
    const child = buildChild(captured);

    const parent = new StateGraph(State)
      .addNode("parent_node", async () => {
        await child.invoke(
          { value: "go" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { configurable: { ls_agent_type: "weather" } } as any
        );
        return { value: "parent-done" };
      })
      .addEdge(START, "parent_node")
      .addEdge("parent_node", END)
      .compile({ name: "Parent" });

    const run = await parent.streamEvents({ value: "input" }, { version: "v3" });
    const events: ProtocolEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }

    // The child's events must appear under the parent_node task namespace,
    // never at the root namespace as siblings of the parent's own events.
    const childTasks = events.filter(
      (e) =>
        e.method === "tasks" &&
        e.params.namespace.length === 1 &&
        e.params.namespace[0].startsWith("parent_node:")
    );
    expect(childTasks.length).toBeGreaterThan(0);
  });
});
