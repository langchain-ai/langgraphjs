import { describe, expect, it } from "vitest";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { uuid6 } from "@langchain/langgraph-checkpoint";
import {
  mapInput,
  mapOutputUpdates,
  mapOutputValues,
  readChannel,
  readChannels,
  single,
} from "../pregel/io.js";
import { PregelExecutableTask } from "../pregel/types.js";
import { BaseChannel } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError } from "../errors.js";

describe("single", () => {
  it("returns first value of iterator and closes it", () => {
    let closed = false;
    function* myiter() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }

    expect(single(myiter())).toBe(1);
    expect(closed).toBe(true);
  });
});

describe("readChannel", () => {
  it("should read a channel successfully", () => {
    // set up test
    const channel = new LastValue<number>();
    channel.update([3]);

    const channels: Record<string, BaseChannel> = {
      someChannelName: channel,
    };

    // call method / assertions
    const newChannel = readChannel(channels, "someChannelName");
    expect(newChannel).toBe(3);
  });

  it("should return EmptyChannelError when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    const error = readChannel(channels, "someChannelName", true, true);
    expect(error).toBeInstanceOf(EmptyChannelError);
  });

  it("should return null when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    const error = readChannel(channels, "someChannelName", true, false);
    expect(error).toBeNull();
  });

  it("should throw an error when the channel is empty", () => {
    // set up test
    const channels: Record<string, BaseChannel> = {
      someChannelName: new LastValue<number>(),
    };

    // call method / assertions
    expect(() => {
      readChannel(channels, "someChannelName", false, false);
    }).toThrow(EmptyChannelError);
  });
});

describe("readChannels", () => {
  it("should return a single channel value", () => {
    // set up test
    const channel = new LastValue<number>();
    channel.update([3]);

    const channels: Record<string, BaseChannel> = {
      someChannelName: channel,
    };

    // call method / assertions
    const newChannel = readChannels(channels, "someChannelName");
    expect(newChannel).toBe(3);
  });

  it("should return multiple channel values", () => {
    // set up test
    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    const emptyChannel = new LastValue<number>();
    channel1.update([3]);
    channel2.update([4]);

    const channels: Record<string, BaseChannel> = {
      someChannelName1: channel1,
      someChannelName2: channel2,
      someChannelName3: emptyChannel,
    };

    // call method / assertions
    const channelValues = readChannels(channels, [
      "someChannelName1",
      "someChannelName2",
      "someChannelName3",
    ]);
    expect(channelValues).toEqual({ someChannelName1: 3, someChannelName2: 4 });
  });

  it("should return multiple channel values including null for empty channels", () => {
    // set up test
    const channel1 = new LastValue<number>();
    const channel2 = new LastValue<number>();
    const emptyChannel = new LastValue<number>();
    channel1.update([3]);
    channel2.update([4]);

    const channels: Record<string, BaseChannel> = {
      someChannelName1: channel1,
      someChannelName2: channel2,
      someChannelName3: emptyChannel,
    };

    // call method / assertions
    const channelValues = readChannels(
      channels,
      ["someChannelName1", "someChannelName2", "someChannelName3"],
      false
    );
    expect(channelValues).toEqual({
      someChannelName1: 3,
      someChannelName2: 4,
      someChannelName3: null,
    });
  });
});

describe("mapInput", () => {
  it("should return an empty Generator", () => {
    // call method / assertions
    const emptyGenerator = mapInput("someChannelName");
    const tuples = [];
    for (const tuple of emptyGenerator) {
      tuples.push(tuple);
    }
    expect(tuples.length).toBe(0);
  });

  it("should return a Generator that yields a single tuple", () => {
    // call method / assertions
    const emptyGenerator = mapInput("someChannelName", "some chunk");
    const tuples = [];
    for (const tuple of emptyGenerator) {
      tuples.push(tuple);
    }
    expect(tuples.length).toBe(1);
    expect(tuples[0]).toEqual(["someChannelName", "some chunk"]);
  });

  it("should return a Generator that yields multiple tuples", () => {
    // set up test
    const channelNames = ["someChannelName1", "someChannelName2"];
    const chunk = {
      someChannelName1: "some chunk 1",
    };

    // call method / assertions
    const emptyGenerator = mapInput(channelNames, chunk);
    const tuples = [];
    for (const tuple of emptyGenerator) {
      tuples.push(tuple);
    }
    expect(tuples.length).toBe(1);
    expect(tuples[0]).toEqual(["someChannelName1", "some chunk 1"]);
  });

  it("should throw an error if an invalid chunk type is provided", async () => {
    // set up test
    const channelNames = ["someChannelName1", "someChannelName2"];
    const chunk = ["array", "of", "chunks"];

    // call method / assertions
    await expect(() => {
      const generator = mapInput(channelNames, chunk);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ of generator) {
        // do nothing, error will be thrown
        continue;
      }
    }).toThrow(
      `Input chunk must be an object when "inputChannels" is an array`
    );
  });
});

