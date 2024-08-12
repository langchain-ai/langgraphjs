import { describe, expect, it } from "vitest";
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:9123" });

describe("assistants", () => {
  it("create read update delete", async () => {
    const graphId = "agent";
    const config = { configurable: { model_name: "gpt" } };

    let res = await client.assistants.create({ graphId, config });
    expect(res).toMatchObject({ graph_id: graphId, config });

    const metadata = { name: "woof" };
    await client.assistants.update(res.assistant_id, { graphId, metadata });

    res = await client.assistants.get(res.assistant_id);
    expect(res).toMatchObject({ graph_id: graphId, config, metadata });

    await client.assistants.delete(res.assistant_id);
    expect(() => client.assistants.get(res.assistant_id)).rejects.toThrow(
      "HTTP 404: Assistant not found"
    );
  });

  it.skip("schemas", async () => {
    const client = new Client({ apiUrl: "http://localhost:9123" });

    const graphId = "other";
    const config = { configurable: { model: "openai" } };

    let res = await client.assistants.create({ graphId, config });
    expect(res).toMatchObject({ graph_id: graphId, config });

    res = await client.assistants.get(res.assistant_id);
    expect(res).toMatchObject({ graph_id: graphId, config });

    const graph = await client.assistants.getGraph(res.assistant_id);
    expect(graph).toMatchObject({
      nodes: [
        { id: "__start__", type: "schema", data: "__start__" },
        {
          id: "agent",
          type: "runnable",
          data: {
            id: ["langgraph", "utils", "RunnableCallable"],
            name: "agent",
          },
        },
        {
          id: "tool",
          type: "runnable",
          data: {
            id: ["langgraph", "utils", "RunnableCallable"],
            name: "tool",
          },
        },
        { id: "__end__", type: "schema", data: "__end__" },
      ],
      edges: [
        { source: "__start__", target: "agent" },
        { source: "tool", target: "agent" },
        { source: "agent", target: "tool", conditional: true },
        { source: "agent", target: "__end__", conditional: true },
      ],
    });

    // TODO: add input/output/state/config schema

    await client.assistants.delete(res.assistant_id);
    expect(() => client.assistants.get(res.assistant_id)).rejects.toThrow(
      "HTTP 404: Assistant not found"
    );
  });
});

it("stream values", async () => {
  const assistant = await client.assistants.create({ graphId: "agent" });
  const thread = await client.threads.create();
  const input = {
    messages: [{ role: "human", content: "foo", id: "initial-message" }],
  };

  const stream = await client.runs.stream(
    thread.thread_id,
    assistant.assistant_id,
    { input, streamMode: "values" }
  );

  const chunks: Array<unknown> = [];
  for await (const event of stream) {
    chunks.push(event);
  }

  expect(chunks).toMatchObject([
    { type: "metadata", value: { run_id: expect.any(String) } },
    {
      type: "values",
      value: { messages: [{ role: "assistant", content: "foo" }] },
    },
  ]);
});
