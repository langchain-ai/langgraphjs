/* eslint-disable no-process-env */
/* eslint-disable no-promise-executor-return */
import { it, expect, jest, beforeAll, describe } from "@jest/globals";
import {
  RunnableConfig,
  RunnableLambda,
  RunnablePassthrough,
} from "@langchain/core/runnables";
import { AgentAction, AgentFinish } from "@langchain/core/agents";
import { PromptTemplate } from "@langchain/core/prompts";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";
import { tool, Tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AIMessage,
  BaseMessage,
  FunctionMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolCall } from "@langchain/core/messages/tool";
import {
  fromAsync,
  FakeChatModel,
  MemorySaverAssertImmutable,
} from "./utils.js";
import { LastValue } from "../channels/last_value.js";
import {
  Annotation,
  END,
  Graph,
  START,
  StateGraph,
  StateType,
} from "../graph/index.js";
import { Topic } from "../channels/topic.js";
import { PregelNode } from "../pregel/read.js";
import { BaseChannel } from "../channels/base.js";
import { MemorySaver } from "../checkpoint/memory.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";
import {
  Channel,
  Pregel,
  PregelOptions,
  _applyWrites,
  _localRead,
  _prepareNextTasks,
  _shouldInterrupt,
} from "../pregel/index.js";
import { ToolExecutor, createAgentExecutor } from "../prebuilt/index.js";
import { MessageGraph, messagesStateReducer } from "../graph/message.js";
import { PASSTHROUGH } from "../pregel/write.js";
import { Checkpoint } from "../checkpoint/base.js";
import { GraphRecursionError, InvalidUpdateError } from "../errors.js";
import { SqliteSaver } from "../checkpoint/sqlite.js";
import { uuid6 } from "../checkpoint/id.js";
import { Send, TASKS } from "../constants.js";

// Tracing slows down the tests
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

describe("Channel", () => {
  describe("writeTo", () => {
    it("should return a ChannelWrite instance with the expected writes", () => {
      // call method / assertions
      const channelWrite = Channel.writeTo(["foo", "bar"], {
        fixed: 6,
        func: () => 42,
        runnable: new RunnablePassthrough(),
      });

      expect(channelWrite.writes.length).toBe(5);
      expect(channelWrite.writes[0]).toEqual({
        channel: "foo",
        value: PASSTHROUGH,
        skipNone: false,
      });
      expect(channelWrite.writes[1]).toEqual({
        channel: "bar",
        value: PASSTHROUGH,
        skipNone: false,
      });
      expect(channelWrite.writes[2]).toEqual({
        channel: "fixed",
        value: 6,
        skipNone: false,
      });
      // TODO: Figure out how to assert the mapper value
      // expect(channelWrite.writes[3]).toEqual({
      //   channel: "func",
      //   value: PASSTHROUGH,
      //   skipNone: true,
      //   mapper: new RunnableLambda({ func: () => 42}),
      // });
      expect(channelWrite.writes[4]).toEqual({
        channel: "runnable",
        value: PASSTHROUGH,
        skipNone: true,
        mapper: new RunnablePassthrough(),
      });
    });
  });
});

describe("Pregel", () => {
  describe("streamChannelsList", () => {
    it("should return the expected list of stream channels", () => {
      // set up test
      const chain = Channel.subscribeTo("input").pipe(
        Channel.writeTo(["output"])
      );

      const pregel1 = new Pregel({
        nodes: { one: chain },
        channels: {
          input: new LastValue<number>(),
          output: new LastValue<number>(),
        },
        inputs: "input",
        outputs: "output",
        streamChannels: "output",
      });
      const pregel2 = new Pregel({
        nodes: { one: chain },
        channels: {
          input: new LastValue<number>(),
          output: new LastValue<number>(),
        },
        inputs: "input",
        outputs: "output",
        streamChannels: ["input", "output"],
      });
      const pregel3 = new Pregel({
        nodes: { one: chain },
        channels: {
          input: new LastValue<number>(),
          output: new LastValue<number>(),
        },
        inputs: "input",
        outputs: "output",
      });

      // call method / assertions
      expect(pregel1.streamChannelsList).toEqual(["output"]);
      expect(pregel2.streamChannelsList).toEqual(["input", "output"]);
      expect(pregel3.streamChannelsList).toEqual(["input", "output"]);
      expect(pregel1.streamChannelsAsIs).toEqual("output");
      expect(pregel2.streamChannelsAsIs).toEqual(["input", "output"]);
      expect(pregel3.streamChannelsAsIs).toEqual(["input", "output"]);
    });
  });

  describe("_defaults", () => {
    it("should return the expected tuple of defaults", () => {
      // Because the implementation of _defaults() contains independent
      // if-else statements that determine that returned values in the tuple,
      // this unit test can be separated into 2 parts. The first part of the
      // test executes the "true" evaluation path of the if-else statements.
      // The second part evaluates the "false" evaluation path.

      // set up test
      const channels = {
        inputKey: new LastValue(),
        outputKey: new LastValue(),
        channel3: new LastValue(),
      };
      const nodes = {
        one: new PregelNode({
          channels: ["channel3"],
          triggers: ["outputKey"],
        }),
      };

      const config1: PregelOptions<typeof nodes, typeof channels> = {};
      const config2: PregelOptions<typeof nodes, typeof channels> = {
        streamMode: "updates",
        inputKeys: "inputKey",
        outputKeys: "outputKey",
        interruptBefore: "*",
        interruptAfter: ["one"],
        debug: true,
        tags: ["hello"],
      };

      // create Pregel class
      const pregel = new Pregel({
        nodes,
        debug: false,
        inputs: "outputKey",
        outputs: "outputKey",
        interruptBefore: ["one"],
        interruptAfter: ["one"],
        streamMode: "values",
        channels,
        checkpointer: new MemorySaver(),
      });

      // call method / assertions
      const expectedDefaults1 = [
        false, // debug
        ["values"], // stream mode
        "outputKey", // input keys
        ["inputKey", "outputKey", "channel3"], // output keys,
        {},
        ["one"], // interrupt before
        ["one"], // interrupt after
      ];

      const expectedDefaults2 = [
        true, // debug
        ["updates"], // stream mode
        "inputKey", // input keys
        "outputKey", // output keys
        { tags: ["hello"] },
        "*", // interrupt before
        ["one"], // interrupt after
      ];

      expect(pregel._defaults(config1)).toEqual(expectedDefaults1);
      expect(pregel._defaults(config2)).toEqual(expectedDefaults2);
    });
  });
});

describe("_shouldInterrupt", () => {
  it("should return true if any snapshot channel has been updated since last interrupt and any channel written to is in interrupt nodes list", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2, // current channel version is greater than last version seen
      },
      versions_seen: {
        __interrupt__: {
          channel1: 1,
        },
      },
      pending_sends: [],
    };

    const interruptNodes = ["node1"];
    const snapshotChannels = ["channel1"];

    // call method / assertions
    expect(
      _shouldInterrupt(checkpoint, interruptNodes, snapshotChannels, [
        {
          name: "node1",
          input: undefined,
          proc: new RunnablePassthrough(),
          writes: [],
          config: undefined,
        },
      ])
    ).toBe(true);
  });

  it("should return true if any snapshot channel has been updated since last interrupt and any channel written to is in interrupt nodes list", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2, // current channel version is greater than last version seen
      },
      versions_seen: {},
      pending_sends: [],
    };

    const interruptNodes = ["node1"];
    const snapshotChannels = ["channel1"];

    // call method / assertions
    expect(
      _shouldInterrupt(checkpoint, interruptNodes, snapshotChannels, [
        {
          name: "node1",
          input: undefined,
          proc: new RunnablePassthrough(),
          writes: [],
          config: undefined,
        },
      ])
    ).toBe(true);
  });

  it("should return false if all snapshot channels have not been updated", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2, // current channel version is equal to last version seen
      },
      versions_seen: {
        __interrupt__: {
          channel1: 2,
        },
      },
      pending_sends: [],
    };

    const interruptNodes = ["node1"];
    const snapshotChannels = ["channel1"];

    // call method / assertions
    expect(
      _shouldInterrupt(checkpoint, interruptNodes, snapshotChannels, [
        {
          name: "node1",
          input: undefined,
          proc: new RunnablePassthrough(),
          writes: [],
          config: undefined,
        },
      ])
    ).toBe(false);
  });

  it("should return false if all task nodes are not in interrupt nodes", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2,
      },
      versions_seen: {
        __interrupt__: {
          channel1: 1,
        },
      },
      pending_sends: [],
    };

    const interruptNodes = ["node1"];
    const snapshotChannels = ["channel1"];

    // call method / assertions
    expect(
      _shouldInterrupt(checkpoint, interruptNodes, snapshotChannels, [
        {
          name: "node2", // node2 is not in interrupt nodes
          input: undefined,
          proc: new RunnablePassthrough(),
          writes: [],
          config: undefined,
        },
      ])
    ).toBe(false);
  });
});

