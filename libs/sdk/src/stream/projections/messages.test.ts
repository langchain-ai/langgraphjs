import { describe, expect, it, vi } from "vitest";
import type { Event } from "@langchain/protocol";

import { ChannelRegistry } from "../channel-registry.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { messagesProjection } from "./messages.js";

function makeRootBus() {
  const listeners = new Set<(event: Event) => void>();
  return {
    channels: ["messages"],
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

function rootMessagesEvent(data: Record<string, unknown>): Event {
  return {
    type: "event",
    method: "messages",
    params: { namespace: [], timestamp: 0, data },
  } as unknown as Event;
}

describe("messagesProjection", () => {
  it("builds root-namespace messages from the root bus", async () => {
    const rootBus = makeRootBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);
    const { store, release } = registry.acquire(messagesProjection([]));

    rootBus.emit(
      rootMessagesEvent({ event: "message-start", id: "ai-1", role: "ai" })
    );
    rootBus.emit(
      rootMessagesEvent({
        event: "content-block-delta",
        index: 0,
        content: { type: "text", text: "Hello" },
      })
    );

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((message) => message.text)).toEqual([
        "Hello",
      ]);
    });

    release();
  });
});
