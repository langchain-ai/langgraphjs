import { describe, expect, it } from "vitest";
import { Command, Send } from "../constants.js";
import { mapCommand } from "./io.js";
import { InvalidUpdateError } from "../errors.js";

describe("mapCommand", () => {
  it("should handle Command with goto (string)", () => {
    const cmd = new Command({
      goto: "nextNode",
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      [
        "00000000-0000-0000-0000-000000000000",
        "branch:to:nextNode",
        "__start__",
      ],
    ]);
  });

  it("should handle Command with goto (Send object)", () => {
    const send = new Send("targetNode", { arg1: "value1" });
    const cmd = new Command({
      goto: send,
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      ["00000000-0000-0000-0000-000000000000", "__pregel_tasks", send],
    ]);
  });

  it("should handle Command with goto (array of strings and Send objects)", () => {
    const send = new Send("targetNode", { arg1: "value1" });
    const cmd = new Command({
      goto: ["nextNode1", send, "nextNode2"],
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      [
        "00000000-0000-0000-0000-000000000000",
        "branch:to:nextNode1",
        "__start__",
      ],
      ["00000000-0000-0000-0000-000000000000", "__pregel_tasks", send],
      [
        "00000000-0000-0000-0000-000000000000",
        "branch:to:nextNode2",
        "__start__",
      ],
    ]);
  });

  it("should throw error for invalid goto value", () => {
    const cmd = new Command({
      // @ts-expect-error Testing invalid input
      goto: { invalidType: true },
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    expect(() => Array.from(mapCommand(cmd, pendingWrites))).toThrow(
      "In Command.send, expected Send or string, got object"
    );
  });

  it("should handle Command with resume (single value)", () => {
    const cmd = new Command({
      resume: "resumeValue",
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      ["00000000-0000-0000-0000-000000000000", "__resume__", "resumeValue"],
    ]);
  });

  it("should handle Command with resume (object of interrupt IDs)", () => {
    const cmd = new Command({
      resume: {
        "123e4567e89b12d3a456426614174000": "resumeValue1",
        "123e4567e89b12d3a456426614174001": "resumeValue2",
      },
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      ["123e4567e89b12d3a456426614174000", "__resume__", ["resumeValue1"]],
      ["123e4567e89b12d3a456426614174001", "__resume__", ["resumeValue2"]],
    ]);
  });

  it("should handle Command with update (object)", () => {
    const cmd = new Command({
      update: {
        channel1: "value1",
        channel2: "value2",
      },
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      ["00000000-0000-0000-0000-000000000000", "channel1", "value1"],
      ["00000000-0000-0000-0000-000000000000", "channel2", "value2"],
    ]);
  });

  it("should handle Command with update (array of tuples)", () => {
    const cmd = new Command({
      update: [
        ["channel1", "value1"],
        ["channel2", "value2"],
      ],
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      ["00000000-0000-0000-0000-000000000000", "channel1", "value1"],
      ["00000000-0000-0000-0000-000000000000", "channel2", "value2"],
    ]);
  });

  it("should throw error for invalid update type", () => {
    const cmd = new Command({
      // @ts-expect-error Testing invalid input
      update: "invalidUpdateType",
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    expect(() => Array.from(mapCommand(cmd, pendingWrites))).toThrow(
      "Expected cmd.update to be a dict mapping channel names to update values"
    );
  });

  it("should throw error for parent graph reference when none exists", () => {
    const cmd = new Command({
      graph: Command.PARENT,
      goto: "nextNode",
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    expect(() => Array.from(mapCommand(cmd, pendingWrites))).toThrow(
      InvalidUpdateError
    );
    expect(() => Array.from(mapCommand(cmd, pendingWrites))).toThrow(
      "There is no parent graph."
    );
  });

  it("should handle multiple command attributes together", () => {
    const cmd = new Command({
      goto: "nextNode",
      resume: "resumeValue",
      update: { channel1: "value1" },
    });

    const pendingWrites: Array<[string, string, unknown]> = [];

    const result = Array.from(mapCommand(cmd, pendingWrites));

    expect(result).toEqual([
      [
        "00000000-0000-0000-0000-000000000000",
        "branch:to:nextNode",
        "__start__",
      ],
      ["00000000-0000-0000-0000-000000000000", "__resume__", "resumeValue"],
      ["00000000-0000-0000-0000-000000000000", "channel1", "value1"],
    ]);
  });
});
