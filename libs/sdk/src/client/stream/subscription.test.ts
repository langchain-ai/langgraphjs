import type { Channel, Event } from "@langchain/protocol";
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

  it("returns 'custom' for unnamed custom events", () => {
    const event = eventOf("custom", { payload: "hello" });
    expect(inferChannel(event)).toBe("custom");
  });

  it("returns 'custom:name' for named custom events", () => {
    const event = eventOf("custom", {
      name: "a2a",
      payload: { status: "working" },
    });
    expect(inferChannel(event)).toBe("custom:a2a");
  });

  it("returns undefined for unknown event methods", () => {
    const event = {
      type: "event",
      method: "unknown.future.method",
      params: { namespace: [], timestamp: 0, data: {} },
    } as unknown as Event;
    expect(inferChannel(event)).toBeUndefined();
  });
});

describe("matchesSubscription with unknown methods", () => {
  it("drops events with unknown methods", () => {
    const event = {
      type: "event",
      method: "unknown.future.method",
      params: { namespace: [], timestamp: 0, data: {} },
    } as unknown as Event;
    expect(matchesSubscription(event, { channels: ["messages"] })).toBe(false);
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

  it("'custom' channel matches all custom events including named", () => {
    const unnamed = eventOf("custom", { payload: "x" });
    const named = eventOf("custom", { name: "a2a", payload: { s: 1 } });
    expect(matchesSubscription(unnamed, { channels: ["custom"] })).toBe(true);
    expect(matchesSubscription(named, { channels: ["custom"] })).toBe(true);
  });

  it("'custom:name' channel matches only named custom events", () => {
    const a2a = eventOf("custom", { name: "a2a", payload: {} });
    const other = eventOf("custom", { name: "metrics", payload: {} });
    const unnamed = eventOf("custom", { payload: "x" });

    expect(
      matchesSubscription(a2a, {
        channels: ["custom:a2a" as Channel],
      })
    ).toBe(true);
    expect(
      matchesSubscription(other, {
        channels: ["custom:a2a" as Channel],
      })
    ).toBe(false);
    expect(
      matchesSubscription(unnamed, {
        channels: ["custom:a2a" as Channel],
      })
    ).toBe(false);
  });
});
