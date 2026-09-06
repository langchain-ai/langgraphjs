import { describe, expect, it, vi } from "vitest";
import { RunnableConfig } from "@langchain/core/runnables";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND } from "../constants.js";
import { LastValue } from "../channels/last_value.js";
import { ChannelRead, PregelNode } from "./read.js";
import { ChannelWrite } from "./write.js";
import { RunnableCallable } from "../utils.js";
import { FakeTracer } from "../tests/utils.js";
import { omitPayload } from "./utils/index.js";

describe("ChannelRead", () => {
  it("should read a single channel value", async () => {
    // Setup mock read function
    const mockRead = vi
      .fn<(channel: string | string[]) => "test_value" | null>()
      .mockImplementation((channel: string | string[]) => {
        if (channel === "test_channel") {
          return "test_value";
        }
        return null;
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_READ]: mockRead,
      },
    };

    // Create channel read
    const channelRead = new ChannelRead("test_channel");

    // Run the channel read with our config
    const result = await channelRead.invoke(null, config);

    // Verify results
    expect(result).toBe("test_value");
  });

  it("should read multiple channel values", async () => {
    // Setup mock read function
    const mockRead = vi
      .fn<
        (
          channels: string | string[]
        ) => { channel1: string; channel2: string } | null
      >()
      .mockImplementation((channels: string | string[]) => {
        if (Array.isArray(channels)) {
          return {
            channel1: "value1",
            channel2: "value2",
          };
        }
        return null;
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_READ]: mockRead,
      },
    };

    // Create channel read for multiple channels
    const channelRead = new ChannelRead(["channel1", "channel2"]);

    // Run the channel read with our config
    const result = await channelRead.invoke(null, config);

    // Verify results
    expect(result).toEqual({
      channel1: "value1",
      channel2: "value2",
    });
  });

  it("should apply a mapper function to the channel value", async () => {
    // Setup mock read function
    const mockRead = vi.fn().mockImplementation(() => "test_value");

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_READ]: mockRead,
      },
    };

    // Create mapper function
    const mapper = (value: string) => `mapped_${value}`;

    // Create channel read with mapper
    const channelRead = new ChannelRead("test_channel", mapper);

    // Run the channel read with our config
    const result = await channelRead.invoke(null, config);

    // Verify results
    expect(result).toBe("mapped_test_value");
  });

  it("should have trace disabled to avoid cluttering trace views", () => {
    const channelRead = new ChannelRead("test_channel");
    expect(channelRead.trace).toBe(false);
  });

  it("should throw an error if no read function is configured", async () => {
    // Create channel read without configuring a read function
    const channelRead = new ChannelRead("test_channel");
    const config: RunnableConfig = {};

    // Run the channel read with empty config
    await expect(channelRead.invoke(null, config)).rejects.toThrow(
      "not configured with a read function"
    );
  });
});

