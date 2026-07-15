import type { Event } from "@langchain/protocol";
import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamController } from "./controller.js";
import { messagesProjection } from "./projections/messages.js";
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

function checkpointsEvent(step: number, seq: number, id = `cp-${step}`): Event {
  return {
    type: "event",
    event_id: `checkpoints-${step}-${seq}`,
    seq,
    method: "checkpoints",
    params: {
      namespace: [],
      timestamp: 0,
      data: { id, step },
    },
  } as unknown as Event;
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

function messageStartEvent(id: string, seq: number, role = "ai"): Event {
  return {
    type: "event",
    event_id: `msg-start-${id}-${seq}`,
    seq,
    method: "messages",
    params: {
      namespace: [],
      timestamp: 0,
      data: { event: "message-start", id, role },
    },
  } as unknown as Event;
}

function messageDeltaEvent(seq: number, text: string): Event {
  return {
    type: "event",
    event_id: `msg-delta-${seq}`,
    seq,
    method: "messages",
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        event: "content-block-delta",
        index: 0,
        content: { type: "text", text },
      },
    },
  } as unknown as Event;
}

function namespacedLifecycleEvent(
  namespace: readonly string[],
  event: "started" | "completed",
  seq: number
): Event {
  return {
    type: "event",
    event_id: `lifecycle-${namespace.join("/")}-${event}-${seq}`,
    seq,
    method: "lifecycle",
    params: {
      namespace,
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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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

    const interrupt = controller.rootStore.getSnapshot().interrupt;
    expect(interrupt?.id).toBe("interrupt-1");
    expect(
      (interrupt?.value as { actionRequests?: unknown[] } | undefined)
        ?.actionRequests
    ).toEqual([
      expect.objectContaining({
        name: "send_release_update_email",
        args: { to: "qa@example.com" },
      }),
    ]);

    await controller.dispose();
  });

  it("normalizes Python snake_case HITL interrupt payloads in root state", async () => {
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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    onEvent?.(
      inputRequestedEvent("interrupt-py", {
        action_requests: [
          {
            name: "send_email",
            args: { to: "team@acme.com" },
            description: "Review email before sending",
          },
        ],
        review_configs: [
          {
            action_name: "send_email",
            allowed_decisions: ["approve", "edit", "reject"],
          },
        ],
      })
    );

    const value = controller.rootStore.getSnapshot().interrupt?.value as Record<
      string,
      unknown
    >;
    expect(value.actionRequests).toEqual([
      expect.objectContaining({
        name: "send_email",
        args: { to: "team@acme.com" },
        description: "Review email before sending",
      }),
    ]);
    expect(value.reviewConfigs).toEqual([
      expect.objectContaining({
        allowedDecisions: ["approve", "edit", "reject"],
      }),
    ]);

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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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

  it("does not drop hydrate-seeded tail messages when the root pump replays an older checkpoint", async () => {
    // Reconnect to an active thread whose getState() already carries the
    // finished message tail (human → ai(tool) → tool → ai(final)). The
    // root pump then replays the run from an earlier checkpoint whose
    // values snapshot only has the first two messages. The earlier
    // (older) snapshot must NOT be treated as a removal of the seeded
    // tail — otherwise the final assistant message vanishes after the
    // /events replay lands, exactly the deep-agent reconnect symptom.
    const rootSubscription = makePushableSubscription();
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const seededMessages = [
      { type: "human", content: "compare frameworks", id: "human-1" },
      {
        type: "ai",
        id: "ai-1",
        content: "",
        tool_calls: [
          {
            id: "toolu_1",
            name: "task",
            args: { subagent_type: "researcher", description: "react" },
            type: "tool_call",
          },
        ],
      },
      { type: "tool", id: "tool-1", content: "react facts", tool_call_id: "toolu_1" },
      { type: "ai", id: "ai-final", content: "All workers completed." },
    ];
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: { messages: seededMessages },
          next: ["agent"],
          checkpoint: { checkpoint_id: "cp-latest" },
          metadata: { step: 5 },
        })),
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
      expect(controller.rootStore.getSnapshot().messages).toHaveLength(4);
    });
    await rootSubscription.started;

    // Older replay checkpoint (step 1): only the first two messages
    // exist yet. The seed carried the latest step (5), so this is stale.
    rootSubscription.push(checkpointsEvent(1, 1));
    rootSubscription.push(
      valuesEvent([seededMessages[0], seededMessages[1]], 2)
    );

    // Give the projection's macrotask flush time to (incorrectly) drop.
    await new Promise((r) => setTimeout(r, 50));

    // The seeded tail (tool-1, ai-final) must survive the older snapshot.
    await waitForExpectation(() => {
      const ids = controller.rootStore
        .getSnapshot()
        .messages.map((m) => (m as { id?: string }).id);
      expect(ids).toContain("ai-final");
      expect(ids).toContain("tool-1");
    });

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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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

  it("prefers transport.getState over client.threads.getState", async () => {
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const transportGetState = vi.fn(async () => ({
      values: { messages: [{ type: "human", content: "from transport" }] },
      next: [],
      tasks: [],
    }));
    const clientGetState = vi.fn(async () => {
      throw new Error("client getState should not run");
    });
    const client = {
      threads: {
        getState: clientGetState,
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "custom-backend",
      client: client as never,
      threadId: "thread-transport",
      transport: { getState: transportGetState } as never,
    });
    await controller.hydrationPromise;

    expect(transportGetState).toHaveBeenCalledTimes(1);
    expect(clientGetState).not.toHaveBeenCalled();

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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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

  it("does NOT open SSE pumps on hydrate of an idle (finished) thread", async () => {
    const startLifecycleWatcher = vi.fn(() => undefined);
    const subscribe = vi.fn(async () => makeNeverEndingSubscription());
    const onEvent = vi.fn(() => vi.fn());
    const thread = {
      subscribe,
      onEvent,
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher,
    } as unknown as ThreadStream;
    const client = {
      threads: {
        // next:[] and no pending interrupts → finished → idle.
        getState: vi.fn(async () => ({ values: {}, next: [], tasks: [] })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-finished",
    });
    await controller.hydrationPromise;

    // Cards are seeded from getState + getHistory; neither always-on
    // SSE pump should open for a finished thread.
    expect(subscribe).not.toHaveBeenCalled();
    expect(startLifecycleWatcher).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    await controller.dispose();
  });

  it("brings up the content pump on first submit() for an idle thread", async () => {
    const subscribe = vi.fn(async () => makeNeverEndingSubscription());
    const startLifecycleWatcher = vi.fn(() => undefined);
    const submitRun = vi.fn(async () => ({ run_id: "run-1" }));
    const thread = {
      subscribe,
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      submitRun,
      startLifecycleWatcher,
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: [], tasks: [] })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-idle",
    });
    await controller.hydrationPromise;
    // Deferred at hydrate.
    expect(subscribe).not.toHaveBeenCalled();

    void controller.submit({ messages: [] });

    // The deferred content pump comes up once the dispatch lands.
    await waitForExpectation(() => {
      expect(thread.submitRun).toHaveBeenCalled();
      expect(subscribe).toHaveBeenCalled();
    });
    await controller.dispose();
  });

  it("does not re-stream seeded messages when the first submit replays an idle thread", async () => {
    // Open a finished thread (idle), seeded from getState with a complete
    // tail. On the first submit the deferred pump comes up and the
    // transport replays the finished run from seq=0 — including the
    // `messages` channel. That replay must NOT clobber the seeded tail by
    // re-streaming it from an empty start (the visible "messages replay").
    const rootSubscription = makePushableSubscription();
    const submitRun = vi.fn(async () => ({ run_id: "run-1" }));
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      submitRun,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const seededMessages = [
      { type: "human", content: "ship it", id: "human-1" },
      { type: "ai", id: "ai-1", content: "All done." },
    ];
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: { messages: seededMessages },
          next: [],
          tasks: [],
          checkpoint: { checkpoint_id: "cp-latest" },
          metadata: { step: 5 },
        })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-idle",
    });
    await controller.hydrationPromise;
    await waitForExpectation(() => {
      expect(controller.rootStore.getSnapshot().messages).toHaveLength(2);
    });

    void controller.submit({ messages: [] });
    await waitForExpectation(() => {
      expect(thread.submitRun).toHaveBeenCalled();
      expect(thread.subscribe).toHaveBeenCalled();
    });
    await rootSubscription.started;

    // seq=0 replay of the finished run re-streams ai-1 from an empty start.
    rootSubscription.push(messageStartEvent("ai-1", 1));
    rootSubscription.push(messageDeltaEvent(2, "A"));
    rootSubscription.push(messageDeltaEvent(3, "All do"));

    // Give the projection's macrotask flush time to (incorrectly) clobber.
    await new Promise((r) => setTimeout(r, 50));

    const messages = controller.rootStore.getSnapshot().messages;
    expect(messages.map((m) => (m as { id?: string }).id)).toEqual([
      "human-1",
      "ai-1",
    ]);
    expect((messages[1] as { text?: string }).text).toBe("All done.");

    await controller.dispose();
  });

  it("does not re-stream seeded messages on idle submit when getState omits metadata.step", async () => {
    // Same as above, but the idle thread's getState carries no
    // metadata.step (server/custom transport). The seal boundary is then
    // unknown, so the deferred pump's replayed `values` checkpoints —
    // which carry their own increasing steps — must NOT advance the
    // timeline past the seed and lift the seal mid-replay (the bug).
    const rootSubscription = makePushableSubscription();
    const submitRun = vi.fn(async () => ({ run_id: "run-1" }));
    const thread = {
      subscribe: vi.fn(async () => rootSubscription),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      submitRun,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const seededMessages = [
      { type: "human", content: "ship it", id: "human-1" },
      { type: "ai", id: "ai-1", content: "All done." },
    ];
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: { messages: seededMessages },
          next: [],
          tasks: [],
          checkpoint: { checkpoint_id: "cp-latest" },
          // No metadata.step — the seal boundary is unknown.
          metadata: {},
        })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-idle-no-step",
    });
    await controller.hydrationPromise;
    await waitForExpectation(() => {
      expect(controller.rootStore.getSnapshot().messages).toHaveLength(2);
    });

    void controller.submit({ messages: [] });
    await waitForExpectation(() => {
      expect(thread.submitRun).toHaveBeenCalled();
      expect(thread.subscribe).toHaveBeenCalled();
    });
    await rootSubscription.started;

    // seq=0 replay of the finished run: its checkpoints carry increasing
    // steps that initialize and then advance the projection's high-water
    // mark. With an unknown seal boundary these must not lift the seal.
    rootSubscription.push(checkpointsEvent(1, 1));
    rootSubscription.push(valuesEvent(seededMessages, 2));
    rootSubscription.push(checkpointsEvent(2, 3));
    rootSubscription.push(valuesEvent(seededMessages, 4));

    // ...and the replayed `messages` channel re-streams ai-1 from empty.
    rootSubscription.push(messageStartEvent("ai-1", 5));
    rootSubscription.push(messageDeltaEvent(6, "A"));
    rootSubscription.push(messageDeltaEvent(7, "All do"));

    await new Promise((r) => setTimeout(r, 50));

    const messages = controller.rootStore.getSnapshot().messages;
    expect(messages.map((m) => (m as { id?: string }).id)).toEqual([
      "human-1",
      "ai-1",
    ]);
    expect((messages[1] as { text?: string }).text).toBe("All done.");

    await controller.dispose();
  });

  it("opens SSE pumps eagerly when getState omits `next` (unknown shape)", async () => {
    const startLifecycleWatcher = vi.fn(() => undefined);
    const subscribe = vi.fn(async () => makeNeverEndingSubscription());
    const thread = {
      subscribe,
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      startLifecycleWatcher,
    } as unknown as ThreadStream;
    const client = {
      threads: {
        // Custom/legacy server shape with no `next` array — must NOT be
        // mistaken for "finished", or an in-flight run goes unobserved.
        getState: vi.fn(async () => ({ values: {} })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "deep-agent",
      client: client as never,
      threadId: "thread-no-next",
    });
    await controller.hydrationPromise;

    expect(startLifecycleWatcher).toHaveBeenCalledOnce();
    await waitForExpectation(() => {
      expect(subscribe).toHaveBeenCalled();
    });
    await controller.dispose();
  });

  it("opens the lifecycle watcher eagerly for an interrupted thread", async () => {
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
        // No next nodes, but a pending interrupt → active (a resume
        // will start a run that must be observed).
        getState: vi.fn(async () => ({
          values: {},
          next: [],
          tasks: [{ interrupts: [{ id: "int-1", value: {} }] }],
        })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-interrupted",
    });
    await controller.hydrationPromise;

    expect(startLifecycleWatcher).toHaveBeenCalledOnce();
    await controller.dispose();
  });

  it("hydrate(null) clears subgraph discovery from the previous thread", async () => {
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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "graph-execution-cards",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    onEvent?.(namespacedLifecycleEvent(["classify:u1"], "started", 1));
    onEvent?.(
      namespacedLifecycleEvent(["classify:u1", "inner:u2"], "started", 2)
    );
    await waitForExpectation(() => {
      expect(controller.subgraphStore.getSnapshot().size).toBeGreaterThan(0);
    });

    await controller.hydrate(null);

    expect(controller.subgraphStore.getSnapshot().size).toBe(0);
    expect(controller.subgraphByNodeStore.getSnapshot().size).toBe(0);
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
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
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

  it("stop() cancels the active run on the server by default", async () => {
    let submitRunResolve!: (value: { run_id: string }) => void;
    const submitRunPromise = new Promise<{ run_id: string }>((resolve) => {
      submitRunResolve = resolve;
    });
    const onCreated = vi.fn();

    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      submitRun: vi.fn(() => submitRunPromise),
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const cancel = vi.fn(async () => undefined);
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
      runs: { cancel },
    };

    const controller = new StreamController<State>({
      assistantId: "assistant",
      client: client as never,
      threadId: "thread-1",
      onCreated,
    });
    await controller.hydrationPromise;

    const submitPromise = controller.submit({ messages: [] });
    await waitForExpectation(() => {
      expect(thread.submitRun).toHaveBeenCalled();
    });

    submitRunResolve({ run_id: "run-abc" });
    await waitForExpectation(() => {
      expect(onCreated).toHaveBeenCalledWith({ runId: "run-abc" });
    });

    await controller.stop();
    expect(cancel).toHaveBeenCalledWith("thread-1", "run-abc");
    expect(controller.rootStore.getSnapshot().isLoading).toBe(false);

    await controller.dispose();
    await submitPromise.catch(() => undefined);
  });

  it("disconnect() does not call runs.cancel", async () => {
    let submitRunResolve!: (value: { run_id: string }) => void;
    const submitRunPromise = new Promise<{ run_id: string }>((resolve) => {
      submitRunResolve = resolve;
    });
    const onCreated = vi.fn();

    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [],
      submitRun: vi.fn(() => submitRunPromise),
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const cancel = vi.fn(async () => undefined);
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
      runs: { cancel },
    };

    const controller = new StreamController<State>({
      assistantId: "assistant",
      client: client as never,
      threadId: "thread-1",
      onCreated,
    });
    await controller.hydrationPromise;

    const submitPromise = controller.submit({ messages: [] });
    await waitForExpectation(() => {
      expect(thread.submitRun).toHaveBeenCalled();
    });

    submitRunResolve({ run_id: "run-abc" });
    await waitForExpectation(() => {
      expect(onCreated).toHaveBeenCalledWith({ runId: "run-abc" });
    });

    await controller.disconnect();
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.rootStore.getSnapshot().isLoading).toBe(false);

    await controller.dispose();
    await submitPromise.catch(() => undefined);
  });

  it("respond() removes the targeted interrupt from rootStore", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        {
          interruptId: "int-1",
          payload: { prompt: "Approve?" },
          namespace: [],
        },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["int-1"]);

    await controller.respond({ approved: true });
    expect(respondInput).toHaveBeenCalledWith({
      namespace: [],
      interrupt_id: "int-1",
      response: { approved: true },
    });
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual([]);
    expect(controller.rootStore.getSnapshot().interrupt).toBeUndefined();

    await controller.dispose();
  });

  it("respond() normalizes camelCase HITL edit decisions for Python servers", async () => {
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn(() => vi.fn()),
      close: vi.fn(async () => undefined),
      interrupts: [
        {
          interruptId: "int-hitl",
          payload: { action_requests: [] },
          namespace: [],
        },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    await controller.respond({
      decisions: [
        {
          type: "edit",
          editedAction: {
            name: "send_email",
            args: { to: "team@acme.com" },
          },
        },
      ],
    });

    expect(respondInput).toHaveBeenCalledWith({
      namespace: [],
      interrupt_id: "int-hitl",
      response: {
        decisions: [
          {
            type: "edit",
            editedAction: {
              name: "send_email",
              args: { to: "team@acme.com" },
            },
            edited_action: {
              name: "send_email",
              args: { to: "team@acme.com" },
            },
          },
        ],
      },
    });

    await controller.dispose();
  });

  it("respond() removes only the targeted interrupt when several are pending", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        {
          interruptId: "int-1",
          payload: { prompt: "First?" },
          namespace: [],
        },
        {
          interruptId: "int-2",
          payload: { prompt: "Second?" },
          namespace: [],
        },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    expect(onEvent).toBeDefined();

    onEvent?.(inputRequestedEvent("int-1", { prompt: "First?" }));
    onEvent?.(inputRequestedEvent("int-2", { prompt: "Second?" }));
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["int-1", "int-2"]);

    await controller.respond({ approved: true }, { interruptId: "int-1" });
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual(["int-2"]);
    expect(controller.rootStore.getSnapshot().interrupt?.id).toBe("int-2");

    await controller.dispose();
  });

  it("respondAll() resumes several interrupts at once with distinct payloads", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "First?" }, namespace: [] },
        { interruptId: "int-2", payload: { prompt: "Second?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "First?" }));
    onEvent?.(inputRequestedEvent("int-2", { prompt: "Second?" }));

    await controller.respondAll({
      "int-1": { approved: true },
      "int-2": { approved: false },
    });

    expect(respondInput).toHaveBeenCalledTimes(1);
    expect(respondInput).toHaveBeenCalledWith({
      responses: [
        { interrupt_id: "int-1", response: { approved: true }, namespace: [] },
        { interrupt_id: "int-2", response: { approved: false }, namespace: [] },
      ],
      config: undefined,
      metadata: undefined,
    });
    expect(
      controller.rootStore.getSnapshot().interrupts.map((i) => i.id)
    ).toEqual([]);
    expect(controller.rootStore.getSnapshot().interrupt).toBeUndefined();

    await controller.dispose();
  });

  it("respond() forwards config and metadata to respondInput", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        {
          interruptId: "int-1",
          payload: { prompt: "Approve?" },
          namespace: [],
        },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await controller.respond({ approved: true }, {
      config: { configurable: { model: "gpt-4o" } },
      metadata: { source: "ui" },
    });
    expect(respondInput).toHaveBeenCalledWith({
      namespace: [],
      interrupt_id: "int-1",
      response: { approved: true },
      config: { configurable: { model: "gpt-4o" } },
      metadata: { source: "ui" },
    });

    await controller.dispose();
  });

  it("respond() forwards update and goto on the same input.respond as the resume", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await controller.respond(
      { approved: true },
      {
        update: { messages: [{ type: "ai", content: "Approved." }] },
        goto: "next_node",
      }
    );
    // update / goto ride the SAME input.respond as the resume so the server
    // folds them into one Command(resume, update, goto) — single checkpoint.
    // The update is also applied optimistically (like submit()), so the
    // id-less message is dispatched with a minted id the server echoes back —
    // that's what lets the optimistic copy reconcile in place (no flicker).
    expect(respondInput).toHaveBeenCalledWith({
      namespace: [],
      interrupt_id: "int-1",
      response: { approved: true },
      update: {
        messages: [expect.objectContaining({ type: "ai", content: "Approved." })],
      },
      goto: "next_node",
      config: undefined,
      metadata: undefined,
    });
    const sentUpdate = (
      (respondInput.mock.calls[0] as unknown[])[0] as {
        update: { messages: Array<Record<string, unknown>> };
      }
    ).update;
    expect(typeof sentUpdate.messages[0].id).toBe("string");

    await controller.dispose();
  });

  it("respond() omits update/goto when not provided", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await controller.respond({ approved: true });
    const sent = (respondInput.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty("update");
    expect(sent).not.toHaveProperty("goto");

    await controller.dispose();
  });

  it("respond() serializes BaseMessage instances in update.messages to dicts", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await controller.respond(
      { approved: true },
      { update: { messages: [new AIMessage("Approved by reviewer.")] } }
    );

    // The BaseMessage instance must arrive as a plain `{ type, content }`
    // dict — its default JSON form is the `lc`-constructor envelope the
    // server's `add_messages` reducer would not coerce.
    const sent = (respondInput.mock.calls[0] as unknown[])[0] as {
      update: { messages: Array<Record<string, unknown>> };
    };
    expect(sent.update.messages[0]).toMatchObject({
      type: "ai",
      content: "Approved by reviewer.",
    });
    expect(sent.update.messages[0]).not.toHaveProperty("lc");
    expect(sent.update.messages[0]).not.toHaveProperty("kwargs");

    await controller.dispose();
  });

  it("respond() applies update.messages optimistically before the server echo", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    // The card pushed via `update` must paint immediately — the interrupt is
    // cleared the instant `respond()` dispatches, and the server only echoes
    // the message back a round-trip later. Without the optimistic apply the
    // card would vanish in that gap (the flicker this guards against). The
    // mock `respondInput` never streams a `values` echo, so any message in the
    // projection here came purely from the optimistic apply.
    //
    // The optimistic write commits *synchronously* inside `respond()` (before
    // its first await), so the snapshot already carries the card without
    // draining a macrotask. That synchronous commit is what lets a framework
    // render the card in the *same* commit as any local state the caller flips
    // alongside it (e.g. a HITL form hiding its inputs) — no one-tick blink.
    const pending = controller.respond(
      { approved: true },
      { update: { messages: [{ type: "ai", content: "Pushed card." }] } }
    );

    const messages = controller.rootStore.getSnapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: "Pushed card." });

    await pending;
    // It carries the same minted id that was dispatched, so the server echo
    // reconciles in place instead of appending a duplicate.
    const dispatched = (
      (respondInput.mock.calls[0] as unknown[])[0] as {
        update: { messages: Array<{ id?: string }> };
      }
    ).update.messages[0];
    expect((messages[0] as { id?: string }).id).toBe(dispatched.id);

    await controller.dispose();
  });

  it("respondAll() forwards run-level update and goto for the batched resume", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "First?" }, namespace: [] },
        { interruptId: "int-2", payload: { prompt: "Second?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "First?" }));
    onEvent?.(inputRequestedEvent("int-2", { prompt: "Second?" }));

    await controller.respondAll(
      {
        "int-1": { approved: true },
        "int-2": { approved: false },
      },
      { update: { reviewed: true } }
    );

    expect(respondInput).toHaveBeenCalledWith({
      responses: [
        { interrupt_id: "int-1", response: { approved: true }, namespace: [] },
        { interrupt_id: "int-2", response: { approved: false }, namespace: [] },
      ],
      update: { reviewed: true },
      config: undefined,
      metadata: undefined,
    });

    await controller.dispose();
  });

  it("respond() ignores stale interrupted before resumed run running", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    let releaseRespondInput!: () => void;
    const respondInput = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRespondInput = resolve;
        })
    );
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    const respondPromise = controller.respond({ approved: true });

    // Stale `interrupted` from the run being resumed (can land after
    // input.requested but before respondInput's #prepareForNextRun).
    onEvent?.({
      type: "event",
      event_id: "lifecycle-interrupted-stale",
      seq: 2,
      method: "lifecycle",
      params: {
        namespace: [],
        timestamp: 0,
        data: { event: "interrupted" },
      },
    } as Event);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.rootStore.getSnapshot().error).toBeUndefined();

    releaseRespondInput();
    await respondPromise;

    onEvent?.({
      type: "event",
      event_id: "lifecycle-failed-3",
      seq: 3,
      method: "lifecycle",
      params: {
        namespace: [],
        timestamp: 0,
        data: { event: "failed", error: "missing OPENAI_API_KEY" },
      },
    } as Event);

    await waitForExpectation(() => {
      expect(
        (controller.rootStore.getSnapshot().error as Error | undefined)?.message
      ).toBe("missing OPENAI_API_KEY");
    });

    await controller.dispose();
  });

  it("respond() surfaces a failed resumed run on rootStore.error", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await controller.respond({ approved: true });

    // The resumed run later fails (e.g. a missing model key surfaced after
    // the user approved the interrupt). respond() dispatches the resume
    // directly rather than via submit(), so without the background terminal
    // watch this `failed` lifecycle would only flip isLoading and never
    // populate the reactive rootStore.error slot.
    onEvent?.({
      type: "event",
      event_id: "lifecycle-failed-2",
      seq: 2,
      method: "lifecycle",
      params: {
        namespace: [],
        timestamp: 0,
        data: { event: "failed", error: "missing OPENAI_API_KEY" },
      },
    } as Event);

    await waitForExpectation(() => {
      expect(
        (controller.rootStore.getSnapshot().error as Error | undefined)?.message
      ).toBe("missing OPENAI_API_KEY");
    });

    await controller.dispose();
  });

  it("respond() surfaces an input.respond dispatch failure on rootStore.error", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const dispatchError = new Error("network down");
    const respondInput = vi.fn(async () => {
      throw dispatchError;
    });
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: { prompt: "Approve?" }, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, { prompt: string }>({
      assistantId: "interrupt_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    onEvent?.(inputRequestedEvent("int-1", { prompt: "Approve?" }));

    await expect(controller.respond({ approved: true })).rejects.toThrow(
      "network down"
    );
    expect(controller.rootStore.getSnapshot().error).toBe(dispatchError);

    await controller.dispose();
  });

  it("respondAll() surfaces a failed batched resume on rootStore.error", async () => {
    let onEvent: ((event: Event) => void) | undefined;
    const respondInput = vi.fn(async () => undefined);
    const thread = {
      subscribe: vi.fn(async () => makeNeverEndingSubscription()),
      onEvent: vi.fn((listener: (event: Event) => void) => {
        onEvent = listener;
        return vi.fn();
      }),
      close: vi.fn(async () => undefined),
      interrupts: [
        { interruptId: "int-1", payload: {}, namespace: [] },
        { interruptId: "int-2", payload: {}, namespace: [] },
      ],
      respondInput,
      startLifecycleWatcher: vi.fn(() => undefined),
    } as unknown as ThreadStream;
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        stream: vi.fn(() => thread),
      },
    };

    const controller = new StreamController<State, unknown>({
      assistantId: "human-in-the-loop",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    await controller.respondAll({
      "int-1": { approved: true },
      "int-2": { approved: false },
    });

    onEvent?.({
      type: "event",
      event_id: "lifecycle-failed-2",
      seq: 2,
      method: "lifecycle",
      params: {
        namespace: [],
        timestamp: 0,
        data: { event: "failed", error: "tool authorization rejected" },
      },
    } as Event);

    await waitForExpectation(() => {
      expect(
        (controller.rootStore.getSnapshot().error as Error | undefined)?.message
      ).toBe("tool authorization rejected");
    });

    await controller.dispose();
  });

  // ---------- discovery reconciliation on reconnect ----------

  function discoveryThread() {
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
    return { thread, getOnEvent: () => onEvent };
  }

  function checkpointState(ns: string, id: string) {
    return {
      thread_id: "thread-1",
      checkpoint_ns: ns,
      checkpoint_id: id,
      checkpoint_map: null,
    };
  }

  const taskMessages = [
    {
      type: "ai",
      id: "orchestrator",
      tool_calls: [
        {
          id: "task-1",
          name: "task",
          args: { description: "Do research", subagent_type: "researcher" },
        },
      ],
    },
    { type: "tool", id: "r1", tool_call_id: "task-1", content: "done" },
  ];

  it("hydrate seeds subagentStore from getState messages before any SSE event", async () => {
    const { thread } = discoveryThread();
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: { messages: taskMessages } })),
        getHistory: vi.fn(async () => []),
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    expect(controller.subagentStore.getSnapshot().get("task-1")).toMatchObject({
      name: "researcher",
      namespace: ["tools:task-1"],
      status: "complete",
    });

    await controller.dispose();
  });

  it("hydrate promotes subagent execution namespace from getHistory", async () => {
    const { thread } = discoveryThread();
    const getHistory = vi.fn(async () => [
      {
        values: { messages: taskMessages },
        tasks: [
          {
            id: "exec-1",
            name: "tools",
            path: ["__pregel_push", 0],
            result: { messages: [{ type: "tool", tool_call_id: "task-1" }] },
          },
        ],
        checkpoint: checkpointState("", "cp-1"),
      },
    ]);
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: { messages: taskMessages } })),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    await waitForExpectation(() => {
      expect(
        controller.subagentStore.getSnapshot().get("task-1")?.namespace
      ).toEqual(["tools:exec-1"]);
    });
    expect(getHistory).toHaveBeenCalledTimes(1);

    await controller.dispose();
  });

  it("hydrate seeds subgraphStore from a values-only (single-level) subgraph in getHistory", async () => {
    const { thread } = discoveryThread();
    // The values-only subgraph shape: the host checkpoint namespace appears
    // with NO deeper `research:u1|...` descendant. The old strict-prefix
    // rule dropped these, so the card only reappeared once SSE replay
    // arrived; hydrate must now seed it directly from getHistory.
    const getHistory = vi.fn(async () => [
      {
        values: {},
        tasks: [],
        checkpoint: checkpointState("research:u1", "cp-a"),
      },
    ]);
    const client = {
      threads: {
        getState: vi.fn(async () => ({ values: {}, next: ["agent"] })),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "subgraph_graph",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;
    // Non-blocking: hydration resolves before the history fetch lands.
    expect(controller.subgraphStore.getSnapshot().size).toBe(0);

    await waitForExpectation(() => {
      expect(controller.subgraphStore.getSnapshot().get("research:u1")).toMatchObject(
        { nodeName: "research", status: "complete" }
      );
    });

    await controller.dispose();
  });

  it("resolveSubagentNamespace promotes one subagent and de-dupes concurrent calls", async () => {
    const { thread, getOnEvent } = discoveryThread();
    const getHistory = vi.fn(async () => [
      {
        values: {},
        tasks: [
          {
            id: "exec-9",
            name: "tools",
            path: ["__pregel_push", 0],
            result: { messages: [{ type: "tool", tool_call_id: "task-1" }] },
          },
        ],
        checkpoint: checkpointState("", "cp-1"),
      },
    ]);
    const client = {
      threads: {
        // getState returns null → threadExists false → no hydrate-time
        // history seed, so getHistory calls come only from resolve().
        getState: vi.fn(async () => null),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    // Discover a default-only subagent via the root pump.
    getOnEvent()?.(valuesEvent([taskMessages[0]], 1));
    expect(
      controller.subagentStore.getSnapshot().get("task-1")?.namespace
    ).toEqual(["tools:task-1"]);

    await Promise.all([
      controller.resolveSubagentNamespace("task-1"),
      controller.resolveSubagentNamespace("task-1"),
    ]);

    expect(
      controller.subagentStore.getSnapshot().get("task-1")?.namespace
    ).toEqual(["tools:exec-9"]);
    expect(getHistory).toHaveBeenCalledTimes(1);

    await controller.dispose();
  });

  it("resolveSubagentNamespace skips an already-promoted subagent", async () => {
    const { thread, getOnEvent } = discoveryThread();
    const getHistory = vi.fn(async () => []);
    const client = {
      threads: {
        getState: vi.fn(async () => null),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    getOnEvent()?.(valuesEvent([taskMessages[0]], 1));
    // Promote via an execution-namespace values event (SSE replay).
    getOnEvent()?.({
      type: "event",
      event_id: "values-exec",
      seq: 2,
      method: "values",
      params: {
        namespace: ["tools:exec-existing"],
        timestamp: 0,
        data: { messages: [{ type: "human", content: "Do research" }] },
      },
    } as Event);
    expect(
      controller.subagentStore.getSnapshot().get("task-1")?.namespace
    ).toEqual(["tools:exec-existing"]);

    await controller.resolveSubagentNamespace("task-1");
    expect(getHistory).not.toHaveBeenCalled();

    await controller.dispose();
  });

  it("coalesces concurrent per-card resolves onto the single hydrate seed", async () => {
    const { thread } = discoveryThread();
    // Three subagents spawned in one AI turn → three default-only cards
    // after checkpoint-message seeding.
    const multiTaskMessages = [
      {
        type: "ai",
        id: "orchestrator",
        tool_calls: [
          { id: "task-1", name: "task", args: { subagent_type: "r1" } },
          { id: "task-2", name: "task", args: { subagent_type: "r2" } },
          { id: "task-3", name: "task", args: { subagent_type: "r3" } },
        ],
      },
      { type: "tool", id: "t1", tool_call_id: "task-1", content: "done" },
      { type: "tool", id: "t2", tool_call_id: "task-2", content: "done" },
      { type: "tool", id: "t3", tool_call_id: "task-3", content: "done" },
    ];

    // Gate the seed's getHistory so the per-card resolves run while it is
    // still in flight — the real reconnect race the coalescing fixes.
    let releaseHistory: () => void = () => undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    const getHistory = vi.fn(async () => {
      await historyGate;
      return [
        {
          values: { messages: multiTaskMessages },
          tasks: [
            {
              id: "exec-1",
              name: "tools",
              path: ["__pregel_push", 0],
              result: { messages: [{ type: "tool", tool_call_id: "task-1" }] },
            },
            {
              id: "exec-2",
              name: "tools",
              path: ["__pregel_push", 1],
              result: { messages: [{ type: "tool", tool_call_id: "task-2" }] },
            },
            {
              id: "exec-3",
              name: "tools",
              path: ["__pregel_push", 2],
              result: { messages: [{ type: "tool", tool_call_id: "task-3" }] },
            },
          ],
          checkpoint: checkpointState("", "cp-1"),
        },
      ];
    });
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: { messages: multiTaskMessages },
        })),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    // All three seeded from checkpoint messages, still default-only.
    expect(controller.subagentStore.getSnapshot().size).toBe(3);

    // Cards mount and resolve concurrently WHILE the seed is in flight.
    const resolves = Promise.all([
      controller.resolveSubagentNamespace("task-1"),
      controller.resolveSubagentNamespace("task-2"),
      controller.resolveSubagentNamespace("task-3"),
    ]);
    releaseHistory();
    await resolves;

    // One history read total — the shared seed — not one walk per card.
    expect(getHistory).toHaveBeenCalledTimes(1);
    const snapshot = controller.subagentStore.getSnapshot();
    expect(snapshot.get("task-1")?.namespace).toEqual(["tools:exec-1"]);
    expect(snapshot.get("task-2")?.namespace).toEqual(["tools:exec-2"]);
    expect(snapshot.get("task-3")?.namespace).toEqual(["tools:exec-3"]);

    await controller.dispose();
  });

  it("reuses hydrate discovery history to seed scoped messages when available", async () => {
    const { thread } = discoveryThread();
    const workerMessages = [
      { type: "human", id: "worker-human", content: "Do research" },
      { type: "ai", id: "worker-ai", content: "Research complete" },
    ];
    const getHistory = vi.fn(async () => [
      {
        values: { messages: workerMessages },
        tasks: [],
        checkpoint: checkpointState("tools:exec-1", "cp-worker"),
      },
      {
        values: { messages: taskMessages },
        tasks: [
          {
            id: "exec-1",
            name: "tools",
            path: ["__pregel_push", 0],
            result: { messages: [{ type: "tool", tool_call_id: "task-1" }] },
          },
        ],
        checkpoint: checkpointState("", "cp-root"),
      },
    ]);
    const client = {
      threads: {
        getState: vi.fn(async () => ({
          values: { messages: taskMessages },
          next: [],
          tasks: [],
        })),
        getHistory,
        stream: vi.fn(() => thread),
      },
    };
    const controller = new StreamController<State, unknown>({
      assistantId: "deep_agent",
      client: client as never,
      threadId: "thread-1",
    });
    await controller.hydrationPromise;

    await waitForExpectation(() => {
      expect(controller.subagentStore.getSnapshot().get("task-1")?.namespace).toEqual([
        "tools:exec-1",
      ]);
    });
    expect(getHistory).toHaveBeenCalledTimes(1);

    const acquired = controller.registry.acquire(
      messagesProjection(["tools:exec-1"])
    );
    try {
      await waitForExpectation(() => {
        expect(acquired.store.getSnapshot().map((message) => message.text)).toEqual([
          "Do research",
          "Research complete",
        ]);
      });
      expect(getHistory).toHaveBeenCalledTimes(1);
    } finally {
      acquired.release();
      await controller.dispose();
    }
  });
});
