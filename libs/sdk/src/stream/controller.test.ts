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

function inputRequestedEvent(
  interruptId = "interrupt-1",
  payload: unknown = {
    actionRequests: [
      {
        name: "send_release_update_email",
        args: { to: "qa@example.com" },
      },
    ],
  }
): Event {
  return {
    type: "event",
    event_id: `input-${interruptId}`,
    seq: 1,
    method: "input.requested",
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        interrupt_id: interruptId,
        payload,
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

function lifecycleEvent(event: string, seq: number): Event {
  return {
    type: "event",
    event_id: `lifecycle-${event}-${seq}`,
    seq,
    method: "lifecycle",
    params: {
      namespace: [],
      timestamp: 0,
      data: { event },
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
      startLifecycleWatcher: vi.fn(() => undefined),
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
      startLifecycleWatcher: vi.fn(() => undefined),
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

  it("fires onCompleted without runId for re-attached run terminals", async () => {
    const rootSubscription = makePushableSubscription();
    const onCompleted = vi.fn();
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
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
      onCompleted,
    });
    await controller.hydrationPromise;
    await waitForExpectation(() => {
      expect(thread.subscribe).toHaveBeenCalled();
    });
    await rootSubscription.started;

    rootSubscription.push(lifecycleEvent("running", 1));
    await waitForExpectation(() => {
      expect(controller.rootStore.getSnapshot().isLoading).toBe(true);
    });

    rootSubscription.push(lifecycleEvent("completed", 2));
    await waitForExpectation(() => {
      expect(onCompleted).toHaveBeenCalledWith({ reason: "success" });
    });

    await controller.dispose();
  });

  it("hydrate seeds rootStore.interrupts from getState tasks", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: {},
          tasks: [
            {
              interrupts: [
                { id: "active-1", value: { question: "approve?" } },
                { id: "active-2", value: { question: "verify?" } },
              ],
            },
          ],
        })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-active",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    const snapshot = controller.rootStore.getSnapshot();
    expect(snapshot.interrupts.map((i) => i.id)).toEqual([
      "active-1",
      "active-2",
    ]);
    expect(snapshot.interrupt?.id).toBe("active-1");

    await controller.dispose();
  });

  it("filters replayed input.requested for resolved interrupts", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: {},
          // Server reports interrupt-active as the only currently-
          // pending interrupt. The historical interrupt-resolved id
          // is no longer present because it has been responded to.
          tasks: [
            { interrupts: [{ id: "interrupt-active", value: {} }] },
          ],
        })),
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

    // SSE replay surfaces a historical input.requested for the
    // already-resolved interrupt. The allowlist must drop it.
    onEvent?.(inputRequestedEvent("interrupt-resolved"));
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["interrupt-active"]);

    // Replay of the still-active interrupt is allowed (dedup keeps
    // the list stable since hydrate already seeded it).
    onEvent?.(inputRequestedEvent("interrupt-active"));
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["interrupt-active"]);

    await controller.dispose();
  });

  it("does not filter genuinely new interrupts after submit() clears the allowlist", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [],
      // submitRun never resolves on its own — we abort via dispose()
      // once the test assertions have run.
      // submitRun rejects immediately so submit() unwinds through its
      // error path without needing a real lifecycle terminal. The
      // onSubmitStart hook (which clears the allowlist) fires
      // synchronously before submitRun is invoked.
      submitRun: vi.fn(async () => {
        throw new Error("test-stub-submit-rejected");
      }),
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: {},
          tasks: [{ interrupts: [{ id: "old-interrupt", value: {} }] }],
        })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-new-live",
    });
    await controller.hydrationPromise;

    // Hydrate populates allowlist with [old-interrupt]. Without
    // submit() clearing it, a brand-new live interrupt id would be
    // dropped as "historical".
    const submitPromise = controller.submit(null).catch(() => undefined);
    // Yield so submit's synchronous onSubmitStart hook runs (which
    // clears the allowlist) before the next event is delivered.
    await Promise.resolve();
    onEvent?.(inputRequestedEvent("brand-new-interrupt"));

    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toContain("brand-new-interrupt");

    await controller.dispose();
    await submitPromise;
  });

  it("hydrate without tasks does not wipe in-flight interrupt state", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        // Runtime that doesn't return tasks at all. The mirror block
        // must skip its setState and leave rootStore.interrupts
        // alone — and must not seed the allowlist (so future live
        // interrupts pass through).
        getState: vi.fn(async () => ({ values: {} })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-no-tasks",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    // No tasks in response → allowlist stays null → a fresh live
    // interrupt event lands in rootStore.interrupts unmodified.
    onEvent?.(inputRequestedEvent("live-interrupt"));
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["live-interrupt"]);

    await controller.dispose();
  });

  it("calls thread.startLifecycleWatcher() on hydrate of an existing thread", async () => {
    const startLifecycleWatcher = vi.fn(() => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher,
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
      threadId: "thread-existing",
    });
    await controller.hydrationPromise;

    expect(startLifecycleWatcher).toHaveBeenCalledOnce();
    await controller.dispose();
  });

  it("does not call thread.startLifecycleWatcher() on hydrate when no threadId is bound", async () => {
    const startLifecycleWatcher = vi.fn(() => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher,
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
      threadId: null,
    });
    await controller.hydrationPromise;

    // No thread bound → no lifecycle watcher attached yet. The
    // submit-path call inside `submitRun` is what kicks it for
    // self-created threads (covered by submit-coordinator tests).
    expect(startLifecycleWatcher).not.toHaveBeenCalled();
    await controller.dispose();
  });
});
