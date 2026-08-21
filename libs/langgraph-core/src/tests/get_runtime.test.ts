import { it, expect, describe } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import {
  BaseStore,
  InMemoryStore,
  MemorySaver,
} from "@langchain/langgraph-checkpoint";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
  START,
  END,
  entrypoint,
  task,
} from "../web.js";
import type { Runtime } from "../web.js";
import { ToolNode } from "../prebuilt/tool_node.js";
import { getRuntime } from "../pregel/utils/config.js";
import { gatherIterator } from "../utils.js";

const State = Annotation.Root({
  message: Annotation<string>,
});

const contextSchema = z.object({ user_id: z.string() });

describe("getRuntime", () => {
  it("should project the full runtime inside a node", async () => {
    const store = new InMemoryStore();
    let captured: Runtime | undefined;

    const graph = new StateGraph({ state: State, context: contextSchema })
      .addNode("capture", (_state) => {
        const runtime = getRuntime<{ user_id: string }>();
        captured = runtime;
        // No-op writer/heartbeat defaults must not throw
        runtime.writer({ some: "chunk" });
        runtime.heartbeat?.();
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile({ checkpointer: new MemorySaver(), store });

    await graph.invoke(
      { message: "hi" },
      {
        configurable: { thread_id: "t-1" },
        context: { user_id: "user-1" },
      }
    );

    expect(captured).toBeDefined();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured!.context).toEqual({ user_id: "user-1" });
    // Pregel may wrap the compiled store at run time, so assert the type
    // rather than identity
    expect(captured!.store).toBeInstanceOf(BaseStore);
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
    expect(captured!.executionInfo).toBeDefined();
    expect(captured!.executionInfo!.taskId).toEqual(expect.any(String));
    expect(captured!.executionInfo!.threadId).toBe("t-1");
    expect(captured!.executionInfo!.nodeAttempt).toBe(1);
  });

  it("should pass a real stream writer through", async () => {
    const graph = new StateGraph(State)
      .addNode("emit", () => {
        getRuntime().writer("hello from runtime");
        return { message: "done" };
      })
      .addEdge(START, "emit")
      .addEdge("emit", END)
      .compile();

    const written = await gatherIterator(
      await graph.stream({ message: "hi" }, { streamMode: "custom" })
    );

    expect(written).toEqual(["hello from runtime"]);
  });

  it("should work inside a subgraph node", async () => {
    let captured: Runtime | undefined;

    const child = new StateGraph(State)
      .addNode("child_node", () => {
        captured = getRuntime();
        return { message: "child done" };
      })
      .addEdge(START, "child_node")
      .addEdge("child_node", END)
      .compile();

    const parent = new StateGraph(State)
      .addNode("child", child)
      .addEdge(START, "child")
      .addEdge("child", END)
      .compile({ checkpointer: new MemorySaver() });

    await parent.invoke(
      { message: "hi" },
      { configurable: { thread_id: "t-sub" } }
    );

    expect(captured).toBeDefined();
    expect(captured!.executionInfo?.taskId).toEqual(expect.any(String));
    expect(captured!.configurable?.thread_id).toBe("t-sub");
  });

  it("should work inside a functional API task", async () => {
    let captured: Runtime | undefined;

    const mapper = task("mapper", (input: number) => {
      captured = getRuntime();
      return `${input}${input}`;
    });

    const graph = entrypoint(
      { name: "graph" },
      async (inputs: number[]) => Promise.all(inputs.map((i) => mapper(i)))
    );

    const result = await graph.invoke([1, 2]);
    expect(result).toEqual(["11", "22"]);
    expect(captured).toBeDefined();
    expect(captured!.executionInfo).toBeDefined();
  });

  it("should work inside a tool executed by ToolNode", async () => {
    let captured: Runtime | undefined;

    const echo = tool(
      async () => {
        captured = getRuntime();
        return "ok";
      },
      { name: "echo", description: "Echo tool", schema: z.object({}) }
    );

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", () => ({
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [{ name: "echo", args: {}, id: "call_1" }],
          }),
        ],
      }))
      .addNode("tools", new ToolNode([echo]))
      .addEdge(START, "agent")
      .addEdge("agent", "tools")
      .addEdge("tools", END)
      .compile({ checkpointer: new MemorySaver() });

    const result = await graph.invoke(
      { messages: [] },
      { configurable: { thread_id: "t-tool" } }
    );

    expect(result.messages.at(-1)?.content).toBe("ok");
    // getRuntime() is ambient inside the tool func. The ambient config there
    // is reduced by @langchain/core's tool wrapper to standard
    // RunnableConfig keys, so only configurable/signal/store are guaranteed;
    // the tool's second argument (ToolRuntime) carries the full runtime.
    expect(captured).toBeDefined();
    expect(captured!.configurable?.thread_id).toBe("t-tool");
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
  });

  it("should throw when called outside of an active graph execution", async () => {
    expect(() => getRuntime()).toThrowError(
      /getRuntime\(\) called outside of an active graph execution/
    );

    // Also throws after a run has completed (no ambient config remains)
    const graph = new StateGraph(State)
      .addNode("noop", () => ({ message: "done" }))
      .addEdge(START, "noop")
      .addEdge("noop", END)
      .compile();

    await graph.invoke({ message: "hi" });
    expect(() => getRuntime()).toThrowError(
      /getRuntime\(\) called outside of an active graph execution/
    );
  });
});
