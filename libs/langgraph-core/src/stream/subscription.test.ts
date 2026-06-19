import { describe, expect, it } from "vitest";
import type { SubscribeParams } from "@langchain/protocol";
import {
  SUPPORTED_CHANNELS,
  inferChannel,
  isPrefixMatch,
  isSupportedChannel,
  matchesSubscription,
  normalizeNamespaceSegment,
} from "./subscription.js";
import type { ProtocolEvent, ProtocolMethod } from "./types.js";

function makeEvent(overrides: {
  method: ProtocolMethod;
  namespace?: string[];
  data?: unknown;
  seq?: number;
}): ProtocolEvent {
  return {
    type: "event",
    seq: overrides.seq ?? 1,
    method: overrides.method,
    params: {
      namespace: overrides.namespace ?? [],
      timestamp: 0,
      data: overrides.data,
    },
  };
}

describe("inferChannel", () => {
  it("maps known methods to their channel", () => {
    expect(inferChannel(makeEvent({ method: "values" }))).toBe("values");
    expect(inferChannel(makeEvent({ method: "updates" }))).toBe("updates");
    expect(inferChannel(makeEvent({ method: "messages" }))).toBe("messages");
    expect(inferChannel(makeEvent({ method: "tools" }))).toBe("tools");
    expect(inferChannel(makeEvent({ method: "checkpoints" }))).toBe(
      "checkpoints"
    );
    expect(inferChannel(makeEvent({ method: "lifecycle" }))).toBe("lifecycle");
    expect(inferChannel(makeEvent({ method: "tasks" }))).toBe("tasks");
  });

  it("maps both 'input' and 'input.requested' to the input channel", () => {
    expect(inferChannel(makeEvent({ method: "input" }))).toBe("input");
    expect(inferChannel(makeEvent({ method: "input.requested" }))).toBe(
      "input"
    );
  });

  it("resolves the named custom channel when the payload carries a name", () => {
    expect(
      inferChannel(makeEvent({ method: "custom", data: { name: "a2a" } }))
    ).toBe("custom:a2a");
    expect(inferChannel(makeEvent({ method: "custom" }))).toBe("custom");
  });

  it("returns undefined for unknown methods", () => {
    expect(inferChannel(makeEvent({ method: "future-method" }))).toBeUndefined();
  });
});

describe("normalizeNamespaceSegment", () => {
  it("strips dynamic suffixes after the first colon", () => {
    expect(normalizeNamespaceSegment("fetcher:abc-uuid")).toBe("fetcher");
    expect(normalizeNamespaceSegment("fetcher")).toBe("fetcher");
    expect(normalizeNamespaceSegment("a:b:c")).toBe("a");
  });
});

describe("isPrefixMatch", () => {
  it("matches an exact prefix", () => {
    expect(isPrefixMatch(["agent", "inner"], ["agent"])).toBe(true);
    expect(isPrefixMatch(["agent"], ["agent", "inner"])).toBe(false);
  });

  it("normalizes dynamic suffixes when the prefix segment is static", () => {
    expect(isPrefixMatch(["fetcher:abc-uuid"], ["fetcher"])).toBe(true);
  });

  it("requires exact match when the prefix segment carries a suffix", () => {
    expect(isPrefixMatch(["fetcher:abc"], ["fetcher:xyz"])).toBe(false);
    expect(isPrefixMatch(["fetcher:abc"], ["fetcher:abc"])).toBe(true);
  });
});

describe("isSupportedChannel / SUPPORTED_CHANNELS", () => {
  it("recognizes every base channel", () => {
    for (const channel of SUPPORTED_CHANNELS) {
      expect(isSupportedChannel(channel)).toBe(true);
    }
  });

  it("recognizes named custom channels", () => {
    expect(isSupportedChannel("custom:a2a")).toBe(true);
  });

  it("rejects unknown channels", () => {
    expect(isSupportedChannel("nope")).toBe(false);
    expect(isSupportedChannel("")).toBe(false);
  });
});

describe("matchesSubscription", () => {
  it("matches when the channel is subscribed", () => {
    const def: SubscribeParams = { channels: ["messages"] };
    expect(matchesSubscription(makeEvent({ method: "messages" }), def)).toBe(
      true
    );
    expect(matchesSubscription(makeEvent({ method: "values" }), def)).toBe(
      false
    );
  });

  it("routes named custom channels through the base 'custom' subscription", () => {
    const def: SubscribeParams = { channels: ["custom"] };
    expect(
      matchesSubscription(
        makeEvent({ method: "custom", data: { name: "a2a" } }),
        def
      )
    ).toBe(true);
  });

  it("filters by namespace prefix and depth", () => {
    const def: SubscribeParams = {
      channels: ["messages"],
      namespaces: [["agent"]],
      depth: 0,
    };
    expect(
      matchesSubscription(
        makeEvent({ method: "messages", namespace: ["agent"] }),
        def
      )
    ).toBe(true);
    expect(
      matchesSubscription(
        makeEvent({ method: "messages", namespace: ["agent", "inner"] }),
        def
      )
    ).toBe(false);
  });

  it("normalizes dynamic namespace suffixes when matching a static prefix", () => {
    const def: SubscribeParams = {
      channels: ["messages"],
      namespaces: [["fetcher"]],
    };
    expect(
      matchesSubscription(
        makeEvent({ method: "messages", namespace: ["fetcher:abc-uuid"] }),
        def
      )
    ).toBe(true);
  });

  describe("since replay cursor", () => {
    const def: SubscribeParams = { channels: ["messages"], since: 5 };

    it("excludes events at or before the cursor", () => {
      expect(
        matchesSubscription(makeEvent({ method: "messages", seq: 5 }), def)
      ).toBe(false);
      expect(
        matchesSubscription(makeEvent({ method: "messages", seq: 4 }), def)
      ).toBe(false);
    });

    it("includes events after the cursor", () => {
      expect(
        matchesSubscription(makeEvent({ method: "messages", seq: 6 }), def)
      ).toBe(true);
    });

    it("ignores a non-numeric since", () => {
      const noCursor: SubscribeParams = {
        channels: ["messages"],
        since: undefined,
      };
      expect(
        matchesSubscription(makeEvent({ method: "messages", seq: 1 }), noCursor)
      ).toBe(true);
    });
  });
});
