import { describe, expect, it, vi } from "vitest";
import type { Channel, Event } from "@langchain/protocol";
import type { BaseMessage } from "@langchain/core/messages";

import { ChannelRegistry } from "../channel-registry.js";
import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { messagesProjection } from "./messages.js";

const NS = ["task:1"];

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

function makeThread() {
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  const thread = {
    subscribe: vi.fn(async () => ({
      isPaused: false,
      async unsubscribe() {},
      async waitForResume() {},
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    })),
  } as unknown as ThreadStream;
  const push = (...events: Event[]) => {
    queue.push(...events);
    wake?.();
  };
  return { thread, push };
}

function rootLifecycle(event: string): Event {
  return {
    type: "event",
    method: "lifecycle",
    params: { namespace: [], timestamp: 0, data: { event } },
  } as unknown as Event;
}

function messages(data: Record<string, unknown>): Event {
  return {
    type: "event",
    method: "messages",
    params: { namespace: NS, node: "agent", timestamp: 0, data },
  } as unknown as Event;
}

const start = (id: string) => messages({ event: "message-start", id });
const delta = (text: string) =>
  messages({
    event: "content-block-delta",
    index: 0,
    content: { type: "text", text },
  });
const finish = () => messages({ event: "message-finish", reason: "stop" });

function values(ids: string[]): Event {
  return {
    type: "event",
    method: "values",
    params: {
      namespace: NS,
      timestamp: 0,
      data: {
        messages: ids.map((id) => ({ type: "ai", id, content: id })),
      },
    },
  } as unknown as Event;
}

function open() {
  const { thread, push } = makeThread();
  const rootBus = makeRootBus();
  const projection = messagesProjection(NS);
  const store = new StreamStore<BaseMessage[]>(projection.initial);
  const runtime = projection.open({ thread, store, rootBus });
  const ids = () => store.getSnapshot().map((m) => m.id);
  return { push, rootBus, ids, runtime };
}

describe("messagesProjection (scoped) run boundaries", () => {
  it("drops an unfinished message at the root terminal and ignores late deltas", async () => {
    const { push, rootBus, ids, runtime } = open();
    push(start("cut"), delta("par"));
    await vi.waitFor(() => expect(ids()).toEqual(["cut"]));

    rootBus.emit(rootLifecycle("interrupted"));
    await vi.waitFor(() => expect(ids()).toEqual([]));

    push(delta("tial"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ids()).toEqual([]);

    await runtime.dispose();
  });

  it("keeps a finished message through the terminal and drops it at the next run", async () => {
    const { push, rootBus, ids, runtime } = open();
    push(start("draft"), delta("Draft"), finish());
    await vi.waitFor(() => expect(ids()).toEqual(["draft"]));

    rootBus.emit(rootLifecycle("interrupted"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ids()).toEqual(["draft"]);

    rootBus.emit(rootLifecycle("running"));
    await vi.waitFor(() => expect(ids()).toEqual([]));

    await runtime.dispose();
  });

  it("keeps committed messages across run boundaries", async () => {
    const { push, rootBus, ids, runtime } = open();
    push(start("kept"), delta("kept"), values(["kept"]));
    await vi.waitFor(() => expect(ids()).toEqual(["kept"]));

    rootBus.emit(rootLifecycle("failed"));
    rootBus.emit(rootLifecycle("running"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ids()).toEqual(["kept"]);

    await runtime.dispose();
  });

  it("ignores lifecycle events from other namespaces", async () => {
    const { push, rootBus, ids, runtime } = open();
    push(start("cut"), delta("partial"));
    await vi.waitFor(() => expect(ids()).toEqual(["cut"]));

    rootBus.emit({
      type: "event",
      method: "lifecycle",
      params: { namespace: NS, timestamp: 0, data: { event: "completed" } },
    } as unknown as Event);
    await new Promise((r) => setTimeout(r, 20));
    expect(ids()).toEqual(["cut"]);

    await runtime.dispose();
  });
});

function makeRootMessagesBus() {
  const listeners = new Set<(event: Event) => void>();
  return {
    channels: ["messages", "values"],
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
    const rootBus = makeRootMessagesBus();
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

  it("takes root-namespace values snapshots for messages that never streamed", async () => {
    const rootBus = makeRootMessagesBus();
    const registry = new ChannelRegistry(rootBus as unknown as RootEventBus);
    registry.bind({} as ThreadStream);
    const { store, release } = registry.acquire(messagesProjection([]));

    rootBus.emit({
      type: "event",
      method: "values",
      params: {
        namespace: [],
        timestamp: 0,
        data: {
          messages: [
            { type: "human", content: "hi", id: "human-1" },
            { type: "ai", content: "Hello there.", id: "ai-1" },
          ],
        },
      },
    } as unknown as Event);

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((message) => message.id)).toEqual([
        "human-1",
        "ai-1",
      ]);
    });

    release();
  });
});