describe("_localRead", () => {
  it("should return the channel value when fresh is false", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 0,
      id: uuid6(-1),
      ts: "",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
    };

    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    channel1.update([1]);
    channel2.update([2]);

    const channels: Record<string, BaseChannel> = {
      channel1,
      channel2,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writes: Array<[string, any]> = [];

    // call method / assertions
    expect(_localRead(checkpoint, channels, writes, "channel1", false)).toBe(1);
    expect(
      _localRead(checkpoint, channels, writes, ["channel1", "channel2"], false)
    ).toEqual({ channel1: 1, channel2: 2 });
  });

  it("should return the channel value after applying writes when fresh is true", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 0,
      id: uuid6(-1),
      ts: "",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
    };

    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    channel1.update([1]);
    channel2.update([2]);

    const channels: Record<string, BaseChannel> = {
      channel1,
      channel2,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writes: Array<[string, any]> = [
      ["channel1", 100],
      ["channel2", 200],
    ];

    // call method / assertions
    expect(_localRead(checkpoint, channels, writes, "channel1", true)).toBe(
      100
    );
    expect(
      _localRead(checkpoint, channels, writes, ["channel1", "channel2"], true)
    ).toEqual({ channel1: 100, channel2: 200 });
  });
});

describe("_applyWrites", () => {
  it("should update channels and checkpoints correctly (side effect)", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2,
        channel2: 5,
      },
      versions_seen: {
        __interrupt__: {
          channel1: 1,
        },
      },
      pending_sends: [],
    };

    const lastValueChannel1 = new LastValue<string>();
    lastValueChannel1.update(["channel1value"]);
    const lastValueChannel2 = new LastValue<string>();
    lastValueChannel2.update(["channel2value"]);
    const channels = {
      channel1: lastValueChannel1,
      channel2: lastValueChannel2,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingWrites: Array<[keyof typeof channels, any]> = [
      ["channel1", "channel1valueUpdated!"],
    ];

    // call method / assertions
    expect(channels.channel1.get()).toBe("channel1value");
    expect(channels.channel2.get()).toBe("channel2value");
    expect(checkpoint.channel_versions.channel1).toBe(2);

    _applyWrites(checkpoint, channels, pendingWrites); // contains side effects

    expect(channels.channel1.get()).toBe("channel1valueUpdated!");
    expect(channels.channel2.get()).toBe("channel2value");
    expect(checkpoint.channel_versions.channel1).toBe(6);
  });

  it("should throw an InvalidUpdateError if there are multiple updates to the same channel", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: "channel1value",
      },
      channel_versions: {
        channel1: 2,
      },
      versions_seen: {
        __interrupt__: {
          channel1: 1,
        },
      },
      pending_sends: [],
    };

    const lastValueChannel1 = new LastValue<string>();
    lastValueChannel1.update(["channel1value"]);
    const channels = {
      channel1: lastValueChannel1,
    };

    // LastValue channel can only be updated with one value at a time
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingWrites: Array<[keyof typeof channels, any]> = [
      ["channel1", "channel1valueUpdated!"],
      ["channel1", "channel1valueUpdatedAgain!"],
    ];

    // call method / assertions
    expect(() => {
      _applyWrites(checkpoint, channels, pendingWrites); // contains side effects
    }).toThrow(InvalidUpdateError);
  });
});

describe("_prepareNextTasks", () => {
  it("should return an array of PregelTaskDescriptions", () => {
    // set up test
    const checkpoint: Checkpoint = {
      v: 1,
      id: "123",
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: 1,
        channel2: 2,
      },
      channel_versions: {
        channel1: 2,
        channel2: 5,
      },
      versions_seen: {
        node1: {
          channel1: 1,
        },
        node2: {
          channel2: 5,
        },
      },
      pending_sends: [],
    };

    const processes: Record<string, PregelNode> = {
      node1: new PregelNode({
        channels: ["channel1"],
        triggers: ["channel1"],
      }),
      node2: new PregelNode({
        channels: ["channel2"],
        triggers: ["channel1", "channel2"],
        mapper: () => 100, // return 100 no matter what
      }),
    };

    const channel1 = new LastValue<number>();
    channel1.update([1]);
    const channel2 = new LastValue<number>();
    channel2.update([2]);

    const channels = {
      channel1,
      channel2,
    };

    // call method / assertions
    const [newCheckpoint, taskDescriptions] = _prepareNextTasks(
      checkpoint,
      processes,
      channels,
      false,
      { step: -1 }
    );

    expect(taskDescriptions.length).toBe(2);
    expect(taskDescriptions[0]).toEqual({ name: "node1", input: 1 });
    expect(taskDescriptions[1]).toEqual({ name: "node2", input: 100 });

    // the returned checkpoint is a copy of the passed checkpoint without versionsSeen updated
    expect(newCheckpoint.versions_seen.node1.channel1).toBe(1);
    expect(newCheckpoint.versions_seen.node2.channel2).toBe(5);
  });

  it("should return an array of PregelExecutableTasks", () => {
    const checkpoint: Checkpoint = {
      v: 1,
      id: uuid6(-1),
      ts: "2024-04-19T17:19:07.952Z",
      channel_values: {
        channel1: 1,
        channel2: 2,
      },
      channel_versions: {
        channel1: 2,
        channel2: 5,
        channel3: 4,
        channel4: 4,
        channel6: 4,
      },
      versions_seen: {
        node1: {
          channel1: 1,
        },
        node2: {
          channel2: 5,
        },
        node3: {
          channel3: 4,
        },
        node4: {
          channel4: 3,
        },
        node6: {
          channel6: 3,
        },
      },
      pending_sends: [
        {
          node: "node1",
          args: { test: true },
        },
        // Will not appear because node3 has no writers
        { node: "node3", args: { test3: "value3" } },
      ],
    };

    const processes: Record<string, PregelNode> = {
      node1: new PregelNode({
        channels: ["channel1"],
        triggers: ["channel1"],
        writers: [new RunnablePassthrough()],
      }),
      node2: new PregelNode({
        channels: ["channel2"],
        triggers: ["channel1", "channel2"],
        writers: [new RunnablePassthrough()],
        mapper: () => 100, // return 100 no matter what
      }),
      node3: new PregelNode({
        // this task is filtered out because current version of channel3 matches version seen
        channels: ["channel3"],
        triggers: ["channel3"],
      }),
      node4: new PregelNode({
        // this task is filtered out because channel5 is empty
        channels: ["channel5"],
        triggers: ["channel4"],
      }),
      node6: new PregelNode({
        // this task is filtered out because channel5 is empty
        channels: { channel5: "channel5" },
        triggers: ["channel5", "channel6"],
      }),
    };

    const channel1 = new LastValue<number>();
    channel1.update([1]);
    const channel2 = new LastValue<number>();
    channel2.update([2]);
    const channel3 = new LastValue<number>();
    channel3.update([3]);
    const channel4 = new LastValue<number>();
    channel4.update([4]);
    const channel5 = new LastValue<number>();
    const channel6 = new LastValue<number>();
    channel6.update([6]);

    const channels = {
      channel1,
      channel2,
      channel3,
      channel4,
      channel5,
      channel6,
    };

    // call method / assertions
    const [newCheckpoint, tasks] = _prepareNextTasks(
      checkpoint,
      processes,
      channels,
      true,
      { step: -1 }
    );

    expect(tasks.length).toBe(3);
    expect(tasks[0]).toEqual({
      name: "node1",
      input: { test: true },
      proc: new RunnablePassthrough(),
      writes: [],
      config: {
        tags: [],
        configurable: expect.any(Object),
        metadata: {
          langgraph_node: "node1",
          langgraph_step: -1,
          langgraph_task_idx: 0,
          langgraph_triggers: [TASKS],
        },
        recursionLimit: 25,
        runId: undefined,
        runName: "node1",
      },
    });
    expect(tasks[1]).toEqual({
      name: "node1",
      input: 1,
      proc: new RunnablePassthrough(),
      writes: [],
      config: {
        tags: [],
        configurable: expect.any(Object),
        metadata: {
          langgraph_node: "node1",
          langgraph_step: -1,
          langgraph_task_idx: 1,
          langgraph_triggers: ["channel1"],
        },
        recursionLimit: 25,
        runId: undefined,
        runName: "node1",
      },
    });
    expect(tasks[2]).toEqual({
      name: "node2",
      input: 100,
      proc: new RunnablePassthrough(),
      writes: [],
      config: {
        tags: [],
        configurable: expect.any(Object),
        metadata: {
          langgraph_node: "node2",
          langgraph_step: -1,
          langgraph_task_idx: 2,
          langgraph_triggers: ["channel1", "channel2"],
        },
        recursionLimit: 25,
        runId: undefined,
        runName: "node2",
      },
    });

    expect(newCheckpoint.versions_seen.node1.channel1).toBe(2);
    expect(newCheckpoint.versions_seen.node2.channel1).toBe(2);
    expect(newCheckpoint.versions_seen.node2.channel2).toBe(5);
  });
});

