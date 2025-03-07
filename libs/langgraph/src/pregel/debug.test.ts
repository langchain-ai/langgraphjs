import { describe, expect, it, jest } from "@jest/globals";
import { wrap, tasksWithWrites, _readChannels } from "./debug.js";
import { BaseChannel } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError } from "../errors.js";

describe("wrap", () => {
  it("should wrap text with color codes", () => {
    const color = {
      start: "\x1b[34m", // blue
      end: "\x1b[0m",
    };

    const text = "test text";
    const result = wrap(color, text);

    expect(result).toBe(`${color.start}${text}${color.end}`);
  });
});

describe("_readChannels", () => {
  it("should read values from channels", () => {
    const channels = {
      channel1: new LastValue<string>(),
      channel2: new LastValue<string>(),
    };

    // Update channels with values
    channels.channel1.update(["value1"]);
    channels.channel2.update(["42"]);

    const results = Array.from(_readChannels(channels));

    expect(results).toEqual([
      ["channel1", "value1"],
      ["channel2", "42"],
    ]);
  });

  it("should skip empty channels", () => {
    const mockEmptyChannel: BaseChannel<string> = {
      lc_graph_name: "MockChannel",
      lg_is_channel: true,
      ValueType: "" as string,
      UpdateType: [] as unknown[],
      get: jest.fn<() => string>().mockImplementation(() => {
        throw new EmptyChannelError("Empty channel");
      }),
      update: jest.fn<(values: unknown[]) => boolean>().mockReturnValue(true),
      checkpoint: jest.fn<() => unknown>(),
      fromCheckpoint: jest.fn<(checkpoint?: unknown) => BaseChannel<string>>().mockReturnThis(),
      consume: jest.fn<() => boolean>().mockReturnValue(false)
    };

    const channels = {
      channel1: new LastValue<string>(),
      emptyChannel: mockEmptyChannel,
    };

    // Update channel with value
    channels.channel1.update(["value1"]);

    const results = Array.from(_readChannels(channels));

    expect(results).toEqual([["channel1", "value1"]]);
  });

  it("should propagate non-empty channel errors", () => {
    const mockErrorChannel: BaseChannel<string> = {
      lc_graph_name: "MockChannel",
      lg_is_channel: true,
      ValueType: "" as string,
      UpdateType: [] as unknown[],
      get: jest.fn<() => string>().mockImplementation(() => {
        throw new Error("Other error");
      }),
      update: jest.fn<(values: unknown[]) => boolean>().mockReturnValue(true),
      checkpoint: jest.fn<() => unknown>(),
      fromCheckpoint: jest.fn<(checkpoint?: unknown) => BaseChannel<string>>().mockReturnThis(),
      consume: jest.fn<() => boolean>().mockReturnValue(false)
    };

    const channels = {
      channel1: new LastValue<string>(),
      errorChannel: mockErrorChannel,
    };
    
    channels.channel1.update(["value1"]);

    expect(() => Array.from(_readChannels(channels))).toThrow("Other error");
  });
});

describe("tasksWithWrites", () => {
  it("should return task descriptions with no writes", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] as ["PULL", string], interrupts: [] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] as ["PULL", string], interrupts: [] },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = tasksWithWrites(tasks, pendingWrites);

    expect(result).toEqual([
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"], interrupts: [] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] },
    ]);
  });

  it("should include error information", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] as ["PULL", string], interrupts: [] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] as ["PULL", string], interrupts: [] },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [["task1", "__error__", { message: "Test error" }]];

    const result = tasksWithWrites(tasks, pendingWrites);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: ["PULL", "Task 1"],
        error: { message: "Test error" },
        interrupts: [],
      },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] },
    ]);
  });

  it("should include state information", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] as ["PULL", string], interrupts: [] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] as ["PULL", string], interrupts: [] },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [];

    const states = {
      task1: { configurable: { key: "value" } },
    };

    const result = tasksWithWrites(tasks, pendingWrites, states);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: ["PULL", "Task 1"],
        interrupts: [],
        state: { configurable: { key: "value" } },
      },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] },
    ]);
  });

  it("should include interrupts", () => {
    const tasks = [{ id: "task1", name: "Task 1", path: ["PULL", "Task 1"] as ["PULL", string], interrupts: [] }];

    const pendingWrites: Array<[string, string, unknown]> = [
      ["task1", "__interrupt__", { value: "Interrupted", when: "during" }],
    ];

    const result = tasksWithWrites(tasks, pendingWrites);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: ["PULL", "Task 1"],
        interrupts: [{ value: "Interrupted", when: "during" }],
      },
    ]);
  });
});
