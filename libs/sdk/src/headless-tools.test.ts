import { describe, expect, it, vi } from "vitest";
import {
  applyHeadlessToolResumeCommand,
  buildResumeRunInput,
  flushPendingHeadlessToolInterrupts,
  headlessToolsBatchResumeCommand,
  isInterruptIdKeyedResume,
  resolveInterruptTargetForHeadlessResume,
  scheduleCoalescedHeadlessToolFlush,
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
      keyedByInterruptId: true,
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
      keyedByInterruptId: true,
    });

    expect(isInterruptIdKeyedResume({})).toBe(false);
    expect(
      isInterruptIdKeyedResume({
        "4b704fd4b473bfd68df40c9979bffe1b": { toolu_01A: {} },
      })
    ).toBe(true);
    expect(
      isInterruptIdKeyedResume({
        "int-1": { toolu_01A: { success: true } },
      })
    ).toBe(false);
    expect(
      isInterruptIdKeyedResume(
        { "int-1": { toolu_01A: { success: true } } },
        [{ interruptId: "int-1", namespace: [], payload: {} }]
      )
    ).toBe(true);
    expect(
      isInterruptIdKeyedResume({
        toolu_01A: { latitude: 1, longitude: 2 },
      })
    ).toBe(false);
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

    expect(
      buildResumeRunInput(
        {
          "int-1": { toolu_01A: { success: true } },
          "int-2": { toolu_01B: { success: true } },
        },
        [
          {
            interruptId: "int-1",
            namespace: [] as string[],
            payload: {
              type: "tool",
              toolCall: { id: "toolu_01A", name: "memory_put", args: {} },
            },
          },
          {
            interruptId: "int-2",
            namespace: [] as string[],
            payload: {
              type: "tool",
              toolCall: { id: "toolu_01B", name: "memory_put", args: {} },
            },
          },
        ],
        new Set()
      )
    ).toEqual({
      "int-1": { toolu_01A: { success: true } },
      "int-2": { toolu_01B: { success: true } },
    });
  });

  it("routes interrupt-id keyed resumes through respondAll on v1 stream", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const respondAll = vi.fn().mockResolvedValue(undefined);
    const command = headlessToolsBatchResumeCommand([
      {
        interruptId: "4b704fd4b473bfd68df40c9979bffe1b",
        toolCallId: "toolu_01A",
        value: { success: true },
      },
    ]);

    await applyHeadlessToolResumeCommand({ respond, respondAll }, command);

    expect(respondAll).toHaveBeenCalledWith({
      "4b704fd4b473bfd68df40c9979bffe1b": {
        toolu_01A: { success: true },
      },
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("routes non-hex interrupt-id keyed resumes through respondAll on v1 stream", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const respondAll = vi.fn().mockResolvedValue(undefined);
    const command = headlessToolsBatchResumeCommand([
      {
        interruptId: "int-1",
        toolCallId: "toolu_01A",
        value: { success: true },
      },
    ]);

    await applyHeadlessToolResumeCommand({ respond, respondAll }, command);

    expect(respondAll).toHaveBeenCalledWith({
      "int-1": { toolu_01A: { success: true } },
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("routes direct-value interrupt resumes through respondAll when keyedByInterruptId is set", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const respondAll = vi.fn().mockResolvedValue(undefined);
    const command = headlessToolsBatchResumeCommand([
      {
        interruptId: "int-1",
        toolCallId: "",
        value: { latitude: 1, longitude: 2 },
      },
    ]);

    await applyHeadlessToolResumeCommand({ respond, respondAll }, command);

    expect(respondAll).toHaveBeenCalledWith({
      "int-1": { latitude: 1, longitude: 2 },
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("routes tool-call keyed resumes through respond on v1 stream", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const respondAll = vi.fn().mockResolvedValue(undefined);

    await applyHeadlessToolResumeCommand(
      { respond, respondAll },
      { resume: { toolu_01A: { success: true } }, keyedByInterruptId: false }
    );

    expect(respond).toHaveBeenCalledWith({ toolu_01A: { success: true } });
    expect(respondAll).not.toHaveBeenCalled();
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
      keyedByInterruptId: true,
    });
  });

  it("coalesces staggered flush triggers into one batch resume", async () => {
    const handled = new Set<string>();
    const resumeSubmit = vi.fn().mockResolvedValue(undefined);
    const tool = {
      tool: { name: "memory_put" },
      execute: async () => ({ success: true }),
    };

    const flushFirstInterrupt = () => {
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
          ],
        },
        [tool],
        handled,
        { resumeSubmit }
      );
    };

    const flushBothInterrupts = () => {
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
        [tool],
        handled,
        { resumeSubmit }
      );
    };

    scheduleCoalescedHeadlessToolFlush(handled, flushFirstInterrupt);
    scheduleCoalescedHeadlessToolFlush(handled, flushBothInterrupts);

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
      keyedByInterruptId: true,
    });
  });
});
