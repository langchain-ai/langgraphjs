import { describe, expect, it, vi } from "vitest";
import type { Event, SubscribeParams } from "@langchain/protocol";

import { matchesSubscription } from "../../client/stream/subscription.js";
import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { valuesProjection } from "./values.js";

function valuesEvent(namespace: string[], step: string): Event {
  return {
    type: "event",
    method: "values",
    params: { namespace, timestamp: 0, data: { step } },
  } as unknown as Event;
}

describe("valuesProjection", () => {
  it.each([
    ["a first level", ["tools:parent"]],
    ["a second level", ["tools:parent", "tools:child"]],
  ])("applies only events from %s namespace", async (_, ns) => {
    const events = [
      valuesEvent(ns, "parent-1"),
      valuesEvent([...ns, "tools:grandchild"], "child"),
      valuesEvent([...ns.slice(0, -1), "tools:sibling"], "sibling"),
      valuesEvent(ns, "parent-2"),
    ];
    const thread = {
      subscribe: vi.fn(async (params: SubscribeParams) => ({
        isPaused: false,
        async unsubscribe() {},
        async waitForResume() {},
        async *[Symbol.asyncIterator]() {
          yield* events.filter((event) => matchesSubscription(event, params));
        },
      })),
    } as unknown as ThreadStream;
    const rootBus = { channels: [], subscribe: vi.fn() } as unknown as RootEventBus;
    const projection = valuesProjection<{ step: string }>(ns);
    const store = new StreamStore(projection.initial);
    const seen: (string | undefined)[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()?.step));

    const runtime = projection.open({ thread, store, rootBus });

    await vi.waitFor(() => expect(seen).toEqual(["parent-1", "parent-2"]));

    await runtime.dispose();
  });
});