describe("PregelNode", () => {
  it("preserves trace policies across join and every pipe branch", async () => {
    const tracePolicy = {
      processInputs: omitPayload,
      processOutputs: omitPayload,
    };
    const base = new PregelNode({
      channels: { input: "input" },
      triggers: ["input"],
      tracePolicy,
    });
    const action = new RunnableCallable({
      func: (input: number) => input + 1,
      trace: false,
    });
    const bound = base.pipe(action);
    const twice = bound.pipe(action);
    const writer = new ChannelWrite([{ channel: "output", value: "written" }]);
    const withWriter = twice.pipe(writer);
    const joined = withWriter.join(["extra"]);
    for (const node of [base, bound, twice, withWriter, joined]) {
      expect(node.tracePolicy).toBe(tracePolicy);
    }
    const tracer = new FakeTracer();
    const send = vi.fn();
    expect(
      await joined
        .getNode()
        ?.invoke(1, {
          callbacks: [tracer],
          configurable: { [CONFIG_KEY_SEND]: send },
        })
    ).toBe(3);
    expect(send).toHaveBeenCalledWith([["output", "written"]]);
    expect(tracer.runs[0].inputs).toEqual({});
    expect(tracer.runs[0].outputs).toEqual({});
    expect(tracer.runs[0].child_runs[0].inputs).toEqual({ input: 1 });
  });

  it("applies policies to multiple writers and preserves single-step shortcuts", async () => {
    const tracePolicy = {
      processInputs: omitPayload,
      processOutputs: omitPayload,
    };
    const base = { channels: ["input"], triggers: ["input"], tracePolicy };
    const action = new RunnableCallable({
      func: (input: number) => input + 1,
      trace: false,
    });
    expect(new PregelNode(base).getNode()).toBeUndefined();
    expect(new PregelNode({ ...base, writers: [action] }).getNode()).toBe(
      action
    );
    expect(new PregelNode({ ...base, bound: action }).getNode()).toBe(action);
    const tracer = new FakeTracer();
    const node = new PregelNode({
      ...base,
      writers: [action, action],
    }).getNode();
    expect(await node?.invoke(1, { callbacks: [tracer] })).toBe(3);
    expect(tracer.runs[0].inputs).toEqual({});
    expect(tracer.runs[0].outputs).toEqual({});
  });

  it("should create a node that subscribes to channels", () => {
    const node = new PregelNode({
      channels: ["input", "context"],
      triggers: ["input"],
    });

    expect(node.channels).toEqual(["input", "context"]);
    expect(node.triggers).toEqual(["input"]);
  });

  it("should chain with ChannelWrite using pipe", () => {
    const node = new PregelNode({
      channels: ["input"],
      triggers: ["input"],
    });

    const write = new ChannelWrite([
      { channel: "output", value: "test_output" },
    ]);

    const pipeResult = node.pipe(write);

    expect(pipeResult.writers).toHaveLength(1);
    expect(pipeResult.writers[0]).toBe(write);
  });

  it("should combine multiple consecutive ChannelWrite instances", () => {
    const node = new PregelNode({
      channels: ["input"],
      triggers: ["input"],
    });

    const write1 = new ChannelWrite([{ channel: "output1", value: "value1" }]);

    const write2 = new ChannelWrite([{ channel: "output2", value: "value2" }]);

    // Chain two writes
    const pipeResult = node.pipe(write1).pipe(write2);

    // Get optimized writers
    const optimizedWriters = pipeResult.getWriters();

    // Should be combined into a single ChannelWrite
    expect(optimizedWriters).toHaveLength(1);
    expect(optimizedWriters[0]).toBeInstanceOf(ChannelWrite);
    expect((optimizedWriters[0] as ChannelWrite).writes).toHaveLength(2);
  });

  it("should join additional channels", () => {
    const node = new PregelNode({
      channels: { input: "input", context: "context" },
      triggers: ["input"],
    });

    const joinedNode = node.join(["history"]);

    expect(joinedNode.channels).toEqual({
      input: "input",
      context: "context",
      history: "history",
    });
  });
});

describe("Integrated Channel Read and Write", () => {
  it("should perform direct channel operations", async () => {
    // Use direct channel operations rather than depending on invoke

    // Setup test environment with real channels
    const channels = {
      input: new LastValue<string>(),
      output: new LastValue<string>(),
    };

    // Set initial value in input channel
    channels.input.update(["test_input"]);

    // Get value from input channel
    const inputValue = channels.input.get();
    expect(inputValue).toBe("test_input");

    // Process value
    const processedValue = `processed_${inputValue}`;

    // Write to output channel
    const updated = channels.output.update([processedValue]);
    expect(updated).toBe(true);

    // Read from output channel
    const outputValue = channels.output.get();
    expect(outputValue).toBe("processed_test_input");
  });

  it("should work with manual read and write operations", async () => {
    // Setup test environment with real channels
    const channels = {
      input: new LastValue<string>(),
      output: new LastValue<string>(),
    };

    // Initialize input channel with a value
    channels.input.update(["test_input"]);

    // Setup write tracking
    let writtenValue: string | null = null;

    // Manual read operation
    const readFunc = (channel: string): string | null => {
      if (channel === "input") {
        return channels.input.get();
      }
      return null;
    };

    // Manual write operation
    const writeFunc = (values: Array<[string, string]>): void => {
      for (const [channel, value] of values) {
        if (channel === "output") {
          writtenValue = value;
          channels.output.update([value]);
        }
      }
    };

    // Read from input channel
    const inputValue = readFunc("input");
    expect(inputValue).toBe("test_input");

    // Process the value
    const processedValue = `processed_${inputValue}`;

    // Write to output channel
    writeFunc([["output", processedValue]]);

    // Verify the write happened
    expect(writtenValue).toBe("processed_test_input");
    expect(channels.output.get()).toBe("processed_test_input");
  });
});
