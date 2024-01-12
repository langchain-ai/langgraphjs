import { it, expect, jest } from "@jest/globals";
import { Channel, Pregel } from "../index.js";
import { LastValue } from "../channels/last_value.js";
import { Graph } from "../graph/index.js";
import { ReservedChannels } from "../pregel/reserved.js";

it("can invoke pregel with a single process", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);
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

  expect(await app.invoke(2)).toBe(3);
  expect(await app.invoke(2, undefined, ["output"])).toEqual({ output: 3 });
  expect(() => app.toString()).not.toThrow();
  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

/**
 * @TODO failing graph
 * issue is still because of weird empty string key
 */
it.only("can invoke graph with a single process", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const graph = new Graph();
  graph.addNode("add_one", addOne);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one");
  const gapp = graph.compile();

  expect(await gapp.invoke(2)).toBe(3);
});

it("should process input and produce output with implicit channels", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes: { one: chain } });

  expect(await app.invoke(2)).toBe(3);

  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("should process input and write kwargs correctly", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo("output", {
        fixed: 5,
        outputPlusOne: (x: number) => x + 1
      })
    );

  const app = new Pregel({
    nodes: { one: chain },
    output: ["output", "fixed", "outputPlusOne"]
  });

  expect(await app.invoke(2)).toEqual({
    output: 3,
    fixed: 5,
    outputPlusOne: 4
  });
});

it("should process input and check for last step", async () => {
  const addOne = jest.fn((x: { input: number; is_last_step?: boolean }) => ({
    ...x,
    input: x.input + 1
  }));

  const chain = Channel.subscribeTo(["input"])
    .join([ReservedChannels.isLastStep])
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain }
  });

  expect(await app.invoke(2)).toEqual({ input: 3, isLastStep: false });
  expect(await app.invoke(2, { recursionLimit: 1 })).toEqual({
    input: 3,
    isLastStep: true
  });
});

it("should invoke single process in out dict", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain
    },
    output: ["output"]
  });

  expect(await app.invoke(2)).toEqual({ output: 3 });
});

/** @TODO input objects aren't working as intended. */
it("should process input and output as dictionaries", async () => {
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain },
    input: ["input"],
    output: ["output"]
  });

  expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
});

/** @TODO failing */
it.skip("should invoke two processes and get correct output", async () => {
  // const addOne = jest.fn((x: number): number => x + 1);
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  expect(await app.invoke(2)).toEqual(4);

  for await (const [step, values] of await app.stream(2)) {
    if (step === 0) {
      expect(values).toEqual({ inbox: 3 });
    } else if (step === 1) {
      expect(values).toEqual({ output: 4 });
    }
  }
});

/** @TODO failing */
it.skip("should modify inbox value and get different output", async () => {
  // const addOne = jest.fn((x: number): number => x + 1);
  const addOne = jest.fn((x: { "": number }): number => x[""] + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two }
  });

  let step = 0;
  for await (const values of await app.stream(2)) {
    if (step === 0) {
      expect(values).toEqual({ inbox: 3 });
      // modify inbox value
      values.inbox = 5;
    } else if (step === 1) {
      // output is different now
      expect(values).toEqual({ output: 6 });
    }
    step += 1;
  }
});
