/* eslint-disable no-process-env */
import { describe, test } from "vitest";
import { v4 } from "uuid";
import { RemoteGraph } from "../pregel/remote.js";
import { MemorySaver, MessagesAnnotation, StateGraph } from "../web.js";

describe("RemoteGraph", () => {
  const remotePregel = new RemoteGraph({
    graphId: process.env.LANGGRAPH_REMOTE_GRAPH_ID!,
    apiKey: process.env.LANGGRAPH_REMOTE_GRAPH_API_KEY,
    url: process.env.LANGGRAPH_REMOTE_GRAPH_API_URL,
  });

  const builder = new StateGraph(MessagesAnnotation)
    .addNode("agent", remotePregel)
    .addEdge("__start__", "agent")
    .addEdge("agent", "__end__");
  const input = {
    messages: [
      {
        role: "human",
        content: "Hello world!",
      },
    ],
  };

  const config = {
    configurable: { thread_id: v4() },
  };

  test("invoke", async () => {
    const checkpointer = new MemorySaver();
    const app = builder.compile({ checkpointer });

    const response = await app.invoke(input, config);

    console.log("response:", response);
  });

  test("stream", async () => {
    const checkpointer = new MemorySaver();
    const app = builder.compile({ checkpointer });
    const stream = await app.stream(input, {
      ...config,
      subgraphs: true,
      streamMode: ["debug", "values"],
    });

    for await (const chunk of stream) {
      console.log("chunk:", chunk);
    }
  });

  test("get and update state", async () => {
    const checkpointer = new MemorySaver();
    const app = builder.compile({ checkpointer });

    await app.invoke(input, config);
    // test get state
    const stateSnapshot = await remotePregel.getState(config, {
      subgraphs: true,
    });
    console.log("state snapshot: ", stateSnapshot);

    // test update state
    const updateStateResponse = await remotePregel.updateState(config, {
      messages: [
        {
          role: "ai",
          content: "Hello world again!",
        },
      ],
    });
    console.log("update state response:", updateStateResponse);

    // test get history
    for await (const state of remotePregel.getStateHistory(config)) {
      console.log("state history snapshot:", state);
    }

    // test get graph
    const remotePregel2 = new RemoteGraph({
      graphId: "fe096781-5601-53d2-b2f6-0d3403f7e9ca",
      apiKey: process.env.LANGGRAPH_REMOTE_GRAPH_API_KEY,
      url: process.env.LANGGRAPH_REMOTE_GRAPH_API_URL,
    });

    const graph = await remotePregel2.getGraphAsync({ xray: true });
    console.log("graph:", graph);

    // test get subgraphs
    for await (const [name, pregel] of remotePregel2.getSubgraphsAsync()) {
      console.log("name:", name);
      console.log("pregel:", pregel);
    }
  });
});