it("can invoke pregel with a single process", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: {
      one: chain,
    },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  expect(await app.invoke(2)).toBe(3);
  expect(await app.invoke(2, { outputKeys: ["output"] })).toEqual({
    output: 3,
  });
  expect(() => app.toString()).not.toThrow();
  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("can invoke graph with a single process", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const graph = new Graph()
    .addNode("add_one", addOne)
    .addEdge(START, "add_one")
    .addEdge("add_one", END)
    .compile();

  expect(await graph.invoke(2)).toBe(3);
});

it("should process input and produce output with implicit channels", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one: chain },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  expect(await app.invoke(2)).toBe(3);

  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("should process input and write kwargs correctly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo(["output"], {
        fixed: 5,
        outputPlusOne: (x: number) => x + 1,
      })
    );

  const app = new Pregel({
    nodes: { one: chain },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
      fixed: new LastValue<number>(),
      outputPlusOne: new LastValue<number>(),
    },
    outputs: ["output", "fixed", "outputPlusOne"],
    inputs: "input",
  });

  expect(await app.invoke(2)).toEqual({
    output: 3,
    fixed: 5,
    outputPlusOne: 4,
  });
});

it("should invoke single process in out objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: {
      one: chain,
    },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: "input",
    outputs: ["output"],
  });

  expect(await app.invoke(2)).toEqual({ output: 3 });
});

it("should process input and output as objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one: chain },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: ["input"],
    outputs: ["output"],
  });

  expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
});

it("should invoke two processes and get correct output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["inbox"]));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      inbox: new LastValue<number>(),
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
    streamChannels: ["inbox", "output"],
  });

  await expect(app.invoke(2, { recursionLimit: 1 })).rejects.toThrow(
    GraphRecursionError
  );

  expect(await app.invoke(2)).toEqual(4);

  const stream = await app.stream(2, { streamMode: "updates" });
  let step = 0;
  for await (const value of stream) {
    if (step === 0) {
      expect(value).toEqual({ one: { inbox: 3 } });
    } else if (step === 1) {
      expect(value).toEqual({ two: { output: 4 } });
    }
    step += 1;
  }
  expect(step).toBe(2);
});

it("should process two processes with object input and output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["inbox"]));
  const two = Channel.subscribeTo("inbox")
    .pipe(new RunnableLambda({ func: addOne }).map())
    .pipe(Channel.writeTo(["output"]).map());

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      inbox: new Topic<number>(),
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    streamChannels: ["output", "inbox"],
    inputs: ["input", "inbox"],
    outputs: "output",
  });

  const streamResult = await app.stream(
    { input: 2, inbox: 12 },
    { outputKeys: "output" }
  );
  const outputResults = [];
  for await (const result of streamResult) {
    outputResults.push(result);
  }
  expect(outputResults).toEqual([13, 4]); // [12 + 1, 2 + 1 + 1]

  const fullStreamResult = await app.stream({ input: 2, inbox: 12 });
  const fullOutputResults = [];
  for await (const result of fullStreamResult) {
    fullOutputResults.push(result);
  }
  expect(fullOutputResults).toEqual([
    { inbox: [3], output: 13 },
    { inbox: [], output: 4 },
  ]);

  const fullOutputResultsUpdates = [];
  for await (const result of await app.stream(
    { input: 2, inbox: 12 },
    { streamMode: "updates" }
  )) {
    fullOutputResultsUpdates.push(result);
  }
  expect(fullOutputResultsUpdates).toEqual([
    {
      one: {
        inbox: 3,
      },
    },
    {
      two: {
        output: 13,
      },
    },
    { two: { output: 4 } },
  ]);
});

it("should process batch with two processes and delays", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const one = Channel.subscribeTo("input")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo(["one"]));
  const two = Channel.subscribeTo("one")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      one: new LastValue<number>(),
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  expect(await app.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
  expect(await app.batch([3, 2, 1, 3, 5], { outputKeys: ["output"] })).toEqual([
    { output: 5 },
    { output: 4 },
    { output: 3 },
    { output: 5 },
    { output: 7 },
  ]);
});

it("should process batch with two processes and delays with graph", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const graph = new Graph()
    .addNode("add_one", addOneWithDelay)
    .addNode("add_one_more", addOneWithDelay)
    .addEdge(START, "add_one")
    .addEdge("add_one", "add_one_more")
    .addEdge("add_one_more", END)
    .compile();

  expect(await graph.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
});

it("should batch many processes with input and output", async () => {
  const testSize = 100;
  const addOne = jest.fn((x: number) => x + 1);

  const channels: Record<string, LastValue<number>> = {
    input: new LastValue<number>(),
    output: new LastValue<number>(),
    "-1": new LastValue<number>(),
  };
  const nodes: Record<string, PregelNode> = {
    "-1": Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["-1"])),
  };

  for (let i = 0; i < testSize - 2; i += 1) {
    channels[String(i)] = new LastValue<number>();
    nodes[String(i)] = Channel.subscribeTo(String(i - 1))
      .pipe(addOne)
      .pipe(Channel.writeTo([String(i)]));
  }
  nodes.last = Channel.subscribeTo(String(testSize - 3))
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes,
    channels,
    inputs: "input",
    outputs: "output",
  });

  for (let i = 0; i < 3; i += 1) {
    await expect(
      app.batch([2, 1, 3, 4, 5], { recursionLimit: testSize })
    ).resolves.toEqual([
      2 + testSize,
      1 + testSize,
      3 + testSize,
      4 + testSize,
      5 + testSize,
    ]);
  }
});

it("should raise InvalidUpdateError when the same LastValue channel is updated twice in one iteration", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  await expect(app.invoke(2)).rejects.toThrow(InvalidUpdateError);
});

