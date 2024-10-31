/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from "@jest/globals";
import { Client } from "@langchain/langgraph-sdk";
import { RemoteGraph } from "../pregel/remote.js";
import { gatherIterator } from "../utils.js";
import { INTERRUPT } from "../constants.js";
import { GraphInterrupt } from "../errors.js";

describe("RemoteGraph", () => {
  test("withConfig", () => {
    // set up test
    const remotePregel = new RemoteGraph({
      graphId: "test_graph_id",
      config: {
        configurable: {
          foo: "bar",
          threadId: "thread_id_1",
        },
      },
      client: new Client(),
    });

    // call method / assertions
    const config = { configurable: { hello: "world" } };
    const remotePregelCopy = remotePregel.withConfig(config);

    // assert that a copy was returned
    expect(remotePregelCopy).not.toBe(remotePregel);
    // assert that configs were merged
    expect(remotePregelCopy.config).toEqual({
      configurable: {
        foo: "bar",
        threadId: "thread_id_1",
        hello: "world",
      },
    });
  });

  test("getGraph", async () => {
    const client = new Client({});
    jest.spyOn((client as any).assistants, "getGraph").mockResolvedValue({
      nodes: [
        { id: "__start__", type: "schema", data: "__start__" },
        { id: "__end__", type: "schema", data: "__end__" },
        {
          id: "agent",
          type: "runnable",
          data: {
            id: ["langgraph", "utils", "RunnableCallable"],
            name: "agent",
          },
        },
      ],
      edges: [
        { source: "__start__", target: "agent" },
        { source: "agent", target: "__end__" },
      ],
    });
    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });
    const drawableGraph = await remotePregel.getGraphAsync();
    expect(drawableGraph.nodes).toEqual({
      __start__: {
        id: "__start__",
        name: "__start__",
        data: "__start__",
        metadata: {},
      },
      __end__: {
        id: "__end__",
        name: "__end__",
        data: "__end__",
        metadata: {},
      },
      agent: {
        id: "agent",
        name: "agent",
        data: {
          id: ["langgraph", "utils", "RunnableCallable"],
          name: "agent",
        },
        metadata: {},
      },
    });
    expect(drawableGraph.edges).toEqual([
      { source: "__start__", target: "agent" },
      { source: "agent", target: "__end__" },
    ]);
  });

  test("getSubgraphs", async () => {
    const client = new Client({});
    jest.spyOn((client as any).assistants, "getSubgraphs").mockResolvedValue({
      namespace_1: {
        graph_id: "test_graph_id_2",
        input_schema: {},
        output_schema: {},
        state_schema: {},
        config_schema: {},
      },
      namespace_2: {
        graph_id: "test_graph_id_3",
        input_schema: {},
        output_schema: {},
        state_schema: {},
        config_schema: {},
      },
    });
    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });
    const subgraphs = await gatherIterator(remotePregel.getSubgraphsAsync());
    expect(subgraphs.length).toEqual(2);

    const subgraph1 = subgraphs[0];
    const namespace1 = subgraph1[0];
    const remotePregel1 = subgraph1[1] as RemoteGraph;
    expect(namespace1).toEqual("namespace_1");
    expect(remotePregel1.graphId).toEqual("test_graph_id_2");

    const subgraph2 = subgraphs[1];
    const namespace2 = subgraph2[0];
    const remotePregel2 = subgraph2[1] as RemoteGraph;
    expect(namespace2).toEqual("namespace_2");
    expect(remotePregel2.graphId).toEqual("test_graph_id_3");
  });

  test("getState", async () => {
    const client = new Client({});
    jest.spyOn((client as any).threads, "getState").mockResolvedValue({
      values: { messages: [{ type: "human", content: "hello" }] },
      next: undefined,
      checkpoint: {
        thread_id: "thread_1",
        checkpoint_ns: "ns",
        checkpoint_id: "checkpoint_1",
        checkpoint_map: {},
      },
      metadata: {},
      created_at: "timestamp",
      parent_checkpoint: undefined,
      tasks: [],
    });

    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });

    const config = { configurable: { thread_id: "thread1" } };

    const stateSnapshot = await remotePregel.getState(config);

    expect(stateSnapshot).toEqual({
      values: { messages: [{ type: "human", content: "hello" }] },
      next: [],
      config: {
        configurable: {
          thread_id: "thread_1",
          checkpoint_ns: "ns",
          checkpoint_id: "checkpoint_1",
          checkpoint_map: {},
        },
      },
      metadata: {},
      createdAt: "timestamp",
      parentConfig: undefined,
      tasks: [],
    });
  });

  test("getStateHistory", async () => {
    const client = new Client({});
    jest.spyOn((client as any).threads, "getHistory").mockResolvedValue([
      {
        values: { messages: [{ type: "human", content: "hello" }] },
        next: undefined,
        checkpoint: {
          thread_id: "thread_1",
          checkpoint_ns: "ns",
          checkpoint_id: "checkpoint_1",
          checkpoint_map: {},
        },
        metadata: {},
        created_at: "timestamp",
        parent_checkpoint: undefined,
        tasks: [],
      },
    ]);

    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });
    const config = { configurable: { thread_id: "thread1" } };
    const stateHistorySnapshots = await gatherIterator(
      remotePregel.getStateHistory(config)
    );

    expect(stateHistorySnapshots.length).toEqual(1);

    expect(stateHistorySnapshots[0]).toEqual({
      values: { messages: [{ type: "human", content: "hello" }] },
      next: [],
      config: {
        configurable: {
          thread_id: "thread_1",
          checkpoint_ns: "ns",
          checkpoint_id: "checkpoint_1",
          checkpoint_map: {},
        },
      },
      metadata: {},
      createdAt: "timestamp",
      parentConfig: undefined,
      tasks: [],
    });
  });

  test("updateState", async () => {
    const client = new Client({});
    jest.spyOn((client as any).threads, "updateState").mockResolvedValue({
      checkpoint: {
        thread_id: "thread_1",
        checkpoint_ns: "ns",
        checkpoint_id: "checkpoint_1",
        checkpoint_map: {},
      },
    });

    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });

    const config = { configurable: { thread_id: "thread1" } };

    const response = await remotePregel.updateState(config, { key: "value" });

    expect(response).toEqual({
      configurable: {
        thread_id: "thread_1",
        checkpoint_ns: "ns",
        checkpoint_id: "checkpoint_1",
        checkpoint_map: {},
      },
    });
  });

  test("stream", async () => {
    const client = new Client({});
    jest
      .spyOn((client as any).runs, "stream")
      .mockImplementation(async function* () {
        const chunks = [
          { event: "values", data: { chunk: "data1" } },
          { event: "values", data: { chunk: "data2" } },
          { event: "values", data: { chunk: "data3" } },
          { event: "updates", data: { chunk: "data4" } },
          { event: "updates", data: { [INTERRUPT]: [] } },
        ];
        for (const chunk of chunks) {
          yield chunk;
        }
      });

    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });

    const config = { configurable: { thread_id: "thread_1" } };

    let parts = [];
    let error;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, streamMode: "values" }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      { chunk: "data1" },
      { chunk: "data2" },
      { chunk: "data3" },
    ]);

    jest
      .spyOn((client as any).runs, "stream")
      .mockImplementation(async function* () {
        const chunks = [
          { event: "updates", data: { chunk: "data3" } },
          { event: "updates", data: { chunk: "data4" } },
          { event: "updates", data: { [INTERRUPT]: [] } },
        ];
        for (const chunk of chunks) {
          yield chunk;
        }
      });

    // default stream_mode is updates
    error = undefined;
    parts = [];
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(parts).toEqual([{ chunk: "data3" }, { chunk: "data4" }]);
    expect(error).toBeInstanceOf(GraphInterrupt);

    // list streamMode includes mode names
    parts = [];
    error = undefined;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, streamMode: ["updates"] }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      ["updates", { chunk: "data3" }],
      ["updates", { chunk: "data4" }],
    ]);

    // subgraphs + list modes
    parts = [];
    error = undefined;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, streamMode: ["updates"], subgraphs: true }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      [[], "updates", { chunk: "data3" }],
      [[], "updates", { chunk: "data4" }],
    ]);

    // subgraphs + single mode
    parts = [];
    error = undefined;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, subgraphs: true }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      [[], { chunk: "data3" }],
      [[], { chunk: "data4" }],
    ]);

    jest
      .spyOn((client as any).runs, "stream")
      .mockImplementation(async function* () {
        const chunks = [
          { event: "updates|my|subgraph", data: { chunk: "data3" } },
          { event: "updates|hello|subgraph", data: { chunk: "data4" } },
          { event: "updates|bye|subgraph", data: { [INTERRUPT]: [] } },
        ];
        for (const chunk of chunks) {
          yield chunk;
        }
      });

    // subgraphs + list modes
    parts = [];
    error = undefined;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, subgraphs: true, streamMode: ["updates"] }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      [["my", "subgraph"], "updates", { chunk: "data3" }],
      [["hello", "subgraph"], "updates", { chunk: "data4" }],
    ]);

    // subgraphs + single mode
    parts = [];
    error = undefined;
    try {
      const stream = await remotePregel.stream(
        { input: "data" },
        { ...config, subgraphs: true }
      );
      for await (const chunk of stream) {
        parts.push(chunk);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GraphInterrupt);
    expect(parts).toEqual([
      [["my", "subgraph"], { chunk: "data3" }],
      [["hello", "subgraph"], { chunk: "data4" }],
    ]);
  });

  test("invoke", async () => {
    const client = new Client({});
    jest
      .spyOn((client as any).runs, "stream")
      .mockImplementation(async function* () {
        const chunks = [
          { event: "values", data: { chunk: "data1" } },
          { event: "values", data: { chunk: "data2" } },
          {
            event: "values",
            data: { messages: [{ type: "human", content: "world" }] },
          },
        ];
        for (const chunk of chunks) {
          yield chunk;
        }
      });

    const remotePregel = new RemoteGraph({
      client,
      graphId: "test_graph_id",
    });

    const config = { configurable: { thread_id: "thread_1" } };
    const result = await remotePregel.invoke(
      { messages: [{ type: "human", content: "hello" }] },
      config
    );
    expect(result).toEqual({ messages: [{ type: "human", content: "world" }] });
  });
});
