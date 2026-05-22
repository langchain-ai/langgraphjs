import { describe, expect, it, vi } from "vitest";
import {
  buildResumeRunInput,
  flushPendingHeadlessToolInterrupts,
  headlessToolsBatchResumeCommand,
  isInterruptIdKeyedResume,
  resolveInterruptTargetForHeadlessResume,
} from "./headless-tools.js";

async function flushMicrotasks(count = 4) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe("headless tool resume helpers", () => {
  it("targets the interrupt that matches the headless-tool resume key", () => {
    const interrupts = [
      {
        interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
        namespace: [] as string[],
        payload: {
          type: "tool",
          toolCall: {
            id: "toolu_01A",
            name: "memory_put",
            args: { key: "user_name", value: "Alex" },
          },
        },
      },
      {
        interruptId: "c485a7b6c996d3ace440d2afd6f292a3",
        namespace: [] as string[],
        payload: {
          type: "tool",
          toolCall: {
            id: "toolu_01B",
            name: "memory_put",
            args: { key: "user_role", value: "developer" },
          },
        },
      },
    ];

    expect(
      resolveInterruptTargetForHeadlessResume(
        { toolu_01A: { success: true } },
        interrupts,
        new Set()
      )
    ).toEqual({
      interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
      namespace: [],
    });

    expect(
      resolveInterruptTargetForHeadlessResume(
        { toolu_01B: { success: true } },
        interrupts,
        new Set()
      )
    ).toEqual({
      interruptId: "c485a7b6c996d3ace440d2afd6f292a3",
      namespace: [],
    });
  });

  it("builds interrupt-id keyed resume commands", () => {
    expect(
      headlessToolsBatchResumeCommand([
        {
          interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
          toolCallId: "toolu_01A",
          value: { key: "user_name" },
        },
      ])
    ).toEqual({
      resume: {
        "4b704fd4b473bfd68df40c9979bffe1b": {
          toolu_01A: { key: "user_name" },
        },
      },
    });

    expect(
      headlessToolsBatchResumeCommand([
        {
          interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
          toolCallId: "toolu_01A",
          value: { key: "user_name" },
        },
        {
          interruptId: "c485a7b6c996d3ace440d2afd6f292a3",
          toolCallId: "toolu_01B",
          value: { key: "user_role" },
        },
      ])
    ).toEqual({
      resume: {
        "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: { key: "user_name" } },
        "c485a7b6c996d3ace440d2afd6f292a3": { toolu_01B: { key: "user_role" } },
      },
    });

    expect(isInterruptIdKeyedResume({})).toBe(false);
    expect(
      isInterruptIdKeyedResume({
        "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: {} },
      })
    ).toBe(true);
  });

  it("wraps tool-call keyed resume input under the matching interrupt id", () => {
    const interrupts = [
      {
        interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
        namespace: [] as string[],
        payload: {
          type: "tool",
          toolCall: {
            id: "toolu_01A",
            name: "memory_put",
            args: { key: "user_name" },
          },
        },
      },
    ];

    expect(
      buildResumeRunInput(
        { toolu_01A: { success: true } },
        interrupts,
        new Set()
      )
    ).toEqual({
      "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: { success: true } },
    });

    expect(
      buildResumeRunInput(
        {
          "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: { success: true } },
          "c485a7b6c996d3ace440d2afd6f292a3": { toolu_01B: { success: true } },
        },
        interrupts,
        new Set()
      )
    ).toEqual({
      "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: { success: true } },
      "c485a7b6c996d3ace440d2afd6f292a3": { toolu_01B: { success: true } },
    });
  });

  it("flushes all pending headless tools in one batch resume", async () => {
    const handled = new Set<string>();
    const resumeSubmit = vi.fn().mockResolvedValue(undefined);

    flushPendingHeadlessToolInterrupts(
      {
        __interrupt__: [
          {
            id: "4b704fd4b473bfd68df40c9979bffe1b",
            value: {
              type: "tool",
              toolCall: {
                id: "toolu_01A",
                name: "memory_put",
                args: { key: "user_name", value: "Alex" },
              },
            },
          },
          {
            id: "c485a7b6c996d3ace440d2afd6f292a3",
            value: {
              type: "tool",
              toolCall: {
                id: "toolu_01B",
                name: "memory_put",
                args: { key: "user_role", value: "developer" },
              },
            },
          },
        ],
      },
      [
        {
          tool: { name: "memory_put" },
          execute: async () => ({ success: true }),
        },
      ],
      handled,
      { resumeSubmit }
    );

    await flushMicrotasks(8);

    expect(resumeSubmit).toHaveBeenCalledTimes(1);
    expect(resumeSubmit).toHaveBeenCalledWith({
      resume: {
        "4b704fd4b473bfd68df40c9979bffe1b": {
          toolu_01A: { success: true },
        },
        "c485a7b6c996d3ace440d2afd6f292a3": {
          toolu_01B: { success: true },
        },
      },
    });
  });
});