it("should process two inputs to two outputs validly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      output: new Topic<number>(),
      input: new LastValue<number>(),
      output2: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  // An Inbox channel accumulates updates into a sequence
  expect(await app.invoke(2)).toEqual([3, 3]);
});

it("should allow a conditional edge after a send", async () => {
  const State = {
    items: Annotation<string[]>({
      reducer: (a, b) => a.concat(b),
    }),
  };
  const sendForFun = (state: StateType<typeof State>) => {
    return [new Send("2", state), new Send("2", state)];
  };
  const routeToThree = () => "3";
  const graph = new StateGraph(State)
    .addNode("1", () => ({ items: ["1"] }))
    .addNode("2", () => ({ items: ["2"] }))
    .addNode("3", () => ({ items: ["3"] }))
    .addEdge("__start__", "1")
    .addConditionalEdges("1", sendForFun)
    .addConditionalEdges("2", routeToThree)
    .addEdge("3", "__end__")
    .compile();
  const res = await graph.invoke({ items: ["0"] });
  expect(res).toEqual({ items: ["0", "1", "2", "2", "3"] });
});

it("should handle checkpoints correctly", async () => {
  const inputPlusTotal = jest.fn(
    (x: { total: number; input: number }): number => x.total + x.input
  );
  const raiseIfAbove10 = (input: number): number => {
    if (input > 10) {
      throw new Error("Input is too large");
    }
    return input;
  };

  const one = Channel.subscribeTo(["input"])
    .join(["total"])
    .pipe(inputPlusTotal)
    .pipe(Channel.writeTo(["output", "total"]))
    .pipe(raiseIfAbove10);

  const memory = new MemorySaverAssertImmutable();

  const app = new Pregel({
    nodes: { one },
    channels: {
      total: new BinaryOperatorAggregate<number>((a, b) => a + b),
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
    checkpointer: memory,
  });

  // total starts out as 0, so output is 0+2=2
  await expect(
    app.invoke(2, { configurable: { thread_id: "1" } })
  ).resolves.toBe(2);
  let checkpoint = await memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channel_values.total).toBe(2);

  // total is now 2, so output is 2+3=5
  await expect(
    app.invoke(3, { configurable: { thread_id: "1" } })
  ).resolves.toBe(5);
  checkpoint = await memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channel_values.total).toBe(7);

  // total is now 2+5=7, so output would be 7+4=11, but raises Error
  await expect(
    app.invoke(4, { configurable: { thread_id: "1" } })
  ).rejects.toThrow("Input is too large");
  // checkpoint is not updated
  checkpoint = await memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channel_values.total).toBe(7);

  // on a new thread, total starts out as 0, so output is 0+5=5
  await expect(
    app.invoke(5, { configurable: { thread_id: "2" } })
  ).resolves.toBe(5);
  checkpoint = await memory.get({ configurable: { thread_id: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channel_values.total).toBe(7);
  checkpoint = await memory.get({ configurable: { thread_id: "2" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channel_values.total).toBe(5);
});

it("should process two inputs joined into one topic and produce two outputs", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const add10Each = jest.fn((x: number[]): number[] =>
    x.map((y) => y + 10).sort()
  );

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["inbox"]));
  const chainThree = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["inbox"]));
  const chainFour = Channel.subscribeTo("inbox")
    .pipe(add10Each)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: {
      one,
      chainThree,
      chainFour,
    },
    channels: {
      inbox: new Topic<number>(),
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  // Invoke app and check results
  for (let i = 0; i < 100; i += 1) {
    expect(await app.invoke(2)).toEqual([13, 13]);
  }

  // Use Promise.all to simulate concurrent execution
  const results = await Promise.all(
    Array(100)
      .fill(null)
      .map(async () => app.invoke(2))
  );
  results.forEach((result) => {
    expect(result).toEqual([13, 13]);
  });
});

it("should invoke join then call other app", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const add10Each = jest.fn((x: number[]): number[] => x.map((y) => y + 10));

  const innerApp = new Pregel({
    nodes: {
      one: Channel.subscribeTo("input")
        .pipe(addOne)
        .pipe(Channel.writeTo(["output"])),
    },
    channels: {
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  const one = Channel.subscribeTo("input")
    .pipe(add10Each)
    .pipe(Channel.writeTo(["inbox_one"]).map());

  const two = Channel.subscribeTo("inbox_one")
    .pipe(() => innerApp.map())
    .pipe((x: number[]) => x.sort())
    .pipe(Channel.writeTo(["outbox_one"]));

  const chainThree = Channel.subscribeTo("outbox_one")
    .pipe((x: number[]) => x.reduce((a, b) => a + b, 0))
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: {
      one,
      two,
      chain_three: chainThree,
    },
    channels: {
      inbox_one: new Topic<number>(),
      outbox_one: new Topic<number>(),
      output: new LastValue<number>(),
      input: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  // Run the test 10 times sequentially
  for (let i = 0; i < 10; i += 1) {
    expect(await app.invoke([2, 3])).toEqual(27);
  }

  // Run the test 10 times in parallel
  const results = await Promise.all(
    Array(10)
      .fill(null)
      .map(() => app.invoke([2, 3]))
  );
  expect(results).toEqual(Array(10).fill(27));
});

it("should handle two processes with one input and two outputs", async () => {
  const addOne = jest.fn((x: number) => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo([], {
        output: new RunnablePassthrough(),
        between: new RunnablePassthrough(),
      })
    );

  const two = Channel.subscribeTo("between")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
      between: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
    streamChannels: ["output", "between"],
  });

  const results = await app.stream(2);
  const streamResults = [];
  for await (const chunk of results) {
    streamResults.push(chunk);
  }

  expect(streamResults).toEqual([
    { between: 3, output: 3 },
    { between: 3, output: 4 },
  ]);
});

it("should finish executing without output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo(["between"]));
  const two = Channel.subscribeTo("between").pipe(addOne);

  const app = new Pregel({
    nodes: { one, two },
    channels: {
      input: new LastValue<number>(),
      between: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    inputs: "input",
    outputs: "output",
  });

  // It finishes executing (once no more messages being published)
  // but returns nothing, as nothing was published to OUT topic
  expect(await app.invoke(2)).toBeUndefined();
});

it("should throw an error when no input channel is provided", () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("between")
    .pipe(addOne)
    .pipe(Channel.writeTo(["output"]));
  const two = Channel.subscribeTo("between").pipe(addOne);

  // @ts-expect-error - this should throw an error
  expect(() => new Pregel({ nodes: { one, two } })).toThrowError();
});

it("should type-error when Channel.subscribeTo would throw at runtime", () => {
  expect(() => {
    // @ts-expect-error - this would throw at runtime and thus we want it to become a type-error
    Channel.subscribeTo(["input"], { key: "key" });
  }).toThrow();
});

