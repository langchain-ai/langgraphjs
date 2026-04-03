/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, describe } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { Annotation, StateGraph } from "../graph/index.js";
import { START, END } from "../constants.js";
import type { ExecutionInfo, Runtime, ServerInfo } from "../web.js";

const State = Annotation.Root({
  message: Annotation<string>,
});

describe("ExecutionInfo", () => {
  it("should populate executionInfo fields when running with a checkpointer", async () => {
    let captured: ExecutionInfo | undefined;

    const graph = new StateGraph(State)
      .addNode("capture", (_state: any, runtime: Runtime) => {
        captured = runtime.executionInfo;
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile({ checkpointer: new MemorySaver() });

    await graph.invoke(
      { message: "hi" },
      { configurable: { thread_id: "t-123" } }
    );

    expect(captured).toBeDefined();
    expect(captured!.threadId).toBe("t-123");
    expect(captured!.taskId).toBeDefined();
    expect(captured!.checkpointId).toBeDefined();
    expect(captured!.checkpointNs).toBeDefined();
    expect(captured!.nodeAttempt).toBe(1);
    expect(typeof captured!.nodeFirstAttemptTime).toBe("number");
  });

  it("should populate executionInfo without a checkpointer (threadId undefined)", async () => {
    let captured: ExecutionInfo | undefined;

    const graph = new StateGraph(State)
      .addNode("capture", (_state: any, runtime: Runtime) => {
        captured = runtime.executionInfo;
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile();

    await graph.invoke({ message: "hi" });

    expect(captured).toBeDefined();
    expect(captured!.threadId).toBeUndefined();
    expect(captured!.taskId).toBeDefined();
    expect(captured!.checkpointId).toBeDefined();
    expect(captured!.nodeAttempt).toBe(1);
  });

  it("should increment nodeAttempt on retry", async () => {
    let attemptCount = 0;
    const capturedInfos: any[] = [];

    const graph = new StateGraph(State)
      .addNode(
        "failing",
        (_state: any, runtime: Runtime) => {
          attemptCount += 1;
          const info = runtime.executionInfo;
          capturedInfos.push({
            threadId: info?.threadId,
            nodeAttempt: info?.nodeAttempt,
            nodeFirstAttemptTime: info?.nodeFirstAttemptTime,
          });
          if (attemptCount < 2) {
            throw new Error("Intentional failure");
          }
          return { message: "success" };
        },
        {
          retryPolicy: {
            maxAttempts: 3,
            initialInterval: 10,
            jitter: false,
          },
        }
      )
      .addEdge(START, "failing")
      .addEdge("failing", END)
      .compile({ checkpointer: new MemorySaver() });

    const result = await graph.invoke(
      { message: "" },
      { configurable: { thread_id: "retry-thread" } }
    );

    expect(result.message).toBe("success");
    expect(capturedInfos.length).toBe(2);

    expect(capturedInfos[0].threadId).toBe("retry-thread");
    expect(capturedInfos[1].threadId).toBe("retry-thread");

    expect(capturedInfos[0].nodeAttempt).toBe(1);
    expect(capturedInfos[1].nodeAttempt).toBe(2);

    expect(capturedInfos[0].nodeFirstAttemptTime).toBe(
      capturedInfos[1].nodeFirstAttemptTime
    );
  });

  it("should populate executionInfo for subgraph nodes", async () => {
    const capturedMain: Record<string, any> = {};
    const capturedSub: Record<string, any> = {};

    const SubState = Annotation.Root({
      message: Annotation<string>,
    });

    const subgraph = new StateGraph(SubState)
      .addNode("sub_node", (_state: any, runtime: Runtime) => {
        capturedSub.executionInfo = runtime.executionInfo;
        return { message: "from_sub" };
      })
      .addEdge(START, "sub_node")
      .addEdge("sub_node", END)
      .compile();

    const graph = new StateGraph(State)
      .addNode("main_node", (_state: any, runtime: Runtime) => {
        capturedMain.executionInfo = runtime.executionInfo;
        return { message: "from_main" };
      })
      .addNode("subgraph", subgraph)
      .addEdge(START, "main_node")
      .addEdge("main_node", "subgraph")
      .addEdge("subgraph", END)
      .compile({ checkpointer: new MemorySaver() });

    await graph.invoke(
      { message: "hi" },
      { configurable: { thread_id: "sub-thread" } }
    );

    const mainInfo = capturedMain.executionInfo as ExecutionInfo;
    const subInfo = capturedSub.executionInfo as ExecutionInfo;

    expect(mainInfo.threadId).toBe("sub-thread");
    expect(subInfo.threadId).toBe("sub-thread");

    expect(mainInfo.nodeAttempt).toBe(1);
    expect(subInfo.nodeAttempt).toBe(1);

    expect(mainInfo.checkpointNs).toContain("main_node:");
    expect(subInfo.checkpointNs).toContain("subgraph:");
    expect(subInfo.checkpointNs).toContain("|sub_node:");
  });
});

describe("ServerInfo", () => {
  it("should build serverInfo from assistant_id/graph_id in config metadata", async () => {
    let captured: ServerInfo | undefined;

    const graph = new StateGraph(State)
      .addNode("capture", (_state: any, runtime: Runtime) => {
        captured = runtime.serverInfo;
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile();

    await graph.invoke(
      { message: "hi" },
      { metadata: { assistant_id: "asst-abc", graph_id: "my-graph" } }
    );

    expect(captured).toBeDefined();
    expect(captured!.assistantId).toBe("asst-abc");
    expect(captured!.graphId).toBe("my-graph");
    expect(captured!.user).toBeUndefined();
  });

  it("should return undefined serverInfo when no metadata present", async () => {
    let captured: ServerInfo | undefined;

    const graph = new StateGraph(State)
      .addNode("capture", (_state: any, runtime: Runtime) => {
        captured = runtime.serverInfo;
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile();

    await graph.invoke({ message: "hi" });

    expect(captured).toBeUndefined();
  });

  it("should populate serverInfo.user from langgraph_auth_user", async () => {
    let captured: ServerInfo | undefined;

    const graph = new StateGraph(State)
      .addNode("capture", (_state: any, runtime: Runtime) => {
        captured = runtime.serverInfo;
        return { message: "done" };
      })
      .addEdge(START, "capture")
      .addEdge("capture", END)
      .compile();

    const proxyUser = {
      identity: "proxy-user",
      display_name: "Proxy User",
      is_authenticated: true,
      permissions: ["read"],
    };

    await graph.invoke(
      { message: "hi" },
      {
        configurable: { langgraph_auth_user: proxyUser },
        metadata: { assistant_id: "asst-proxy", graph_id: "graph-proxy" },
      }
    );

    expect(captured).toBeDefined();
    expect(captured!.assistantId).toBe("asst-proxy");
    expect(captured!.user).toBeDefined();
    expect(captured!.user!.identity).toBe("proxy-user");
    expect(captured!.user!.display_name).toBe("Proxy User");
  });
});
