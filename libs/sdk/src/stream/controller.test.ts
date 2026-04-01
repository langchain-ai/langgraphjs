import type { Event } from "@langchain/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamController } from "./controller.js";
import type { ThreadStream } from "../client/stream/index.js";

interface State {
  messages?: unknown[];
}

function makeNeverEndingSubscription() {
  let closed = false;
  return {
    isPaused: false,
    waitForResume: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => {
      closed = true;
    }),
    close: vi.fn(() => {
      closed = true;
    }),
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Event>> => {
          if (!closed) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
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

function inputRequestedEvent(): Event {
  return {
    type: "event",
    event_id: "input-1",
    seq: 1,
    method: "input.requested",
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        interrupt_id: "interrupt-1",
        payload: {
          actionRequests: [
            {
              name: "send_release_update_email",
              args: { to: "qa@example.com" },
            },
          ],
        },
      },
    },
  } as Event;
}

function valuesEvent(messages: unknown[], seq: number): Event {
  return {
    type: "event",
    event_id: `values-${seq}`,
    seq,
    method: "values",
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        messages,
      },
    },
  } as Event;
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 500) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError != null) throw lastError;
}

describe("StreamController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors root interrupts observed by the wildcard watcher into root state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [],
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {} })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    onEvent?.(inputRequestedEvent());

    expect(controller.rootStore.getSnapshot().interrupt).toEqual({
      id: "interrupt-1",
      value: {
        actionRequests: [
          {
            name: "send_release_update_email",
            args: { to: "qa@example.com" },
          },
        ],
      },
    });

    await controller.dispose();
  });

  it("continues root processing when discovery subscribers throw", async () => {
    const rootSubscription = makePushableSubscription();
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {} })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    await waitForExpectation(() => {
      expect(thread.subscribe).toHaveBeenCalled();
    });
    await rootSubscription.started;

    const unsubscribe = controller.subagentStore.subscribe(() => {
      throw new Error("subscriber failed");
    });

    rootSubscription.push(
      valuesEvent(
        [
          { type: "human", content: "run deep agent", id: "human-1" },
          {
            type: "ai",
            id: "ai-1",
            content: "",
            tool_calls: [
              {
                id: "toolu_1",
                name: "task",
                args: {
                  subagent_type: "researcher",
                  description: "research spring rain",
                },
                type: "tool_call",
              },
            ],
          },
        ],
        1
      )
    );

    await waitForExpectation(() => {
      expect(controller.rootStore.getSnapshot().messages).toHaveLength(2);
    });

    rootSubscription.push(
      valuesEvent(
        [
          { type: "human", content: "run deep agent", id: "human-1" },
          {
            type: "ai",
            id: "ai-1",
            content: "",
            tool_calls: [
              {
                id: "toolu_1",
                name: "task",
                args: {
                  subagent_type: "researcher",
                  description: "research spring rain",
                },
                type: "tool_call",
              },
            ],
          },
          {
            type: "ai",
            id: "ai-final",
            content: "Final answer",
          },
        ],
        2
      )
    );

    await waitForExpectation(() => {
      expect(controller.rootStore.getSnapshot().messages).toHaveLength(3);
    });

    unsubscribe();
    await controller.dispose();
  });
});
