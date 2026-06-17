import { describe, expect, it, vi } from "vitest";
import { wrap, tasksWithWrites, _readChannels, mapDebugTasks } from "./debug.js";
import { BaseChannel } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError } from "../errors.js";
import { ERROR, INTERRUPT, PULL } from "../constants.js";
import type { PregelExecutableTask } from "./types.js";
import type { LangGraphRunnableConfig } from "./runnable_types.js";

function makeTask(overrides: {
  id?: string;
  name?: string;
  input?: unknown;
  triggers?: string[];
  config?: LangGraphRunnableConfig;
}): PregelExecutableTask<string, string> {
  return {
    id: overrides.id ?? "t1",
    name: overrides.name ?? "tools",
    input: overrides.input ?? [],
    triggers: overrides.triggers ?? ["x"],
    config: overrides.config,
    writes: [],
  } as unknown as PregelExecutableTask<string, string>;
}

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

describe("mapDebugTasks", () => {
  it("forwards user-meaningful metadata when present", () => {
    const task = makeTask({
      config: { metadata: { lc_agent_name: "weather_agent" } },
    });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload.id).toBe("t1");
    expect(payload.name).toBe("tools");
    expect(payload.metadata).toEqual({ lc_agent_name: "weather_agent" });
  });

  it("omits metadata when the config metadata dict is empty", () => {
    const task = makeTask({ config: { metadata: {} } });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload).not.toHaveProperty("metadata");
  });

  it("omits metadata when config has no metadata key", () => {
    const task = makeTask({ config: {} });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload).not.toHaveProperty("metadata");
  });

  it("handles an undefined config without crashing", () => {
    const task = makeTask({ config: undefined });
    const payloads = Array.from(mapDebugTasks([task]));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("metadata");
  });

  it("drops internal framework metadata keys, keeping user-meaningful ones", () => {
    const task = makeTask({
      config: {
        metadata: {
          lc_agent_name: "weather_agent",
          ls_integration: "langchain_create_agent",
          my_user_key: "x",
          thread_id: "thread-1",
          langgraph_step: 1,
          langgraph_node: "tools",
          langgraph_path: ["__pregel_pull", "tools"],
          langgraph_checkpoint_ns: "tools:abc",
          checkpoint_ns: "",
        },
      },
    });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload.metadata).toEqual({
      lc_agent_name: "weather_agent",
      ls_integration: "langchain_create_agent",
      my_user_key: "x",
    });
  });

  it("does not mutate the source config metadata", () => {
    const metadata = { lc_agent_name: "a" };
    const task = makeTask({ config: { metadata } });
    const [payload] = Array.from(mapDebugTasks([task]));
    (metadata as Record<string, unknown>).lc_agent_name = "MUTATED";
    expect((payload.metadata as Record<string, unknown>).lc_agent_name).toBe(
      "a"
    );
  });

  it("folds filtered config tags into metadata under `tags`", () => {
    const task = makeTask({
      config: {
        metadata: { lc_agent_name: "weather_agent" },
        tags: ["seq:step:1", "user-tag", "session-123"],
      },
    });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload.metadata).toEqual({
      lc_agent_name: "weather_agent",
      tags: ["user-tag", "session-123"],
    });
  });

  it("omits tags when the only tags are internal seq:step markers", () => {
    const task = makeTask({
      config: { metadata: { lc_agent_name: "a" }, tags: ["seq:step:1"] },
    });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload.metadata).toEqual({ lc_agent_name: "a" });
  });

  it("surfaces filtered tags even without other metadata", () => {
    const task = makeTask({ config: { tags: ["user-tag"] } });
    const [payload] = Array.from(mapDebugTasks([task]));
    expect(payload.metadata).toEqual({ tags: ["user-tag"] });
  });
});
