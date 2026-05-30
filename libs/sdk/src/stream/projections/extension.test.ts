import { expect, describe, it, vi } from "vitest";
import type { Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import { extensionProjection } from "./extension.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function customEvent(name: string, payload: unknown): Event {
  return {
    type: "event",
    method: "custom",
    params: {
      namespace: [],
      timestamp: Date.now(),
      data: { name, payload },
    },
  } as Event;
}

function wrappedCustomEvent(name: string, payload: unknown): Event {
  return {
    type: "event",
    method: "custom",
    params: {
      namespace: [],
      timestamp: Date.now(),
      data: { payload: { name, payload } },
    },
  } as Event;
}

function makeSubscription(events: Event[] = []) {
  return {
    subscriptionId: "sub",
    params: { channels: ["custom"] },
    isPaused: false,
    waitForResume: vi.fn(),
    unsubscribe: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function makeRootBus() {
  return {
    channels: [],
    subscribe: vi.fn(() => () => undefined),
  };
}

describe("extensionProjection", () => {
  it("filters named custom events from the raw custom channel", async () => {
    const subscription = makeSubscription([
      customEvent("other", { label: "skip" }),
      wrappedCustomEvent("status", { label: "answering" }),
    ]);
    const thread = {
      subscribe: vi.fn(async () => subscription),
    };
    const store = new StreamStore<unknown>(undefined);

    extensionProjection("status", []).open({
      thread: thread as never,
      store,
      rootBus: makeRootBus(),
    });

    await vi.waitFor(() => {
      expect(store.getSnapshot()).toEqual({ label: "answering" });
    });
    expect(thread.subscribe).toHaveBeenCalledWith({
      channels: ["custom:status"],
      namespaces: [[]],
      depth: 1,
    });
  });

  it("unsubscribes when disposed before subscribe resolves", async () => {
    const pending = deferred<ReturnType<typeof makeSubscription>>();
    const thread = {
      subscribe: vi.fn(() => pending.promise),
    };
    const store = new StreamStore<unknown>(undefined);
    const runtime = extensionProjection("status", []).open({
      thread: thread as never,
      store,
      rootBus: makeRootBus(),
    });

    await runtime.dispose();

    const subscription = makeSubscription();
    pending.resolve(subscription);

    await vi.waitFor(() => {
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
