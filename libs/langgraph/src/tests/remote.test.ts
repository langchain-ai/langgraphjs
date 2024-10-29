import { Client } from "@langchain/langgraph-sdk";
import { RemoteGraph } from "../pregel/remote.js";

describe("RemoteGraph", () => {
  test("with_config", () => {
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
});