describe("StateGraph", () => {
  class SearchAPI extends Tool {
    name = "search_api";

    description = "A simple API that returns the input string.";

    schema = z
      .object({
        input: z.string().optional(),
      })
      .transform((data) => data.input);

    constructor() {
      super();
    }

    async _call(query: string): Promise<string> {
      return `result for ${query}`;
    }
  }
  const tools = [new SearchAPI()];

  type Step = [AgentAction | AgentFinish, string];

  type AgentState = {
    input: string;
    agentOutcome?: AgentAction | AgentFinish;
    steps: Step[];
  };

  const executeTools = async (
    data: AgentState
  ): Promise<Partial<AgentState>> => {
    const newData = data;
    const { agentOutcome } = newData;
    delete newData.agentOutcome;
    if (!agentOutcome || "returnValues" in agentOutcome) {
      throw new Error("Agent has already finished.");
    }
    const observation: string =
      (await tools
        .find((t) => t.name === agentOutcome.tool)
        ?.invoke(agentOutcome.toolInput)) ?? "failed";

    return {
      steps: [[agentOutcome, observation]],
    };
  };

  const shouldContinue = async (data: AgentState): Promise<string> => {
    if (data.agentOutcome && "returnValues" in data.agentOutcome) {
      return "exit";
    }
    return "continue";
  };

  it("can invoke", async () => {
    const prompt = PromptTemplate.fromTemplate("Hello!");

    const llm = new FakeStreamingLLM({
      responses: [
        "tool:search_api:query",
        "tool:search_api:another",
        "finish:answer",
      ],
    });

    const agentParser = (input: string) => {
      if (input.startsWith("finish")) {
        const answer = input.split(":")[1];
        return {
          agentOutcome: {
            returnValues: { answer },
            log: input,
          },
        };
      }
      const [, toolName, toolInput] = input.split(":");
      return {
        agentOutcome: {
          tool: toolName,
          toolInput,
          log: input,
        },
      };
    };

    const agent = async (state: AgentState) => {
      const chain = prompt.pipe(llm).pipe(agentParser);
      const result = await chain.invoke({ input: state.input });
      return {
        ...result,
      };
    };

    const graph = new StateGraph<AgentState>({
      channels: {
        input: null,
        agentOutcome: null,
        steps: {
          value: (x: Step[], y: Step[]) => x.concat(y),
          default: () => [],
        },
      },
    })
      .addNode("agent", agent)
      .addNode("tools", executeTools)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", shouldContinue, {
        continue: "tools",
        exit: END,
      })
      .addEdge("tools", "agent")
      .compile();

    const result = await graph.invoke({ input: "what is the weather in sf?" });
    expect(result).toEqual({
      input: "what is the weather in sf?",
      agentOutcome: {
        returnValues: {
          answer: "answer",
        },
        log: "finish:answer",
      },
      steps: [
        [
          {
            log: "tool:search_api:query",
            tool: "search_api",
            toolInput: "query",
          },
          "result for query",
        ],
        [
          {
            log: "tool:search_api:another",
            tool: "search_api",
            toolInput: "another",
          },
          "result for another",
        ],
      ],
    });
  });

  it("can stream", async () => {
    const prompt = PromptTemplate.fromTemplate("Hello!");

    const llm = new FakeStreamingLLM({
      responses: [
        "tool:search_api:query",
        "tool:search_api:another",
        "finish:answer",
      ],
    });

    const agentParser = (input: string) => {
      if (input.startsWith("finish")) {
        const answer = input.split(":")[1];
        return {
          agentOutcome: {
            returnValues: { answer },
            log: input,
          },
        };
      }
      const [, toolName, toolInput] = input.split(":");
      return {
        agentOutcome: {
          tool: toolName,
          toolInput,
          log: input,
        },
      };
    };

    const agent = async (state: AgentState) => {
      const chain = prompt.pipe(llm).pipe(agentParser);
      const result = await chain.invoke({ input: state.input });
      return {
        ...result,
      };
    };

    const app = new StateGraph<AgentState>({
      channels: {
        input: null,
        agentOutcome: null,
        steps: {
          value: (x: Step[], y: Step[]) => x.concat(y),
          default: () => [],
        },
      },
    })
      .addNode("agent", agent)
      .addNode("tools", executeTools)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", shouldContinue, {
        continue: "tools",
        exit: END,
      })
      .addEdge("tools", "agent")
      .compile();

    const stream = await app.stream({ input: "what is the weather in sf?" });
    const streamItems = [];
    for await (const item of stream) {
      streamItems.push(item);
    }
    expect(streamItems.length).toBe(5);
    expect(streamItems[0]).toEqual({
      agent: {
        agentOutcome: {
          tool: "search_api",
          toolInput: "query",
          log: "tool:search_api:query",
        },
      },
    });

    // TODO: Need to rewrite this test.
  });

  it("can invoke a nested graph", async () => {
    // set up inner graph
    type InnerState = {
      myKey: string;
      myOtherKey: string;
    };

    const innerGraph = new StateGraph<InnerState>({
      channels: {
        myKey: null,
        myOtherKey: null,
      },
    })
      .addNode("up", (state: InnerState) => ({
        myKey: `${state.myKey} there`,
        myOtherKey: state.myOtherKey,
      }))
      .addEdge(START, "up")
      .addEdge("up", END);

    // set up top level graph
    type State = {
      myKey: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      neverCalled: any;
    };

    const graph = new StateGraph<State>({
      channels: {
        myKey: null,
        neverCalled: null,
      },
    })
      .addNode("inner", innerGraph.compile())
      .addNode("side", (state: State) => ({
        myKey: `${state.myKey} and back again`,
      }))
      .addEdge("inner", "side")
      .addEdge(START, "inner")
      .addEdge("side", END)
      .compile();

    // call method / assertions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const neverCalled = jest.fn((_: any) => {
      throw new Error("This should never be called");
    });

    const result = await graph.invoke({
      myKey: "my value",
      neverCalled: new RunnableLambda({ func: neverCalled }),
    });

    expect(result).toEqual({
      myKey: "my value there and back again",
      neverCalled: new RunnableLambda({ func: neverCalled }),
    });
  });

  it("can invoke a nested graph", async () => {
    // set up inner graph
    type InnerState = {
      myKey: string;
      myOtherKey: string;
    };

    const innerGraph = new StateGraph<InnerState>({
      channels: {
        myKey: null,
        myOtherKey: null,
      },
    })
      .addNode("up", (state: InnerState) => ({
        myKey: `${state.myKey} there`,
        myOtherKey: state.myOtherKey,
      }))
      .addEdge(START, "up")
      .addEdge("up", END);

    // set up top level graph
    type State = {
      myKey: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      neverCalled: any;
    };

    const graph = new StateGraph<State>({
      channels: {
        myKey: null,
        neverCalled: null,
      },
    })
      .addNode("inner", innerGraph.compile())
      .addNode("side", (state: State) => ({
        myKey: `${state.myKey} and back again`,
      }))
      .addEdge("inner", "side")
      .addEdge(START, "inner")
      .addEdge("side", END)
      .compile();

    // call method / assertions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const neverCalled = jest.fn((_: any) => {
      throw new Error("This should never be called");
    });

    const result = await graph.invoke({
      myKey: "my value",
      neverCalled: new RunnableLambda({ func: neverCalled }),
    });

    expect(result).toEqual({
      myKey: "my value there and back again",
      neverCalled: new RunnableLambda({ func: neverCalled }),
    });
  });

  it("Conditional edges is optional", async () => {
    type GraphState = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keys: Record<string, any>;
    };
    const nodeOne = (state: GraphState) => {
      const { keys } = state;
      keys.value = 1;
      return {
        keys,
      };
    };
    const nodeTwo = (state: GraphState) => {
      const { keys } = state;
      keys.value = 2;
      return {
        keys,
      };
    };
    const nodeThree = (state: GraphState) => {
      const { keys } = state;
      keys.value = 3;
      return {
        keys,
      };
    };
    const decideNext = (_: GraphState) => "two";

    const graph = new StateGraph<GraphState>({
      channels: {
        keys: null,
      },
    })
      .addNode("one", nodeOne)
      .addNode("two", nodeTwo)
      .addNode("three", nodeThree)
      .addEdge(START, "one")
      .addConditionalEdges("one", decideNext)
      .addEdge("two", "three")
      .addEdge("three", END)
      .compile();

    // This will always return two, and two will always go to three
    // meaning keys.value will always be 3
    const result = await graph.invoke({ keys: { value: 0 } });
    expect(result).toEqual({ keys: { value: 3 } });
  });

  it("In one fan out state graph waiting edge", async () => {
    const sortedAdd = jest.fn((x: string[], y: string[]): string[] =>
      [...x, ...y].sort()
    );

    type State = {
      query: string;
      answer: string;
      docs: string[];
    };

    function rewriteQuery(data: State): Partial<State> {
      return { query: `query: ${data.query}` };
    }

    function analyzerOne(data: State): Partial<State> {
      return { query: `analyzed: ${data.query}` };
    }

    function retrieverOne(_data: State): Partial<State> {
      return { docs: ["doc1", "doc2"] };
    }

    function retrieverTwo(_data: State): Partial<State> {
      return { docs: ["doc3", "doc4"] };
    }

    function qa(data: State): Partial<State> {
      return { answer: data.docs?.join(",") };
    }

    const workflow = new StateGraph<State>({
      channels: {
        query: null,
        answer: null,
        docs: { reducer: sortedAdd },
      },
    })
      .addNode("rewrite_query", rewriteQuery)
      .addNode("analyzer_one", analyzerOne)
      .addNode("retriever_one", retrieverOne)
      .addNode("retriever_two", retrieverTwo)
      .addNode("qa", qa)
      .addEdge(START, "rewrite_query")
      .addEdge("rewrite_query", "analyzer_one")
      .addEdge("analyzer_one", "retriever_one")
      .addEdge("rewrite_query", "retriever_two")
      .addEdge(["retriever_one", "retriever_two"], "qa")
      .addEdge("qa", END);

    const app = workflow.compile();

    expect(await app.invoke({ query: "what is weather in sf" })).toEqual({
      query: "analyzed: query: what is weather in sf",
      docs: ["doc1", "doc2", "doc3", "doc4"],
      answer: "doc1,doc2,doc3,doc4",
    });
  });

  it("Allow map reduce flows", async () => {
    const OverallState = Annotation.Root({
      subjects: Annotation<string[]>,
      jokes: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
      }),
    });
    const continueToJokes = async (state: typeof OverallState.State) => {
      return state.subjects.map((subject) => {
        return new Send("generate_joke", { subjects: [subject] });
      });
    };
    const graph = new StateGraph(OverallState)
      .addNode("generate_joke", (state) => ({
        jokes: [`Joke about ${state.subjects}`],
      }))
      .addConditionalEdges("__start__", continueToJokes)
      .addEdge("generate_joke", "__end__")
      .compile();
    const res = await graph.invoke({ subjects: ["cats", "dogs"] });
    // Invoking with two subjects results in a generated joke for each
    expect(res).toEqual({
      subjects: ["cats", "dogs"],
      jokes: [`Joke about cats`, `Joke about dogs`],
    });
  });

  it("State graph packets", async () => {
    const AgentState = Annotation.Root({
      messages: Annotation({
        reducer: messagesStateReducer,
      }),
    });
    const searchApi = tool(
      async ({ query }) => {
        return `result for ${query}`;
      },
      {
        name: "search_api",
        schema: z.object({
          query: z.string(),
        }),
        description: "Searches the API for the query",
      }
    );

    const toolsByName = { [searchApi.name]: searchApi };
    const model = new FakeChatModel({
      responses: [
        new AIMessage({
          id: "ai1",
          content: "",
          tool_calls: [
            {
              id: "tool_call123",
              name: "search_api",
              args: { query: "query" },
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          id: "ai2",
          content: "",
          tool_calls: [
            {
              id: "tool_call234",
              name: "search_api",
              args: { query: "another", idx: 0 },
              type: "tool_call",
            },
            {
              id: "tool_call567",
              name: "search_api",
              args: { query: "a third one", idx: 1 },
              type: "tool_call",
            },
          ],
        }),
        new AIMessage({
          id: "ai3",
          content: "answer",
        }),
      ],
    });

    const agent = async (state: typeof AgentState.State) => {
      return {
        messages: await model.invoke(state.messages),
      };
    };

    const shouldContinue = async (state: typeof AgentState.State) => {
      // TODO: Support this?
      // expect(state.something_extra).toEqual("hi there");
      const toolCalls = (state.messages[state.messages.length - 1] as AIMessage)
        .tool_calls;
      if (toolCalls?.length) {
        return toolCalls.map((toolCall) => {
          return new Send("tools", toolCall);
        });
      } else {
        return "__end__";
      }
    };

    const toolsNode = async (toolCall: ToolCall) => {
      await new Promise((resolve) =>
        setTimeout(resolve, toolCall.args.idx * 100)
      );
      const toolMessage = await toolsByName[toolCall.name].invoke(toolCall);
      return {
        messages: new ToolMessage({
          content: toolMessage.content,
          id: toolCall.args.idx !== undefined ? `${toolCall.args.idx}` : "abc",
          tool_call_id: toolMessage.tool_call_id,
          name: toolMessage.name,
        }),
      };
    };

    const builder = new StateGraph(AgentState)
      .addNode("agent", agent)
      .addNode("tools", toolsNode)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue)
      .addEdge("tools", "agent");
    const inputMessage = new HumanMessage({
      id: "foo",
      content: "what is weather in sf",
    });
    const expectedOutputMessages = [
      inputMessage,
      new AIMessage({
        id: "ai1",
        content: "",
        tool_calls: [
          {
            id: "tool_call123",
            name: "search_api",
            args: { query: "query" },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({
        id: "abc",
        content: "result for query",
        name: "search_api",
        tool_call_id: "tool_call123",
      }),
      new AIMessage({
        id: "ai2",
        content: "",
        tool_calls: [
          {
            id: "tool_call234",
            name: "search_api",
            args: { query: "another", idx: 0 },
            type: "tool_call",
          },
          {
            id: "tool_call567",
            name: "search_api",
            args: { query: "a third one", idx: 1 },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({
        id: "0",
        content: "result for another",
        name: "search_api",
        tool_call_id: "tool_call234",
      }),
      new ToolMessage({
        id: "1",
        content: "result for a third one",
        name: "search_api",
        tool_call_id: "tool_call567",
      }),
      new AIMessage({
        id: "ai3",
        content: "answer",
      }),
    ];
    const res = await builder.compile().invoke({
      messages: [inputMessage],
    });
    expect(res).toEqual({
      messages: expectedOutputMessages,
    });

    const stream = await builder.compile().stream({
      messages: [inputMessage],
    });
    let chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const nodeOrder = ["agent", "tools", "agent", "tools", "tools", "agent"];
    expect(nodeOrder.length).toEqual(chunks.length);
    expect(chunks).toEqual(
      // The input message is not streamed back
      expectedOutputMessages.slice(1).map((message, i) => {
        return {
          [nodeOrder[i]]: { messages: message },
        };
      })
    );

    const appWithInterrupt = builder.compile({
      checkpointer: new MemorySaverAssertImmutable(),
      interruptAfter: ["agent"],
    });
    const config = { configurable: { thread_id: "1" } };
    chunks = [];
    for await (const chunk of await appWithInterrupt.stream(
      {
        messages: [inputMessage],
      },
      config
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      {
        agent: {
          messages: expectedOutputMessages[1],
        },
      },
    ]);
    const appWithInterruptState = await appWithInterrupt.getState(config);
    expect(appWithInterruptState).toEqual({
      values: {
        messages: expectedOutputMessages.slice(0, 2),
      },
      next: ["tools"],
      metadata: {
        source: "loop",
        step: 1,
        writes: {
          agent: {
            messages: expectedOutputMessages[1],
          },
        },
      },
      config: (await appWithInterrupt.checkpointer?.getTuple(config))?.config,
      createdAt: (await appWithInterrupt.checkpointer?.getTuple(config))
        ?.checkpoint.ts,
      // TODO: Populate, see Python test
      parentConfig: undefined,
    });

    // modify ai message
    const lastMessage =
      appWithInterruptState!.values.messages[
        appWithInterruptState!.values.messages.length - 1
      ];
    lastMessage.tool_calls[0].args.query = "a different query";
    await appWithInterrupt.updateState(config, {
      messages: lastMessage,
      something_extra: "hi there",
    });
    expect(await appWithInterrupt.getState(config)).toEqual({
      values: {
        messages: [
          expectedOutputMessages[0],
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: [
              {
                id: "tool_call123",
                name: "search_api",
                args: { query: "a different query" },
                type: "tool_call",
              },
            ],
          }),
        ],
      },
      next: ["tools"],
      metadata: {
        source: "update",
        step: 2,
        writes: {
          agent: {
            messages: new AIMessage({
              id: "ai1",
              content: "",
              tool_calls: [
                {
                  id: "tool_call123",
                  name: "search_api",
                  args: { query: "a different query" },
                  type: "tool_call",
                },
              ],
            }),
            something_extra: "hi there",
          },
        },
      },
      config: (await appWithInterrupt.checkpointer?.getTuple(config))?.config,
      createdAt: (await appWithInterrupt.checkpointer?.getTuple(config))
        ?.checkpoint.ts,
      // TODO: Populate, see Python test
      parentConfig: undefined,
    });

    chunks = [];
    for await (const chunk of await appWithInterrupt.stream(null, config)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      {
        tools: {
          messages: new ToolMessage({
            id: "abc",
            content: "result for a different query",
            name: "search_api",
            tool_call_id: "tool_call123",
          }),
        },
      },
      {
        agent: {
          messages: expectedOutputMessages[3],
        },
      },
    ]);

    expect(await appWithInterrupt.getState(config)).toEqual({
      values: {
        messages: [
          expectedOutputMessages[0],
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: [
              {
                id: "tool_call123",
                name: "search_api",
                args: { query: "a different query" },
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            id: "abc",
            content: "result for a different query",
            name: "search_api",
            tool_call_id: "tool_call123",
          }),
          expectedOutputMessages[3],
        ],
      },
      next: ["tools", "tools"],
      metadata: {
        source: "loop",
        step: 4,
        writes: {
          agent: {
            messages: expectedOutputMessages[3],
          },
        },
      },
      createdAt: (await appWithInterrupt.checkpointer?.getTuple(config))
        ?.checkpoint.ts,
      config: (await appWithInterrupt.checkpointer?.getTuple(config))?.config,
      // TODO: Populate, see Python test
      parentConfig: undefined,
    });

    // replaces message even if object identity is different, as long as id is the same
    await appWithInterrupt.updateState(config, {
      messages: new AIMessage({
        id: "ai2",
        content: "answer",
      }),
      something_extra: "hi there",
    });

    expect(await appWithInterrupt.getState(config)).toEqual({
      values: {
        messages: [
          expectedOutputMessages[0],
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: [
              {
                id: "tool_call123",
                name: "search_api",
                args: { query: "a different query" },
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            id: "abc",
            content: "result for a different query",
            name: "search_api",
            tool_call_id: "tool_call123",
          }),
          new AIMessage({
            content: "answer",
            id: "ai2",
          }),
        ],
      },
      next: [],
      metadata: {
        source: "update",
        step: 5,
        writes: {
          agent: {
            messages: new AIMessage({
              content: "answer",
              id: "ai2",
            }),
            something_extra: "hi there",
          },
        },
      },
      createdAt: (await appWithInterrupt.checkpointer?.getTuple(config))
        ?.checkpoint.ts,
      config: (await appWithInterrupt.checkpointer?.getTuple(config))?.config,
      // TODO: Populate, see Python test
      parentConfig: undefined,
    });
  });

  it("multiple stream mode", async () => {
    const builder = new StateGraph({
      value: Annotation<number>({ reducer: (a, b) => a + b }),
    })
      .addNode("add_one", () => ({ value: 1 }))
      .addEdge(START, "add_one")
      .addConditionalEdges("add_one", (state) => {
        if (state.value < 6) return "add_one";
        return END;
      });

    const graph = builder.compile();

    expect(
      await fromAsync(graph.stream({ value: 1 }, { streamMode: ["values"] }))
    ).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
      { value: 4 },
      { value: 5 },
      { value: 6 },
    ]);

    expect(
      await fromAsync(graph.stream({ value: 1 }, { streamMode: ["updates"] }))
    ).toEqual([
      { add_one: { value: 1 } },
      { add_one: { value: 1 } },
      { add_one: { value: 1 } },
      { add_one: { value: 1 } },
      { add_one: { value: 1 } },
    ]);

    expect(
      await fromAsync(
        graph.stream({ value: 1 }, { streamMode: ["values", "updates"] })
      )
    ).toEqual([
      ["values", { value: 1 }],
      ["updates", { add_one: { value: 1 } }],
      ["values", { value: 2 }],
      ["updates", { add_one: { value: 1 } }],
      ["values", { value: 3 }],
      ["updates", { add_one: { value: 1 } }],
      ["values", { value: 4 }],
      ["updates", { add_one: { value: 1 } }],
      ["values", { value: 5 }],
      ["updates", { add_one: { value: 1 } }],
      ["values", { value: 6 }],
    ]);
  });
});

describe("PreBuilt", () => {
  class SearchAPI extends Tool {
    name = "search_api";

    description = "A simple API that returns the input string.";

    constructor() {
      super();
    }

    async _call(query: string): Promise<string> {
      return `result for ${query}`;
    }
  }
  const tools = [new SearchAPI()];

  it("Can invoke createAgentExecutor", async () => {
    const prompt = PromptTemplate.fromTemplate("Hello!");

    const llm = new FakeStreamingLLM({
      responses: [
        "tool:search_api:query",
        "tool:search_api:another",
        "finish:answer",
      ],
    });

    const agentParser = (input: string) => {
      if (input.startsWith("finish")) {
        const answer = input.split(":")[1];
        return {
          returnValues: { answer },
          log: input,
        };
      }
      const [, toolName, toolInput] = input.split(":");
      return {
        tool: toolName,
        toolInput,
        log: input,
      };
    };

    const agent = prompt.pipe(llm).pipe(agentParser);

    const agentExecutor = createAgentExecutor({
      agentRunnable: agent,
      tools,
    });

    const result = await agentExecutor.invoke({
      input: "what is the weather in sf?",
    });

    expect(result).toEqual({
      input: "what is the weather in sf?",
      agentOutcome: {
        returnValues: {
          answer: "answer",
        },
        log: "finish:answer",
      },
      steps: [
        {
          action: {
            log: "tool:search_api:query",
            tool: "search_api",
            toolInput: "query",
          },
          observation: "result for query",
        },
        {
          action: {
            log: "tool:search_api:another",
            tool: "search_api",
            toolInput: "another",
          },
          observation: "result for another",
        },
      ],
    });
  });
});

describe("MessageGraph", () => {
  class SearchAPI extends Tool {
    name = "search_api";

    description = "A simple API that returns the input string.";

    schema = z
      .object({
        input: z.string().optional(),
      })
      .transform((data) => data.input);

    constructor() {
      super();
    }

    async _call(query: string): Promise<string> {
      return `result for ${query}`;
    }
  }
  const tools = [new SearchAPI()];

  it("can invoke a single message", async () => {
    const model = new FakeChatModel({
      responses: [
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "query",
            },
          },
        }),
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "another",
            },
          },
        }),
        new AIMessage({
          content: "answer",
        }),
      ],
    });

    const toolExecutor = new ToolExecutor({ tools });

    const shouldContinue = (data: Array<BaseMessage>): string => {
      const lastMessage = data[data.length - 1];
      // If there is no function call, then we finish
      if (
        !("function_call" in lastMessage.additional_kwargs) ||
        !lastMessage.additional_kwargs.function_call
      ) {
        return "end";
      }
      // Otherwise if there is, we continue
      return "continue";
    };

    const callTool = async (
      data: Array<BaseMessage>,
      options?: { config?: RunnableConfig }
    ) => {
      const lastMessage = data[data.length - 1];

      const action = {
        tool: lastMessage.additional_kwargs.function_call?.name ?? "",
        toolInput: lastMessage.additional_kwargs.function_call?.arguments ?? "",
        log: "",
      };

      const response = await toolExecutor.invoke(action, options?.config);
      return new FunctionMessage({
        content: JSON.stringify(response),
        name: action.tool,
      });
    };

    const app = new MessageGraph()
      .addNode("agent", model)
      .addNode("action", callTool)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", shouldContinue, {
        continue: "action",
        end: END,
      })
      .addEdge("action", "agent")
      .compile();

    const result = await app.invoke(
      new HumanMessage("what is the weather in sf?")
    );

    expect(result).toHaveLength(6);
    expect(JSON.stringify(result)).toEqual(
      JSON.stringify([
        new HumanMessage("what is the weather in sf?"),
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "query",
            },
          },
        }),
        new FunctionMessage({
          content: '"result for query"',
          name: "search_api",
        }),
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "another",
            },
          },
        }),
        new FunctionMessage({
          content: '"result for another"',
          name: "search_api",
        }),
        new AIMessage("answer"),
      ])
    );
  });

  it("can stream a list of messages", async () => {
    const model = new FakeChatModel({
      responses: [
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "query",
            },
          },
        }),
        new AIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "another",
            },
          },
        }),
        new AIMessage({
          content: "answer",
        }),
      ],
    });

    const toolExecutor = new ToolExecutor({ tools });

    const shouldContinue = (data: Array<BaseMessage>): string => {
      const lastMessage = data[data.length - 1];
      // If there is no function call, then we finish
      if (
        !("function_call" in lastMessage.additional_kwargs) ||
        !lastMessage.additional_kwargs.function_call
      ) {
        return "end";
      }
      // Otherwise if there is, we continue
      return "continue";
    };

    const callTool = async (
      data: Array<BaseMessage>,
      options?: { config?: RunnableConfig }
    ) => {
      const lastMessage = data[data.length - 1];

      const action = {
        tool: lastMessage.additional_kwargs.function_call?.name ?? "",
        toolInput: lastMessage.additional_kwargs.function_call?.arguments ?? "",
        log: "",
      };

      const response = await toolExecutor.invoke(action, options?.config);
      return new FunctionMessage({
        content: JSON.stringify(response),
        name: action.tool,
      });
    };
    const app = new MessageGraph()
      .addNode("agent", model)
      .addNode("action", callTool)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", shouldContinue, {
        continue: "action",
        end: END,
      })
      .addEdge("action", "agent")
      .compile();

    const stream = await app.stream([
      new HumanMessage("what is the weather in sf?"),
    ]);
    const streamItems = [];
    for await (const item of stream) {
      streamItems.push(item);
    }

    const lastItem = streamItems[streamItems.length - 1];
    expect(Object.keys(lastItem)).toEqual(["agent"]);
    expect(JSON.stringify(Object.values(lastItem)[0])).toEqual(
      JSON.stringify(new AIMessage("answer"))
    );
  });
});

