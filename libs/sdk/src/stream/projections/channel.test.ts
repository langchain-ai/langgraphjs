import { describe, expect, it, vi } from "vitest";
import type { Channel, Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { channelProjection } from "./channel.js";

function makeRootBus(channels: readonly Channel[] = ["lifecycle"]) {
  const listeners = new Set<(event: Event) => void>();
  return {
    channels,
    subscribe: vi.fn((listener: (event: Event) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: Event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function lifecycleEvent(namespace: string[], eventName: string): Event {
  return {
    type: "event",
    method: "lifecycle",
    params: {
      namespace,
      data: { event: eventName },
    },
  } as Event;
}

describe("channelProjection", () => {
  it("uses subscription replay by default even if rootBus covers the channel", async () => {
    const replayed = lifecycleEvent(["worker:run"], "started");
    const thread = {
      subscribe: vi.fn(async () => ({
        isPaused: false,
        async unsubscribe() {},
        async waitForResume() {},
        async *[Symbol.asyncIterator]() {
          yield replayed;
        },
      })),
    } as unknown as ThreadStream;
    const rootBus = makeRootBus();
    const projection = channelProjection(["lifecycle"], []);
    const store = new StreamStore(projection.initial);

    projection.open({ thread, store, rootBus });

    await vi.waitFor(() => expect(store.getSnapshot()).toEqual([replayed]));
    expect(rootBus.subscribe).not.toHaveBeenCalled();
    expect(thread.subscribe).toHaveBeenCalledWith({
      channels: ["lifecycle"],
      namespaces: [[]],
      depth: 1,
    });
  });

  it("uses the root bus for covered root channels when replay is disabled", () => {
    const rootBus = makeRootBus();
    const projection = channelProjection(["lifecycle"], [], { replay: false });
    const store = new StreamStore(projection.initial);
    const thread = {
      subscribe: vi.fn(),
    } as unknown as ThreadStream;
    const live = lifecycleEvent([], "running");

    projection.open({ thread, store, rootBus: rootBus as RootEventBus });
    rootBus.emit(live);

    expect(store.getSnapshot()).toEqual([live]);
    expect(rootBus.subscribe).toHaveBeenCalledTimes(1);
    expect(thread.subscribe).not.toHaveBeenCalled();
  });
});
