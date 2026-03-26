import { describe, expect, it } from "vitest";

import { normalizeHitlInterruptPayload } from "./hitl-interrupt-payload.js";
import { normalizeInterruptForClient } from "./interrupts.js";

describe("normalizeHitlInterruptPayload", () => {
  it("maps Python snake_case HITL fields to camelCase", () => {
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
    expect(out.action_requests).toBeUndefined();
    expect(out.actionRequests).toHaveLength(1);
    expect((out.actionRequests as Record<string, unknown>[])[0]).toEqual({
      name: "send_email",
      args: { to: "a@b.com" },
      description: "test",
    });
    expect(out.reviewConfigs).toEqual([
      { allowedDecisions: ["approve", "reject"] },
    ]);
  });

  it("leaves already-camelCase payloads unchanged in shape", () => {
    const raw = {
      actionRequests: [{ name: "x", args: {} }],
      reviewConfigs: [{ allowedDecisions: ["approve"] }],
    };
    const out = normalizeHitlInterruptPayload(raw) as Record<string, unknown>;
    expect(out).toEqual(raw);
  });

  it("prefers camelCase when both are present", () => {
    const raw = {
      actionRequests: [{ name: "camel", args: {} }],
      action_requests: [{ action_name: "snake", args: {} }],
    };
    const out = normalizeHitlInterruptPayload(raw) as Record<string, unknown>;
    expect((out.actionRequests as { name: string }[])[0].name).toBe("camel");
  });

  it("passes through non-HITL objects", () => {
    expect(normalizeHitlInterruptPayload({ foo: 1 })).toEqual({ foo: 1 });
    expect(normalizeHitlInterruptPayload(null)).toBeNull();
    expect(normalizeHitlInterruptPayload("x")).toBe("x");
  });
});

describe("normalizeInterruptForClient", () => {
  it("normalizes interrupt value", () => {
    const i = normalizeInterruptForClient({
      id: "1",
      value: {
        action_requests: [{ action_name: "t", args: {}, description: "" }],
        review_configs: [{ allowed_decisions: ["approve"] }],
      },
    });
    expect(i.value).toEqual({
      actionRequests: [{ name: "t", args: {}, description: "" }],
      reviewConfigs: [{ allowedDecisions: ["approve"] }],
    });
  });
});
