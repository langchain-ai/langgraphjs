import { describe, expect, it, vi } from "vitest";

import { normalizeHitlInterruptPayload, normalizeHitlResponseForServer } from "./hitl-interrupt-payload.js";
import { normalizeInterruptForClient } from "./interrupts.js";
import {
  filterOutHeadlessToolInterrupts,
  flushPendingHeadlessToolInterrupts,
  headlessToolResumeCommand,
  parseHeadlessToolInterruptPayload,
} from "../headless-tools.js";

async function flushMicrotasks(count = 4) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe("normalizeHitlInterruptPayload", () => {
  it("aliases Python snake_case HITL fields to camelCase", () => {
    const raw = {
      action_requests: [
        {
          action_name: "send_email",
          args: { to: "a@b.com" },
          description: "test",
        },
      ],
      review_configs: [{ allowed_decisions: ["approve", "reject"] }],
    };
    const out = normalizeHitlInterruptPayload(raw) as Record<string, unknown>;
    expect(out.action_requests).toBe(out.actionRequests);
    expect(out.actionRequests).toHaveLength(1);
    expect((out.actionRequests as Record<string, unknown>[])[0]).toEqual({
      name: "send_email",
      action_name: "send_email",
      args: { to: "a@b.com" },
      description: "test",
    });
    expect(out.reviewConfigs).toEqual([
      {
        allowedDecisions: ["approve", "reject"],
        allowed_decisions: ["approve", "reject"],
      },
    ]);
    expect(out.review_configs).toBe(out.reviewConfigs);
  });

  it("adds deprecated snake_case aliases to camelCase payloads", () => {
    const raw = {
      actionRequests: [{ name: "x", args: {} }],
      reviewConfigs: [{ allowedDecisions: ["approve"] }],
    };
    const out = normalizeHitlInterruptPayload(raw) as Record<string, unknown>;
    expect(out.actionRequests).toEqual([{ name: "x", action_name: "x", args: {} }]);
    expect(out.action_requests).toBe(out.actionRequests);
    expect(out.reviewConfigs).toEqual([
      {
        allowedDecisions: ["approve"],
        allowed_decisions: ["approve"],
      },
    ]);
    expect(out.review_configs).toBe(out.reviewConfigs);
  });

  it("prefers camelCase when both are present", () => {
    const raw = {
      actionRequests: [{ name: "camel", args: {} }],
      action_requests: [{ action_name: "snake", args: {} }],
      reviewConfigs: [{ allowedDecisions: ["approve"] }],
      review_configs: [{ allowed_decisions: ["reject"] }],
    };
    const out = normalizeHitlInterruptPayload(raw) as Record<string, unknown>;
    expect((out.actionRequests as { name: string }[])[0].name).toBe("camel");
    expect((out.action_requests as { action_name: string }[])[0].action_name).toBe(
      "camel"
    );
    expect(
      (out.reviewConfigs as { allowedDecisions: string[] }[])[0].allowedDecisions
    ).toEqual(["approve"]);
    expect(
      (out.review_configs as { allowed_decisions: string[] }[])[0]
        .allowed_decisions
    ).toEqual(["approve"]);
  });

  it("passes through non-HITL objects", () => {
    expect(normalizeHitlInterruptPayload({ foo: 1 })).toEqual({ foo: 1 });
    expect(normalizeHitlInterruptPayload(null)).toBeNull();
    expect(normalizeHitlInterruptPayload("x")).toBe("x");
  });
});

describe("normalizeHitlResponseForServer", () => {
  it("adds edited_action alias for camelCase edit decisions", () => {
    const raw = {
      decisions: [
        { type: "approve" },
        {
          type: "edit",
          editedAction: { name: "send_email", args: { to: "a@b.com" } },
        },
      ],
    };
    const out = normalizeHitlResponseForServer(raw) as {
      decisions: Record<string, unknown>[];
    };
    expect(out.decisions[1]).toEqual({
      type: "edit",
      editedAction: { name: "send_email", args: { to: "a@b.com" } },
      edited_action: { name: "send_email", args: { to: "a@b.com" } },
    });
  });

  it("adds editedAction alias for snake_case edit decisions", () => {
    const raw = {
      decisions: [
        {
          type: "edit",
          edited_action: { name: "send_email", args: { to: "a@b.com" } },
        },
      ],
    };
    const out = normalizeHitlResponseForServer(raw) as {
      decisions: Record<string, unknown>[];
    };
    expect(out.decisions[0]).toEqual({
      type: "edit",
      editedAction: { name: "send_email", args: { to: "a@b.com" } },
      edited_action: { name: "send_email", args: { to: "a@b.com" } },
    });
  });

  it("passes through non-HITL responses", () => {
    expect(normalizeHitlResponseForServer({ approved: true })).toEqual({
      approved: true,
    });
    expect(normalizeHitlResponseForServer(null)).toBeNull();
  });
});

