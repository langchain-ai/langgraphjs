import { describe, expect, it } from "vitest";

import { normalizeHitlInterruptPayload } from "./hitl-interrupt-payload.js";
import { normalizeInterruptForClient } from "./interrupts.js";

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
