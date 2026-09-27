import { describe, expect, it, vi } from "vitest";
import type { Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { SubscriptionHandle } from "../../client/stream/index.js";
import { messagesProjection } from "./messages.js";
import { valuesProjection } from "./values.js";

function makeRootBus(): RootEventBus {
  return {
    channels: ["values", "checkpoints", "lifecycle", "input", "messages", "tools"],
    subscribe: vi.fn(() => () => {}),
  } as unknown as RootEventBus;
}

function valuesEvent(namespace: string[], messages: unknown[]): Event {
  return {
    type: "event",
    method: "values",
    params: { namespace, data: { messages } },
  } as unknown as Event;
}

function messagesEvent(namespace: string[], data: Record<string, unknown>): Event {
  return {
    type: "event",
    method: "messages",
    params: { namespace, timestamp: Date.now(), data },
  } as unknown as Event;
}

function human(id: string, content: string) {
  return { id, type: "human", content };
}

function ai(id: string, content: string) {
  return { id, type: "ai", content };
}

function drainFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("messagesProjection", () => {
  it("ignores values events from a child namespace", async () => {
    const PARENT = ["tools:parent"];
    const CHILD = ["tools:parent", "tools:child"];

    const handle = new SubscriptionHandle<Event>(
      "sub",
      {
        channels: ["messages", "values"],
        namespaces: [PARENT],
        depth: 1,
      },
      async () => {}
    );

    const thread = {
      subscribe: vi.fn(async () => handle),
    } as unknown as ThreadStream;

    const projection = messagesProjection(PARENT);
    const store = new StreamStore(projection.initial);
    const runtime = projection.open({
      thread,
      store,
      rootBus: makeRootBus(),
    });

    const snapshotIds = () =>
      (store.getSnapshot() as { id?: string }[]).map((m) => m.id);

    await drainFlush();
    handle.push(valuesEvent(PARENT, [human("parent-human", "research"), ai("parent-ai", "")]));
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai"]);

    // A nested subagent's values snapshot must not rebuild the parent store.
    handle.push(valuesEvent(CHILD, [human("child-human", "sub task")]));
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai"]);

    handle.push(valuesEvent(CHILD, [human("child-human", "sub task"), ai("child-ai", "hello")]));
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai"]);

    handle.push(messagesEvent(CHILD, { event: "message-start", id: "child-ai", role: "ai" }));
    handle.push(messagesEvent(CHILD, {
      event: "content-block-start",
      index: 0,
      content: { type: "text", text: "child output" },
    }));
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai"]);

    // The parent's next snapshot still reconciles normally.
    handle.push(
      valuesEvent(PARENT, [
        human("parent-human", "research"),
        ai("parent-ai", ""),
        { id: "parent-tool", type: "tool", content: "done", tool_call_id: "call-child" },
      ])
    );
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai", "parent-tool"]);

    handle.push(messagesEvent(PARENT, { event: "message-start", id: "parent-next", role: "ai" }));
    handle.push(messagesEvent(PARENT, {
      event: "content-block-start",
      index: 0,
      content: { type: "text", text: "parent output" },
    }));
    await drainFlush();
    expect(snapshotIds()).toEqual(["parent-human", "parent-ai", "parent-tool", "parent-next"]);

    await runtime.dispose();
  });

  it("valuesProjection ignores values events from a child namespace", async () => {
    const PARENT = ["tools:parent"];
    const CHILD = ["tools:parent", "tools:child"];

    const handle = new SubscriptionHandle<Event>(
      "sub",
      {
        channels: ["values"],
        namespaces: [PARENT],
        depth: 1,
      },
      async () => {}
    );

    const thread = {
      subscribe: vi.fn(async () => handle),
    } as unknown as ThreadStream;

    const projection = valuesProjection<{ counter?: number }>(PARENT);
    const store = new StreamStore(projection.initial);
    const runtime = projection.open({
      thread,
      store,
      rootBus: makeRootBus(),
    });

    await drainFlush();
    handle.push({
      type: "event",
      method: "values",
      params: { namespace: PARENT, data: { counter: 1 } },
    } as unknown as Event);
    await drainFlush();
    expect(store.getSnapshot()).toEqual({ counter: 1 });

    handle.push({
      type: "event",
      method: "values",
      params: { namespace: CHILD, data: { counter: 999 } },
    } as unknown as Event);
    await drainFlush();
    expect(store.getSnapshot()).toEqual({ counter: 1 });

    handle.push({
      type: "event",
      method: "values",
      params: { namespace: PARENT, data: { counter: 2 } },
    } as unknown as Event);
    await drainFlush();
    expect(store.getSnapshot()).toEqual({ counter: 2 });

    await runtime.dispose();
  });
});
