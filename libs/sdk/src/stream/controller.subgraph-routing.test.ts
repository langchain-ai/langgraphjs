import type { Event } from "@langchain/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ThreadStream } from "../client/stream/index.js";
import { StreamController } from "./controller.js";

interface State {
  messages?: unknown[];
}

function makePushableSubscription() {
  let closed = false;
  const queue: Event[] = [];
  const pending: Array<(result: IteratorResult<Event>) => void> = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const close = () => {
    closed = true;
    while (pending.length > 0) {
      pending.shift()?.({ done: true, value: undefined });
    }
  };

  return {
    isPaused: false,
    waitForResume: vi.fn(async () => undefined),
    started,
    unsubscribe: vi.fn(async () => {
      close();
    }),
    close: vi.fn(close),
    push(event: Event) {
      if (closed) return;
      const resolve = pending.shift();
      if (resolve != null) {
        resolve({ done: false, value: event });
      } else {
        queue.push(event);
      }
    },
    [Symbol.asyncIterator]() {
      resolveStarted();
      return {
        next: async (): Promise<IteratorResult<Event>> => {
          const event = queue.shift();
          if (event != null) return { done: false, value: event };
          if (closed) return { done: true, value: undefined };
          return await new Promise<IteratorResult<Event>>((resolve) => {
            pending.push(resolve);
          });
        },
      };
    },
  };
}

function valuesEvent(namespace: string[], seq: number): Event {
  return {
    type: "event",
    event_id: `values-${seq}`,
    seq,
    method: "values",
    params: {
      namespace,
      timestamp: 0,
      data: { messages: [] },
    },
  } as Event;
}

function messageStartEvent(
  id: string,
  namespace: string[],
  seq: number
): Event {
  return {
    type: "event",
    event_id: `message-${seq}`,
    seq,
    method: "messages",
    params: {
      namespace,
      timestamp: 0,
      data: { event: "message-start", id, role: "ai" },
    },
  } as unknown as Event;
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 500) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError != null) throw lastError;
}

describe("StreamController subgraph message routing", () => {
  it("keeps discovered subgraph messages out of root state", async () => {
    const rootSubscription = makePushableSubscription();
    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State>({
      assistantId: "subgraph-agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    await rootSubscription.started;
    expect(onEvent).toBeDefined();

    const emit = (event: Event) => {
      onEvent?.(event);
      rootSubscription.push(event);
    };
    const subgraphNamespace = [
      "worker:00000000-0000-0000-0000-000000000001",
    ];

    emit(valuesEvent(subgraphNamespace, 1));
    expect(
      [...controller.subgraphStore.getSnapshot().values()].map(
        (subgraph) => subgraph.namespace
      )
    ).toContainEqual(subgraphNamespace);

    emit(messageStartEvent("child-message", subgraphNamespace, 2));
    emit(messageStartEvent("root-message", ["model:root-run"], 3));

    await waitForExpectation(() => {
      expect(
        controller.rootStore.getSnapshot().messages.map((message) => message.id)
      ).toEqual(["root-message"]);
    });

    await controller.dispose();
  });
});
