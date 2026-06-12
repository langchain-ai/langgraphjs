import { describe, expect, it, vi } from "vitest";
import type { Channel, Event } from "@langchain/protocol";

import { ChannelRegistry } from "../channel-registry.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { channelProjection } from "./channel.js";
import { acquireChannelEffect } from "./channel-effect.js";

function makeRootBus(channels: readonly Channel[] = ["lifecycle", "tools"]) {
  const listeners = new Set<(event: Event) => void>();
  return {
    channels,
    subscribe: vi.fn((listener: (event: Event) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    trySeedFromHistory: vi.fn(),
    emit(event: Event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function lifecycleEvent(eventName: string): Event {
  return {
    type: "event",
    method: "lifecycle",
    params: { namespace: [], data: { event: eventName }, timestamp: 0 },
  } as Event;
}

describe("acquireChannelEffect", () => {
  it("delivers each event that arrives while attached", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    const onEvent = vi.fn();
    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent,
    });

    const started = lifecycleEvent("started");
    const completed = lifecycleEvent("completed");
    rootBus.emit(started);
    rootBus.emit(completed);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, started);
    expect(onEvent).toHaveBeenNthCalledWith(2, completed);

    dispose();
  });

  it("skips events already buffered before it attaches", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    // A sibling consumer (e.g. `useChannel`) populates the shared buffer
    // before the effect attaches.
    const sibling = registry.acquire(
      channelProjection(["lifecycle"], [], { replay: false })
    );
    const historical = lifecycleEvent("started");
    rootBus.emit(historical);

    const onEvent = vi.fn();
    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent,
    });

    // Historical event is not re-delivered.
    expect(onEvent).not.toHaveBeenCalled();

    const live = lifecycleEvent("completed");
    rootBus.emit(live);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(live);

    dispose();
    sibling.release();
  });

  it("shares one subscription with a matching channelProjection consumer", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    const sibling = registry.acquire(
      channelProjection(["lifecycle"], [], { replay: false })
    );
    expect(registry.size).toBe(1);

    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent: vi.fn(),
    });
    // Same spec.key → registry dedupes onto the existing entry.
    expect(registry.size).toBe(1);

    dispose();
    sibling.release();
    expect(registry.size).toBe(0);
  });

  it("stops delivering and releases the projection on dispose", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    const onEvent = vi.fn();
    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent,
    });

    rootBus.emit(lifecycleEvent("started"));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);

    dispose();
    expect(registry.size).toBe(0);

    rootBus.emit(lifecycleEvent("completed"));
    expect(onEvent).toHaveBeenCalledTimes(1);

    // Idempotent.
    expect(() => dispose()).not.toThrow();
  });

  it("routes a throwing onEvent to onError without wedging delivery", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    const onError = vi.fn();
    const onEvent = vi.fn((event: Event) => {
      if ((event.params as { data: { event: string } }).data.event === "boom") {
        throw new Error("analytics sink failed");
      }
    });
    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent,
      onError,
    });

    rootBus.emit(lifecycleEvent("boom"));
    rootBus.emit(lifecycleEvent("ok"));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onEvent).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("re-delivers fresh events after a thread rebind resets the store", () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);

    const onEvent = vi.fn();
    const dispose = acquireChannelEffect(registry, ["lifecycle"], [], {
      onEvent,
    });

    rootBus.emit(lifecycleEvent("started"));
    expect(onEvent).toHaveBeenCalledTimes(1);

    // Swap threads — the registry resets the store and reopens.
    registry.bind({} as ThreadStream);

    const afterSwap = lifecycleEvent("started");
    rootBus.emit(afterSwap);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(afterSwap);

    dispose();
  });
});
