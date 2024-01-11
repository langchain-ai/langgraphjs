import { it, expect, jest } from "@jest/globals";
import { Channel, Pregel } from "../index.js";
import { LastValue } from "../channels/last_value.js";
import { Graph } from "../graph/index.js";

it("test_invoke_single_process_in_out", async () => {
  const addOne = jest.fn((x: { "": number }): number => {
    console.log("___ADD_ONE___", x);
    return x[""] + 1;
  });
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain
    },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>()
    },
    input: "input",
    output: "output"
  });

  const graph = new Graph();
  graph.addNode("add_one", addOne);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one");
  const gapp = graph.compile();

  expect(await app.invoke(2)).toBe(3);
  expect(await app.invoke(2, undefined, ["output"])).toEqual({ output: 3 });
  expect(() => app.toString()).not.toThrow();

  expect(await gapp.invoke(2)).toBe(3);
});