it("StateGraph start branch then end", async () => {
  type State = {
    my_key: string;
    market: string;
  };

  const invalidBuilder = new StateGraph<State>({
    channels: {
      my_key: { reducer: (x: string, y: string) => x + y },
      market: null,
    },
  })
    .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
    .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
    .addConditionalEdges(START, (state: State) =>
      state.market === "DE" ? "tool_two_slow" : "tool_two_fast"
    );

  expect(() => invalidBuilder.compile()).toThrowError(
    "Node `tool_two_slow` is a dead-end"
  );

  const toolTwoBuilder = new StateGraph<State>({
    channels: {
      my_key: { reducer: (x: string, y: string) => x + y },
      market: null,
    },
  })
    .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
    .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
    .addConditionalEdges({
      source: START,
      path: (state: State) =>
        state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
    })
    .addEdge("tool_two_fast", END)
    .addEdge("tool_two_slow", END);

  const toolTwo = toolTwoBuilder.compile();

  expect(await toolTwo.invoke({ my_key: "value", market: "DE" })).toEqual({
    my_key: "value slow",
    market: "DE",
  });
  expect(await toolTwo.invoke({ my_key: "value", market: "US" })).toEqual({
    my_key: "value fast",
    market: "US",
  });

  const toolTwoWithCheckpointer = toolTwoBuilder.compile({
    checkpointer: SqliteSaver.fromConnString(":memory:"),
    interruptBefore: ["tool_two_fast", "tool_two_slow"],
  });

  await expect(() =>
    toolTwoWithCheckpointer.invoke({ my_key: "value", market: "DE" })
  ).rejects.toThrowError("thread_id");

  async function last<T>(iter: AsyncIterableIterator<T>): Promise<T> {
    // eslint-disable-next-line no-undef-init
    let value: T | undefined = undefined;
    for await (value of iter) {
      // do nothing
    }
    return value as T;
  }

  const thread1 = { configurable: { thread_id: "1" } };
  expect(
    await toolTwoWithCheckpointer.invoke(
      { my_key: "value", market: "DE" },
      thread1
    )
  ).toEqual({ my_key: "value", market: "DE" });
  expect(await toolTwoWithCheckpointer.getState(thread1)).toEqual({
    values: { my_key: "value", market: "DE" },
    next: ["tool_two_slow"],
    config: (await toolTwoWithCheckpointer.checkpointer!.getTuple(thread1))!
      .config,
    createdAt: (await toolTwoWithCheckpointer.checkpointer!.getTuple(thread1))!
      .checkpoint.ts,
    metadata: { source: "loop", step: 0, writes: null },
    parentConfig: (
      await last(toolTwoWithCheckpointer.checkpointer!.list(thread1, 2))
    ).config,
  });

  expect(await toolTwoWithCheckpointer.invoke(null, thread1)).toEqual({
    my_key: "value slow",
    market: "DE",
  });
  expect(await toolTwoWithCheckpointer.getState(thread1)).toEqual({
    values: { my_key: "value slow", market: "DE" },
    next: [],
    config: (await toolTwoWithCheckpointer.checkpointer!.getTuple(thread1))!
      .config,
    createdAt: (await toolTwoWithCheckpointer.checkpointer!.getTuple(thread1))!
      .checkpoint.ts,
    metadata: {
      source: "loop",
      step: 1,
      writes: { tool_two_slow: { my_key: " slow" } },
    },
    parentConfig: (
      await last(toolTwoWithCheckpointer.checkpointer!.list(thread1, 2))
    ).config,
  });
});

