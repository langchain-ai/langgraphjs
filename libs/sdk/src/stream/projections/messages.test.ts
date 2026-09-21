import { describe, expect, it, vi } from "vitest";
import type { Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import type { RootEventBus, ThreadStream } from "../types.js";
import { SubscriptionHandle } from "../../client/stream/index.js";
import { messagesProjection } from "./messages.js";

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

    await runtime.dispose();
  });
});
