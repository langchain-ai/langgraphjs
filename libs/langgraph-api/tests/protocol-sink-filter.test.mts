import { describe, expect, it } from "vitest";

import { matchesSinkFilter } from "../src/protocol/service.mjs";
import type {
  EventSinkFilter,
  ProtocolEvent,
} from "../src/protocol/types.mjs";

const valuesEvent = (opts: {
  event_id: string;
  seq: number;
}): ProtocolEvent =>
  ({
    type: "event",
    method: "values",
    event_id: opts.event_id,
    seq: opts.seq,
    params: {
      namespace: [],
      timestamp: 1,
      data: { messages: [] },
    },
  }) as ProtocolEvent;

describe("matchesSinkFilter sinceEventId", () => {
  const baseFilter: EventSinkFilter = {
    channels: new Set(["values"]),
  };

  it("skips envelopes at or before the durable cursor", () => {
    // Redis ms-seq ids share a fixed-width millisecond prefix, so
    // lexicographic `>` matches stream order (same as in-mem restore).
    const filter: EventSinkFilter = {
      ...baseFilter,
      sinceEventId: "1710000000010-0",
    };
    expect(
      matchesSinkFilter(
        filter,
        valuesEvent({ event_id: "1710000000010-0", seq: 1 })
      )
    ).toBe(false);
    expect(
      matchesSinkFilter(
        filter,
        valuesEvent({ event_id: "1710000000009-1", seq: 2 })
      )
    ).toBe(false);
    expect(
      matchesSinkFilter(
        filter,
        valuesEvent({ event_id: "1710000000010-0.1", seq: 3 })
      )
    ).toBe(true);
    expect(
      matchesSinkFilter(
        filter,
        valuesEvent({ event_id: "1710000000011-0", seq: 4 })
      )
    ).toBe(true);
  });

  it("prefers sinceEventId over session since", () => {
    const filter: EventSinkFilter = {
      ...baseFilter,
      since: 100,
      sinceEventId: "a",
    };
    expect(
      matchesSinkFilter(filter, valuesEvent({ event_id: "b", seq: 1 }))
    ).toBe(true);
  });
});
