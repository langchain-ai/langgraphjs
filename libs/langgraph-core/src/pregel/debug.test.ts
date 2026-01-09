import { describe, expect, it, vi } from "vitest";
import { wrap, tasksWithWrites, _readChannels } from "./debug.js";
import { BaseChannel } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError } from "../errors.js";
import { ERROR, INTERRUPT, PULL } from "../constants.js";

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
      get: vi.fn<() => string>().mockImplementation(() => {
        throw new EmptyChannelError("Empty channel");
      }),
      update: vi.fn<(values: unknown[]) => boolean>().mockReturnValue(true),
      checkpoint: vi.fn<() => unknown>(),
      fromCheckpoint: vi
        .fn<(checkpoint?: unknown) => BaseChannel<string>>()
        .mockReturnThis(),
      consume: vi.fn<() => boolean>().mockReturnValue(false),
      finish: vi.fn<() => boolean>().mockReturnValue(false),
      isAvailable: vi.fn<() => boolean>().mockReturnValue(false),
      equals: vi.fn<(other: BaseChannel) => boolean>().mockReturnValue(false),
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
      get: vi.fn<() => string>().mockImplementation(() => {
        throw new Error("Other error");
      }),
      update: vi.fn<(values: unknown[]) => boolean>().mockReturnValue(true),
      checkpoint: vi.fn<() => unknown>(),
      fromCheckpoint: vi
        .fn<(checkpoint?: unknown) => BaseChannel<string>>()
        .mockReturnThis(),
      consume: vi.fn<() => boolean>().mockReturnValue(false),
      finish: vi.fn<() => boolean>().mockReturnValue(false),
      isAvailable: vi.fn<() => boolean>().mockImplementation(() => {
        throw new Error("Other error");
      }),
      equals: vi.fn<(other: BaseChannel) => boolean>().mockReturnValue(false),
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
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"] as [typeof PULL, string],
        interrupts: [],
      },
      {
        id: "task2",
        name: "Task 2",
        path: [PULL, "Task 2"] as [typeof PULL, string],
        interrupts: [],
      },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = tasksWithWrites(tasks, pendingWrites, undefined, [
      "Task 1",
      "Task 2",
    ]);

    expect(result).toEqual([
      { id: "task1", name: "Task 1", path: [PULL, "Task 1"], interrupts: [] },
      { id: "task2", name: "Task 2", path: [PULL, "Task 2"], interrupts: [] },
    ]);
  });

  it("should include error information", () => {
    const tasks = [
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"] as [typeof PULL, string],
        interrupts: [],
      },
      {
        id: "task2",
        name: "Task 2",
        path: [PULL, "Task 2"] as [typeof PULL, string],
        interrupts: [],
      },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [
      ["task1", ERROR, { message: "Test error" }],
    ];

    const result = tasksWithWrites(tasks, pendingWrites, undefined, [
      "Task 1",
      "Task 2",
    ]);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"],
        error: { message: "Test error" },
        interrupts: [],
      },
      { id: "task2", name: "Task 2", path: [PULL, "Task 2"], interrupts: [] },
    ]);
  });

  it("should include state information", () => {
    const tasks = [
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"] as [typeof PULL, string],
        interrupts: [],
      },
      {
        id: "task2",
        name: "Task 2",
        path: [PULL, "Task 2"] as [typeof PULL, string],
        interrupts: [],
      },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [];

    const states = {
      task1: { configurable: { key: "value" } },
    };

    const result = tasksWithWrites(tasks, pendingWrites, states, [
      "Task 1",
      "Task 2",
    ]);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"],
        interrupts: [],
        state: { configurable: { key: "value" } },
      },
      { id: "task2", name: "Task 2", path: [PULL, "Task 2"], interrupts: [] },
    ]);
  });

  it("should include interrupts", () => {
    const tasks = [
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"] as [typeof PULL, string],
        interrupts: [],
      },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [
      ["task1", INTERRUPT, { value: "Interrupted", when: "during" }],
    ];

    const result = tasksWithWrites(tasks, pendingWrites, undefined, ["task1"]);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"],
        interrupts: [{ value: "Interrupted", when: "during" }],
      },
    ]);
  });

  it("should include results", () => {
    const tasks = [
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"] as [typeof PULL, string],
        interrupts: [],
      },
      {
        id: "task2",
        name: "Task 2",
        path: [PULL, "Task 2"] as [typeof PULL, string],
        interrupts: [],
      },
      {
        id: "task3",
        name: "Task 3",
        path: [PULL, "Task 3"] as [typeof PULL, string],
        interrupts: [],
      },
    ];

    const pendingWrites: Array<[string, string, unknown]> = [
      ["task1", "Task 1", "Result"],
      ["task2", "Task 2", "Result 2"],
    ];

    const result = tasksWithWrites(tasks, pendingWrites, undefined, [
      "Task 1",
      "Task 2",
    ]);

    expect(result).toEqual([
      {
        id: "task1",
        name: "Task 1",
        path: [PULL, "Task 1"],
        interrupts: [],
        result: { "Task 1": "Result" },
      },
      {
        id: "task2",
        name: "Task 2",
        path: [PULL, "Task 2"],
        interrupts: [],
        result: { "Task 2": "Result 2" },
      },
      {
        id: "task3",
        name: "Task 3",
        path: [PULL, "Task 3"],
        interrupts: [],
        result: undefined,
      },
    ]);
  });
});
