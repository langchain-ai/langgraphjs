import { describe, expect, it, jest } from "@jest/globals";
import { wrap, tasksWithWrites, _readChannels } from "./debug.js";
import { BaseChannel } from "../channels/base.js";
import { LastValue } from "../channels/last_value.js";
import { EmptyChannelError } from "../errors.js";

describe("wrap", () => {
  it("should wrap text with color codes", () => {
    const color = {
      start: "\x1b[34m", // blue
      end: "\x1b[0m"
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
      channel2: new LastValue<number>()
    };
    
    // Update channels with values
    channels.channel1.update(["value1"]);
    channels.channel2.update([42]);
    
    const results = Array.from(_readChannels(channels));
    
    expect(results).toEqual([
      ["channel1", "value1"],
      ["channel2", 42]
    ]);
  });
  
  it("should skip empty channels", () => {
    const mockEmptyChannel: BaseChannel = {
      get: jest.fn().mockImplementation(() => {
        throw new EmptyChannelError("Empty channel");
      }),
      update: jest.fn(),
      checkpoint: jest.fn(),
      fromCheckpoint: jest.fn(),
      consume: jest.fn(),
      isEphemeral: false
    };
    
    const channels = {
      channel1: new LastValue<string>(),
      emptyChannel: mockEmptyChannel
    };
    
    // Update channel with value
    channels.channel1.update(["value1"]);
    
    const results = Array.from(_readChannels(channels));
    
    expect(results).toEqual([
      ["channel1", "value1"]
    ]);
  });
  
  it("should propagate non-empty channel errors", () => {
    const mockErrorChannel: BaseChannel = {
      get: jest.fn().mockImplementation(() => {
        throw new Error("Other error");
      }),
      update: jest.fn(),
      checkpoint: jest.fn(),
      fromCheckpoint: jest.fn(),
      consume: jest.fn(),
      isEphemeral: false
    };
    
    const channels = {
      channel1: new LastValue<string>(["value1"]),
      errorChannel: mockErrorChannel
    };
    
    expect(() => Array.from(_readChannels(channels))).toThrow("Other error");
  });
});

describe("tasksWithWrites", () => {
  it("should return task descriptions with no writes", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] }
    ];
    
    const pendingWrites = [];
    
    const result = tasksWithWrites(tasks, pendingWrites);
    
    expect(result).toEqual([
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"], interrupts: [] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] }
    ]);
  });
  
  it("should include error information", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] }
    ];
    
    const pendingWrites = [
      ["task1", "__error__", { message: "Test error" }]
    ];
    
    const result = tasksWithWrites(tasks, pendingWrites);
    
    expect(result).toEqual([
      { 
        id: "task1", 
        name: "Task 1", 
        path: ["PULL", "Task 1"], 
        error: { message: "Test error" },
        interrupts: []
      },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] }
    ]);
  });
  
  it("should include state information", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"] }
    ];
    
    const pendingWrites = [];
    
    const states = {
      task1: { configurable: { key: "value" } }
    };
    
    const result = tasksWithWrites(tasks, pendingWrites, states);
    
    expect(result).toEqual([
      { 
        id: "task1", 
        name: "Task 1", 
        path: ["PULL", "Task 1"], 
        interrupts: [],
        state: { configurable: { key: "value" } }
      },
      { id: "task2", name: "Task 2", path: ["PULL", "Task 2"], interrupts: [] }
    ]);
  });
  
  it("should include interrupts", () => {
    const tasks = [
      { id: "task1", name: "Task 1", path: ["PULL", "Task 1"] }
    ];
    
    const pendingWrites = [
      ["task1", "__interrupt__", { value: "Interrupted", when: "during" }]
    ];
    
    const result = tasksWithWrites(tasks, pendingWrites);
    
    expect(result).toEqual([
      { 
        id: "task1", 
        name: "Task 1", 
        path: ["PULL", "Task 1"], 
        interrupts: [{ value: "Interrupted", when: "during" }]
      }
    ]);
  });
});