describe("normalizeInterruptForClient", () => {
  it("normalizes interrupt value while keeping deprecated aliases", () => {
    const i = normalizeInterruptForClient({
      id: "1",
      value: {
        action_requests: [{ action_name: "t", args: {}, description: "" }],
        review_configs: [{ allowed_decisions: ["approve"] }],
      },
    });
    expect(i.value).toEqual({
      actionRequests: [{ name: "t", action_name: "t", args: {}, description: "" }],
      action_requests: [{ name: "t", action_name: "t", args: {}, description: "" }],
      reviewConfigs: [
        {
          allowedDecisions: ["approve"],
          allowed_decisions: ["approve"],
        },
      ],
      review_configs: [
        {
          allowedDecisions: ["approve"],
          allowed_decisions: ["approve"],
        },
      ],
    });
  });
});

describe("headless tool interrupt helpers", () => {
  it("filters out headless tool interrupts while preserving others", () => {
    const interrupts = [
      {
        id: "tool-int",
        value: {
          type: "tool" as const,
          toolCall: { id: "call-1", name: "get_location", args: {} },
        },
      },
      {
        id: "hitl-int",
        value: {
          action_requests: [{ action_name: "approve", args: {}, description: "" }],
        },
      },
      { id: "breakpoint", when: "breakpoint" as const },
    ];

    expect(filterOutHeadlessToolInterrupts(interrupts)).toEqual([
      interrupts[1],
      interrupts[2],
    ]);
  });

  it("treats Python snake_case tool_call as headless for filtering", () => {
    const interrupts = [
      {
        id: "tool-int",
        value: {
          type: "tool" as const,
          tool_call: {
            id: "call-1",
            name: "geolocation_get",
            args: { high_accuracy: null },
          },
        },
      },
      {
        id: "hitl-int",
        value: {
          action_requests: [
            { action_name: "approve", args: {}, description: "" },
          ],
        },
      },
    ];

    expect(filterOutHeadlessToolInterrupts(interrupts)).toEqual([
      interrupts[1],
    ]);
  });

  it("normalizes Python tool_call via parseHeadlessToolInterruptPayload", () => {
    expect(
      parseHeadlessToolInterruptPayload({
        type: "tool",
        tool_call: {
          id: "call_heTfkJwAH7gjuxHXMANzQKTJ",
          name: "geolocation_get",
          args: { high_accuracy: null },
        },
      })
    ).toEqual({
      type: "tool",
      toolCall: {
        id: "call_heTfkJwAH7gjuxHXMANzQKTJ",
        name: "geolocation_get",
        args: { high_accuracy: null },
      },
    });
  });

  it("builds a keyed resume command for tool call results", () => {
    expect(
      headlessToolResumeCommand({
        toolCallId: "call-1",
        value: { latitude: 1, longitude: 2 },
      })
    ).toEqual({
      resume: {
        "call-1": { latitude: 1, longitude: 2 },
      },
      keyedByInterruptId: false,
    });
  });

  it("flushes only newly seen headless tool interrupts", async () => {
    const handled = new Set<string>();
    const onTool = vi.fn();
    const resumeSubmit = vi.fn();

    flushPendingHeadlessToolInterrupts(
      {
        __interrupt__: [
          {
            id: "headless-1",
            value: {
              type: "tool",
              toolCall: {
                id: "call-1",
                name: "get_location",
                args: { highAccuracy: false },
              },
            },
          },
          {
            id: "hitl-1",
            value: {
              action_requests: [
                { action_name: "approve", args: {}, description: "" },
              ],
            },
          },
        ],
      },
      [
        {
          tool: { name: "get_location" },
          execute: async () => ({ latitude: 1, longitude: 2 }),
        },
      ],
      handled,
      { onTool, resumeSubmit }
    );

    await flushMicrotasks();

    expect(resumeSubmit).toHaveBeenCalledWith({
      resume: {
        "headless-1": {
          "call-1": { latitude: 1, longitude: 2 },
        },
      },
      keyedByInterruptId: true,
    });

    expect(handled.has("headless-1")).toBe(true);
    expect(onTool).toHaveBeenCalledTimes(2);

    resumeSubmit.mockClear();

    flushPendingHeadlessToolInterrupts(
      {
        __interrupt__: [
          {
            id: "headless-1",
            value: {
              type: "tool",
              toolCall: {
                id: "call-1",
                name: "get_location",
                args: { highAccuracy: false },
              },
            },
          },
        ],
      },
      [
        {
          tool: { name: "get_location" },
          execute: async () => ({ latitude: 1, longitude: 2 }),
        },
      ],
      handled,
      { onTool, resumeSubmit }
    );

    await flushMicrotasks();

    expect(resumeSubmit).not.toHaveBeenCalled();
  });

  it("flushes headless tool interrupts serialized with Python tool_call", async () => {
    const handled = new Set<string>();
    const onTool = vi.fn();
    const resumeSubmit = vi.fn();

    flushPendingHeadlessToolInterrupts(
      {
        __interrupt__: [
          {
            id: "py-headless",
            value: {
              type: "tool",
              tool_call: {
                id: "call-1",
                name: "get_location",
                args: { high_accuracy: false },
              },
            },
          },
        ],
      },
      [
        {
          tool: { name: "get_location" },
          execute: async () => ({ latitude: 1, longitude: 2 }),
        },
      ],
      handled,
      { onTool, resumeSubmit }
    );

    await flushMicrotasks();

    expect(resumeSubmit).toHaveBeenCalledWith({
      resume: {
        "py-headless": {
          "call-1": { latitude: 1, longitude: 2 },
        },
      },
      keyedByInterruptId: true,
    });
    expect(handled.has("py-headless")).toBe(true);
    expect(onTool).toHaveBeenCalledTimes(2);
  });

  it("flushes each headless tool call only once when mirrored under different interrupt ids", async () => {
    const handled = new Set<string>();
    const onTool = vi.fn();
    const resumeSubmit = vi.fn();

    flushPendingHeadlessToolInterrupts(
      {
        __interrupt__: [
          {
            id: "toolu_01H47Bw9B8ut1dGRASjDpN1K",
            value: {
              type: "tool",
              toolCall: {
                id: "toolu_01H47Bw9B8ut1dGRASjDpN1K",
                name: "memory_put",
                args: { key: "user_name", value: "Alex" },
              },
            },
          },
          {
            id: "4bce9f26f79f6a609d77589681d8813f",
            value: {
              type: "tool",
              toolCall: {
                id: "toolu_01H47Bw9B8ut1dGRASjDpN1K",
                name: "memory_put",
                args: { key: "user_name", value: "Alex" },
              },
            },
          },
        ],
      },
      [
        {
          tool: { name: "memory_put" },
          execute: async () => ({
            success: true,
            action: "updated",
            key: "user_name",
            message: 'Memory "user_name" updated',
          }),
        },
      ],
      handled,
      { onTool, resumeSubmit }
    );

    await flushMicrotasks();

    expect(resumeSubmit).toHaveBeenCalledTimes(1);
    expect(resumeSubmit).toHaveBeenCalledWith({
      resume: {
        "toolu_01H47Bw9B8ut1dGRASjDpN1K": {
          "toolu_01H47Bw9B8ut1dGRASjDpN1K": {
            success: true,
            action: "updated",
            key: "user_name",
            message: 'Memory "user_name" updated',
          },
        },
      },
      keyedByInterruptId: true,
    });
    expect(onTool).toHaveBeenCalledTimes(2);
  });

  it("does not re-flush the same tool call after resume clears a mirrored interrupt id", async () => {
    const handled = new Set<string>();
    const onTool = vi.fn();
    const resumeSubmit = vi.fn();
    const tool = {
      tool: { name: "memory_put" },
      execute: async () => ({
        success: true,
        action: "updated",
        key: "user_name",
        message: 'Memory "user_name" updated',
      }),
    };
    const protocolInterrupt = {
      id: "4bce9f26f79f6a609d77589681d8813f",
      value: {
        type: "tool",
        toolCall: {
          id: "toolu_01H47Bw9B8ut1dGRASjDpN1K",
          name: "memory_put",
          args: { key: "user_name", value: "Alex" },
        },
      },
    };
    const valuesInterrupt = {
      id: "toolu_01H47Bw9B8ut1dGRASjDpN1K",
      value: protocolInterrupt.value,
    };

    flushPendingHeadlessToolInterrupts(
      { __interrupt__: [protocolInterrupt] },
      [tool],
      handled,
      { onTool, resumeSubmit }
    );
    await flushMicrotasks();

    resumeSubmit.mockClear();
    onTool.mockClear();

    flushPendingHeadlessToolInterrupts(
      { __interrupt__: [valuesInterrupt] },
      [tool],
      handled,
      { onTool, resumeSubmit }
    );
    await flushMicrotasks();

    expect(resumeSubmit).not.toHaveBeenCalled();
    expect(onTool).not.toHaveBeenCalled();
  });
});
