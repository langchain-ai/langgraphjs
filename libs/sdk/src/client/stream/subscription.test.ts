import type { Event } from "@langchain/protocol";
import { describe, expect, it } from "vitest";

import { inferChannel, matchesSubscription } from "./subscription.js";
import { eventOf } from "./test/utils.js";

describe("inferChannel", () => {
  it("maps event methods to their channels", () => {
    expect(
      inferChannel({
        type: "event",
        method: "values",
        params: { namespace: [], timestamp: 0, data: {} },
      } as Event)
    ).toBe("values");
    expect(
      inferChannel({
        type: "event",
        method: "media.streamStart",
        params: {
          namespace: [],
          timestamp: 0,
          data: {},
          media_type: "image/png",
          stream_id: "s1",
          codec: "raw",
        },
      } as unknown as Event)
    ).toBe("media");
    expect(
      inferChannel({
        type: "event",
        method: "sandbox.started",
        params: {
          namespace: [],
          timestamp: 0,
          data: { terminal_id: "t1", command: "bash" },
        },
      } as unknown as Event)
    ).toBe("sandbox");
  });
});

describe("matchesSubscription", () => {
  it("matches events by channel", () => {
    const event = eventOf(
      "messages",
      { event: "message-start", message_id: "m1" },
      { namespace: [] }
    );
    expect(matchesSubscription(event, { channels: ["messages"] })).toBe(true);
    expect(matchesSubscription(event, { channels: ["tools"] })).toBe(false);
  });

  it("filters by namespace prefix", () => {
    const event = eventOf(
      "messages",
      { event: "message-start", message_id: "m1" },
      { namespace: ["agent_1", "sub"] }
    );
    expect(
      matchesSubscription(event, {
        channels: ["messages"],
        namespaces: [["agent_1"]],
      })
    ).toBe(true);
    expect(
      matchesSubscription(event, {
        channels: ["messages"],
        namespaces: [["agent_2"]],
      })
    ).toBe(false);
  });

  it("respects depth constraint", () => {
    const event = eventOf(
      "messages",
      { event: "message-start", message_id: "m1" },
      { namespace: ["agent_1", "deep", "nested"] }
    );
    expect(
      matchesSubscription(event, {
        channels: ["messages"],
        namespaces: [["agent_1"]],
        depth: 1,
      })
    ).toBe(false);
    expect(
      matchesSubscription(event, {
        channels: ["messages"],
        namespaces: [["agent_1"]],
        depth: 2,
      })
    ).toBe(true);
  });
});