it("StateGraph branch then node", async () => {
  interface State {
    my_key: string;
    market: string;
  }

  const invalidBuilder = new StateGraph<State>({
    channels: {
      my_key: { reducer: (x: string, y: string) => x + y },
      market: null,
    },
  })
    .addNode("prepare", (_: State) => ({ my_key: ` prepared` }))
    .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
    .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
    .addNode("finish", (_: State) => ({ my_key: ` finished` }))
    .addEdge(START, "prepare")
    .addConditionalEdges({
      source: "prepare",
      path: (state: State) =>
        state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
      pathMap: ["tool_two_slow", "tool_two_fast"],
    })
    .addEdge("finish", END);

  expect(() => invalidBuilder.compile()).toThrowError();

  const toolBuilder = new StateGraph<State>({
    channels: {
      my_key: { reducer: (x: string, y: string) => x + y },
      market: null,
    },
  })
    .addNode("prepare", (_: State) => ({ my_key: ` prepared` }))
    .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
    .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
    .addNode("finish", (_: State) => ({ my_key: ` finished` }))
    .addEdge(START, "prepare")
    .addConditionalEdges({
      source: "prepare",
      path: (state: State) =>
        state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
    })
    .addEdge("tool_two_fast", "finish")
    .addEdge("tool_two_slow", "finish")
    .addEdge("finish", END);

  const tool = toolBuilder.compile();

  expect(await tool.invoke({ my_key: "value", market: "DE" })).toEqual({
    my_key: "value prepared slow finished",
    market: "DE",
  });
  expect(await tool.invoke({ my_key: "value", market: "FR" })).toEqual({
    my_key: "value prepared fast finished",
    market: "FR",
  });
});
