import { describe, expect, it, vi } from "vitest";
import { RunnableConfig, RunnablePassthrough } from "@langchain/core/runnables";
import { ChannelWrite, PASSTHROUGH, SKIP_WRITE } from "./write.js";
import { CONFIG_KEY_SEND, Send, TASKS } from "../constants.js";
import { InvalidUpdateError } from "../errors.js";

describe("ChannelWrite", () => {
  it("should write a value to a channel", async () => {
    // Setup write tracking
    const writes: Array<[string, string]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, string]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a channel write
    const write = new ChannelWrite([
      { channel: "output", value: "test_output" },
    ]);

    // Run the write with input
    const result = await write.invoke("input_value", config);

    // Verify the input is passed through
    expect(result).toBe("input_value");

    // Verify the write happened
    expect(writes).toEqual([["output", "test_output"]]);
  });

  it("should support writing multiple channels", async () => {
    // Setup write tracking
    const writes: Array<[string, string]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, string]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a channel write with multiple channels
    const write = new ChannelWrite([
      { channel: "output1", value: "value1" },
      { channel: "output2", value: "value2" },
    ]);

    // Run the write with input
    await write.invoke("input_value", config);

    // Verify the writes happened
    expect(writes).toEqual([
      ["output1", "value1"],
      ["output2", "value2"],
    ]);
  });

  it("should support using PASSTHROUGH to pass input value to channel", async () => {
    // Setup write tracking
    const writes: Array<[string, string]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, string]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a channel write with PASSTHROUGH
    const write = new ChannelWrite([{ channel: "output", value: PASSTHROUGH }]);

    // Run the write with input
    await write.invoke("input_value", config);

    // Verify the input value was written to the channel
    expect(writes).toEqual([["output", "input_value"]]);
  });

  it("should support using mapper to transform value", async () => {
    // Setup write tracking
    const writes: Array<[string, string]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, string]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a transformer as a Runnable
    const transformer = new RunnablePassthrough().pipe(
      (value: string) => `transformed_${value}`
    );

    // Create a channel write with a mapper
    const write = new ChannelWrite([
      { channel: "output", value: "original", mapper: transformer },
    ]);

    // Run the write
    await write.invoke("input_value", config);

    // Verify the transformed value was written
    expect(writes).toEqual([["output", "transformed_original"]]);
  });

  it("should support SKIP_WRITE to conditionally skip writing", async () => {
    // Setup write tracking
    const writes: Array<[string, string]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, string]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a mapper that returns SKIP_WRITE
    const conditionalMapper = new RunnablePassthrough().pipe(
      (_: unknown) => SKIP_WRITE
    );

    // Create a channel write with writes that should and shouldn't happen
    const write = new ChannelWrite([
      { channel: "output1", value: "value1" },
      { channel: "output2", value: "value2", mapper: conditionalMapper },
    ]);

    // Run the write
    await write.invoke("input_value", config);

    // Verify only the first write happened
    expect(writes).toEqual([["output1", "value1"]]);
  });

  it("should handle Send objects by writing to TASKS", async () => {
    // Setup write tracking
    const writes: Array<[string, Send]> = [];

    // Mock config with send function
    const mockSend = vi
      .fn<(values: Array<[string, Send]>) => void>()
      .mockImplementation((values) => {
        writes.push(...values);
      });

    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: mockSend,
      },
    };

    // Create a Send object
    const send = new Send("target_node", { arg: "value" });

    // Create a channel write with a Send
    const write = new ChannelWrite([send]);

    // Run the write
    await write.invoke("input_value", config);

    // Verify the Send was written to the TASKS channel
    expect(writes).toEqual([[TASKS, send]]);
  });

  it("should throw error when trying to write to reserved TASKS channel", async () => {
    // Create a channel write with an invalid channel
    const write = new ChannelWrite([{ channel: TASKS, value: "value" }]);

    // Mock config with send function
    const config: RunnableConfig = {
      configurable: {
        [CONFIG_KEY_SEND]: vi.fn(),
      },
    };

    // Verify it throws an error
    await expect(write.invoke("input_value", config)).rejects.toThrow(
      InvalidUpdateError
    );
    await expect(write.invoke("input_value", config)).rejects.toThrow(
      "Cannot write to the reserved channel TASKS"
    );
  });
});

describe("ChannelWrite tracing", () => {
  it("should have trace disabled to avoid cluttering trace views", () => {
    const write = new ChannelWrite([{ channel: "output", value: "value" }]);
    expect(write.trace).toBe(false);
  });
});

describe("ChannelWrite static methods", () => {
  it("isWriter should identify ChannelWrite instances", () => {
    const write = new ChannelWrite([{ channel: "output", value: "value" }]);

    expect(ChannelWrite.isWriter(write)).toBe(true);
  });

  it("registerWriter should mark a Runnable as a writer", () => {
    const runnable = new RunnablePassthrough();
    const writer = ChannelWrite.registerWriter(runnable);

    expect(ChannelWrite.isWriter(writer)).toBe(true);
  });
});
