import { describe, expect, it, vi } from "vitest";
import type { Channel, Event } from "@langchain/protocol";

import { StreamStore } from "../store.js";
import { messagesProjection } from "./messages.js";
import { toolCallsProjection } from "./tool-calls.js";
import { valuesProjection } from "./values.js";

const namespace = ["tools:worker"];

function event(method: Event["method"], data: unknown): Event {
  return {
    type: "event",
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

function messageEvents(id: string, text: string): Event[] {
  return [
    event("messages", { event: "message-start", id, role: "ai" }),
    event("messages", {
      event: "content-block-delta",
      index: 0,
      delta: { type: "text-delta", text },
    }),
  ];
}

function toolStartedEvent(callId: string): Event {
  return event("tools", {
    event: "tool-started",
    tool_call_id: callId,
    tool_name: "search",
    input: { query: callId },
  });
}

function valuesEvent(value: string): Event {
  return event("values", { answer: value });
}

function makePausedSubscription(firstBatch: Event[], nextBatch: Event[]) {
  let resolveResume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resolveResume = resolve;
  });
  let batch = 0;
  const subscription = {
    isPaused: false,
    unsubscribe: vi.fn(async () => undefined),
    waitForResume: vi.fn(() => resumed),
    async *[Symbol.asyncIterator]() {
      if (batch++ === 0) {
        yield* firstBatch;
        this.isPaused = true;
        return;
      }
      yield* nextBatch;
      this.isPaused = false;
    },
  };

  return {
    subscription,
    resume() {
      subscription.isPaused = false;
      resolveResume();
    },
  };
}

function makeRootBus() {
  return {
    channels: [] as Channel[],
    subscribe: vi.fn(() => () => undefined),
    trySeedFromHistory: vi.fn(async () => false),
  };
}

describe("scoped projections", () => {
  it("keeps message projections subscribed after an interrupted run resumes", async () => {
    const spec = messagesProjection(namespace);
    const { subscription, resume } = makePausedSubscription(
      messageEvents("before", "before"),
      messageEvents("after", "after")
    );
    const thread = { subscribe: vi.fn(async () => subscription) };
    const store = new StreamStore(spec.initial);
    const runtime = spec.open({
      thread: thread as never,
      store,
      rootBus: makeRootBus() as never,
    });

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((message) => message.id)).toEqual([
        "before",
      ]);
    });
    await vi.waitFor(() =>
      expect(subscription.waitForResume).toHaveBeenCalledTimes(1)
    );

    resume();

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((message) => message.id)).toEqual([
        "before",
        "after",
      ]);
    });
    await runtime.dispose();
  });

  it("keeps tool-call projections subscribed after an interrupted run resumes", async () => {
    const spec = toolCallsProjection(namespace);
    const { subscription, resume } = makePausedSubscription(
      [toolStartedEvent("before")],
      [toolStartedEvent("after")]
    );
    const thread = { subscribe: vi.fn(async () => subscription) };
    const store = new StreamStore(spec.initial);
    const runtime = spec.open({
      thread: thread as never,
      store,
      rootBus: makeRootBus() as never,
    });

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((call) => call.callId)).toEqual([
        "before",
      ]);
    });
    await vi.waitFor(() =>
      expect(subscription.waitForResume).toHaveBeenCalledTimes(1)
    );

    resume();

    await vi.waitFor(() => {
      expect(store.getSnapshot().map((call) => call.callId)).toEqual([
        "before",
        "after",
      ]);
    });
    await runtime.dispose();
  });

  it("keeps values projections subscribed after an interrupted run resumes", async () => {
    const spec = valuesProjection(namespace);
    const { subscription, resume } = makePausedSubscription(
      [valuesEvent("before")],
      [valuesEvent("after")]
    );
    const thread = { subscribe: vi.fn(async () => subscription) };
    const store = new StreamStore(spec.initial);
    const runtime = spec.open({
      thread: thread as never,
      store,
      rootBus: makeRootBus() as never,
    });

    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual({ answer: "before" })
    );
    await vi.waitFor(() =>
      expect(subscription.waitForResume).toHaveBeenCalledTimes(1)
    );

    resume();

    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual({ answer: "after" })
    );
    await runtime.dispose();
  });
});
