import { describe, expect, it } from "vitest";

import { EventBuffer } from "./buffer.js";
import { eventOf } from "./test/utils.js";

describe("EventBuffer", () => {
  it("evicts oldest events when capacity is exceeded", () => {
    const buffer = new EventBuffer(3);
    for (let i = 0; i < 5; i++) {
      buffer.push(
        eventOf(
          "messages",
          { event: "message-start", message_id: `msg_${i}` },
          { namespace: [], eventId: `evt_${i}` }
        )
      );
    }

    const replayed = buffer.replay({ channels: ["messages"] });
    expect(replayed.length).toBe(3);
    expect(replayed[0].event_id).toBe("evt_2");
    expect(replayed[2].event_id).toBe("evt_4");
  });

  it("replays events after a specific event_id", () => {
    const buffer = new EventBuffer(10);
    for (let i = 0; i < 5; i++) {
      buffer.push(
        eventOf(
          "messages",
          { event: "message-start", message_id: `msg_${i}` },
          { namespace: [], eventId: `evt_${i}` }
        )
      );
    }

    const replayed = buffer.replay({ channels: ["messages"] }, "evt_2");
    expect(replayed.length).toBe(2);
    expect(replayed[0].event_id).toBe("evt_3");
    expect(replayed[1].event_id).toBe("evt_4");
  });

  it("filters replayed events by subscription channels", () => {
    const buffer = new EventBuffer(10);
    buffer.push(
      eventOf(
        "messages",
        { event: "message-start", message_id: "m1" },
        { namespace: [] }
      )
    );
    buffer.push(
      eventOf(
        "lifecycle",
        { event: "run.start", run_id: "r1" },
        { namespace: [] }
      )
    );

    const replayed = buffer.replay({ channels: ["messages"] });
    expect(replayed.length).toBe(1);
    expect(replayed[0].method).toBe("messages");
  });
});