describe("mapOutputValues", () => {
  it("should return a Generator that yields a single value", () => {
    // set up test
    const outputChannels = "someOutputChannelName2";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingWrites: Array<[string, any]> = [
      ["someOutputChannelName1", 1],
      ["someOutputChannelName2", 2],
    ];

    const lastValueChannel2 = new LastValue<number>();
    lastValueChannel2.update([3]);

    const channels = {
      someOutputChannelName1: new LastValue<number>(),
      someOutputChannelName2: lastValueChannel2,
    };

    // call method / assertions
    const generator = mapOutputValues(outputChannels, pendingWrites, channels);
    const values = [];
    for (const value of generator) {
      values.push(value);
    }
    expect(values.length).toBe(1);
    // value should be equal to the last value of channel
    expect(values[0]).toBe(3);
  });

  it("should return a Generator that yields an object", () => {
    // set up test
    const outputChannels = ["someOutputChannelName1", "someOutputChannelName2"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingWrites: Array<[string, any]> = [
      ["someOutputChannelName1", 1],
      ["someOutputChannelName2", 2],
    ];

    const lastValueChannel1 = new LastValue<number>();
    const lastValueChannel2 = new LastValue<number>();
    lastValueChannel1.update([3]);
    lastValueChannel2.update([4]);

    const channels = {
      someOutputChannelName1: lastValueChannel1,
      someOutputChannelName2: lastValueChannel2,
    };

    // call method / assertions
    const generator = mapOutputValues(outputChannels, pendingWrites, channels);
    const values = [];
    for (const value of generator) {
      values.push(value);
    }
    expect(values.length).toBe(1);
    expect(values[0]).toEqual({
      someOutputChannelName1: 3,
      someOutputChannelName2: 4,
    });
  });

  it("should return an empty Generator", () => {
    // set up test
    const outputChannels = "someOutputChannelName1";
    const outputChannelsList = ["someOutputChannelName1"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pendingWrites: Array<[string, any]> = [
      ["someOutputChannelName2", 2],
      ["someOutputChannelName2", 3],
    ];

    const channels = {
      someOutputChannelName1: new LastValue<number>(),
      someOutputChannelName2: new LastValue<number>(),
    };

    // call method / assertions
    const generator1 = mapOutputValues(outputChannels, pendingWrites, channels);
    const values = [];
    for (const value of generator1) {
      values.push(value);
    }
    expect(values.length).toBe(0);

    const generator2 = mapOutputValues(
      outputChannelsList,
      pendingWrites,
      channels
    );
    for (const value of generator2) {
      values.push(value);
    }
    expect(values.length).toBe(0);
  });
});

describe("mapOutputUpdates", () => {
  it("should return a Generator that yields an object - {string: any}", () => {
    // set up test
    const outputChannels = "someOutputChannelName";
    const tasks: PregelExecutableTask<
      "task1" | "task2" | "task3",
      "someOutputChannelName"
    >[] = [
      {
        id: uuid6(-1),
        name: "task1",
        input: null,
        proc: new RunnablePassthrough(),
        writes: [["someOutputChannelName", 1]],
        triggers: [],
        config: undefined,
        writers: [],
      },
      {
        id: uuid6(-1),
        name: "task2",
        input: null,
        proc: new RunnablePassthrough(),
        writes: [["someOutputChannelName", 2]],
        triggers: [],
        config: {
          tags: ["langsmith:hidden"], // this task should be filtered out
        },
        writers: [],
      },
      {
        name: "task3",
        input: null,
        proc: new RunnablePassthrough(),
        // @ts-expect-error invalid write
        writes: [["someOutputChannelNameThatDoesntMatch", 3]], // this task should be filtered out
        config: undefined,
      },
    ];

    // call method / assertions
    const generator = mapOutputUpdates(
      outputChannels,
      tasks.map((task) => [task, task.writes])
    );
    const values = [];
    for (const value of generator) {
      values.push(value);
    }
    expect(values.length).toBe(1);
    expect(values[0]).toEqual({ task1: 1 });
  });

  it("should return a Generator that yields an object - {string: {string: any}}", () => {
    // set up test
    const outputChannels = [
      "someOutputChannelName1",
      "someOutputChannelName2",
      "someOutputChannelName3",
    ];
    const tasks: PregelExecutableTask<
      "task1" | "task2",
      | "someOutputChannelName1"
      | "someOutputChannelName2"
      | "someOutputChannelName3"
      | "someOutputChannelName4"
    >[] = [
      {
        id: uuid6(-1),
        name: "task1",
        input: null,
        proc: new RunnablePassthrough(),
        writes: [
          ["someOutputChannelName1", 1],
          ["someOutputChannelName2", 2],
        ],
        triggers: [],
        config: undefined,
        writers: [],
      },
      {
        id: uuid6(-1),
        name: "task2",
        input: null,
        proc: new RunnablePassthrough(),
        writes: [
          ["someOutputChannelName3", 3],
          ["someOutputChannelName4", 4],
        ],
        triggers: [],
        config: undefined,
        writers: [],
      },
    ];

    // call method / assertions
    const generator = mapOutputUpdates(
      outputChannels,
      tasks.map((task) => [task, task.writes])
    );
    const values = [];
    for (const value of generator) {
      values.push(value);
    }
    expect(values.length).toBe(1);

    const expectedValue = {
      task1: {
        someOutputChannelName1: 1,
        someOutputChannelName2: 2,
      },
      task2: {
        someOutputChannelName3: 3,
      },
    };
    expect(values[0]).toEqual(expectedValue);
  });
});
