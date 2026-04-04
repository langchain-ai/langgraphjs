import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  StreamOrchestrator,
  type OrchestratorAccessors,
} from "./orchestrator.js";
import type { AnyStreamOptions } from "./types.js";
import type { Client } from "../client.js";
import type { HeadlessToolImplementation } from "../headless-tools.js";

type TestState = {
  messages: Array<{ id: string; content: string; type: string }>;
  count?: number;
};

function createMockClient(overrides?: Partial<Client>): Client {
  return {
    threads: {
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        checkpoint: {
          thread_id: "t1",
          checkpoint_id: "cp1",
          checkpoint_ns: "",
          checkpoint_map: null,
        },
        next: [],
        tasks: [],
        metadata: undefined,
        created_at: null,
        parent_checkpoint: null,
      }),
      getHistory: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ thread_id: "new-thread-1" }),
    },
    runs: {
      stream: vi.fn(),
      joinStream: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({
        run_id: "run-1",
        created_at: new Date().toISOString(),
      }),
    },
    ...overrides,
  } as unknown as Client;
}

function createAccessors(client: Client): OrchestratorAccessors {
  return {
    getClient: () => client,
    getAssistantId: () => "test-assistant",
    getMessagesKey: () => "messages",
  };
}

function createOptions(
  overrides?: Partial<AnyStreamOptions<TestState>>
): AnyStreamOptions<TestState> {
  return {
    assistantId: "test-assistant",
    ...overrides,
  } as AnyStreamOptions<TestState>;
}

describe("StreamOrchestrator", () => {
  let client: Client;
  let accessors: OrchestratorAccessors;

  beforeEach(() => {
    client = createMockClient();
    accessors = createAccessors(client);
  });

  describe("construction", () => {
    it("initialises with default state", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.threadId).toBeUndefined();
      expect(orch.isLoading).toBe(false);
      expect(orch.values).toEqual({});
      expect(orch.error).toBeUndefined();
      expect(orch.branch).toBe("");
      expect(orch.queueSize).toBe(0);
      expect(orch.queueEntries).toHaveLength(0);
      expect(orch.isThreadLoading).toBe(false);

      orch.dispose();
    });

    it("respects initialValues option", () => {
      const initial: TestState = {
        messages: [{ id: "1", content: "hi", type: "human" }],
      };
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ initialValues: initial }),
        accessors
      );

      expect(orch.values).toEqual(initial);
      expect(orch.messages).toHaveLength(1);

      orch.dispose();
    });

    it("computes historyLimit from fetchStateHistory", () => {
      const orchFalse = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: false }),
        accessors
      );
      expect(orchFalse.historyLimit).toBe(false);
      orchFalse.dispose();

      const orchTrue = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );
      expect(orchTrue.historyLimit).toBe(true);
      orchTrue.dispose();

      const orchObj = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: { limit: 5 } }),
        accessors
      );
      expect(orchObj.historyLimit).toBe(5);
      orchObj.dispose();
    });
  });

  describe("subscription", () => {
    it("notifies listeners on state changes", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      const listener = vi.fn();

      orch.subscribe(listener);
      orch.setBranch("b1");

      expect(listener).toHaveBeenCalled();

      orch.dispose();
    });

    it("returns unsubscribe function", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      const listener = vi.fn();

      const unsub = orch.subscribe(listener);
      listener.mockClear();

      unsub();
      orch.setBranch("b2");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("getSnapshot increments on changes", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      const v0 = orch.getSnapshot();
      orch.setBranch("b1");
      const v1 = orch.getSnapshot();

      expect(v1).toBeGreaterThan(v0);

      orch.dispose();
    });
  });

  describe("thread ID management", () => {
    it("setThreadId updates threadId and triggers history fetch", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );

      const listener = vi.fn();
      orch.subscribe(listener);

      orch.setThreadId("thread-123");

      expect(orch.threadId).toBe("thread-123");
      expect(listener).toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(client.threads.getHistory).toHaveBeenCalledWith("thread-123", {
          limit: 10,
        });
      });

      orch.dispose();
    });

    it("setThreadId to same value is a no-op", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      orch.setThreadId("t1");
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.setThreadId("t1");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("setThreadId to undefined clears history", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.setThreadId("t1");

      orch.setThreadId(undefined);

      expect(orch.threadId).toBeUndefined();
      expect(orch.historyData.data).toBeUndefined();

      orch.dispose();
    });

    it("initThreadId fetches history for the given thread", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );

      orch.initThreadId("init-thread");

      expect(orch.threadId).toBe("init-thread");

      await vi.waitFor(() => {
        expect(client.threads.getHistory).toHaveBeenCalledWith("init-thread", {
          limit: 10,
        });
      });

      orch.dispose();
    });

    it("initThreadId with undefined does not fetch", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      orch.initThreadId(undefined);

      expect(orch.threadId).toBeUndefined();
      expect(client.threads.getHistory).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("history management", () => {
    it("fetches history and updates historyData on success", async () => {
      const historyEntries = [
        {
          values: { messages: [{ id: "m1", content: "hello", type: "human" }] },
          checkpoint: {
            thread_id: "t1",
            checkpoint_id: "cp1",
            checkpoint_ns: "",
            checkpoint_map: null,
          },
          next: [],
          tasks: [],
          metadata: undefined,
          created_at: null,
          parent_checkpoint: null,
        },
      ];
      (client.threads.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(
        historyEntries
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );

      orch.initThreadId("t1");

      await vi.waitFor(() => {
        expect(orch.historyData.data).toEqual(historyEntries);
        expect(orch.historyData.isLoading).toBe(false);
        expect(orch.historyData.error).toBeUndefined();
      });

      expect(orch.values.messages).toHaveLength(1);
      expect(orch.values.messages[0].content).toBe("hello");

      orch.dispose();
    });

    it("handles history fetch error", async () => {
      const error = new Error("Network error");
      (client.threads.getHistory as ReturnType<typeof vi.fn>).mockRejectedValue(
        error
      );
      const onError = vi.fn();

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ onError, fetchStateHistory: true }),
        accessors
      );

      orch.initThreadId("t-err");

      await vi.waitFor(() => {
        expect(orch.historyData.error).toBe(error);
        expect(orch.historyData.isLoading).toBe(false);
      });

      expect(onError).toHaveBeenCalledWith(error, undefined);

      orch.dispose();
    });

    it("uses getState when historyLimit is false", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: false }),
        accessors
      );

      orch.initThreadId("t1");

      await vi.waitFor(() => {
        expect(client.threads.getState).toHaveBeenCalledWith("t1");
      });
      expect(client.threads.getHistory).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("isThreadLoading is true while loading with no data", () => {
      (client.threads.getHistory as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise(() => {})
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );

      orch.initThreadId("t1");

      expect(orch.isThreadLoading).toBe(true);

      orch.dispose();
    });
  });

  describe("branch management", () => {
    it("setBranch updates branch and notifies", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.setBranch("branch-1");

      expect(orch.branch).toBe("branch-1");
      expect(listener).toHaveBeenCalled();

      orch.dispose();
    });

    it("setBranch with same value is a no-op", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      orch.setBranch("x");
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.setBranch("x");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("computed values", () => {
    it("error falls through history error chain", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.error).toBeUndefined();

      orch.dispose();
    });

    it("interrupts returns empty when loading", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.interrupts).toEqual([]);

      orch.dispose();
    });

    it("flatHistory throws when fetchStateHistory is false", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: false }),
        accessors
      );

      expect(() => orch.flatHistory).toThrow(
        "`fetchStateHistory` must be set to `true` to use `history`"
      );

      orch.dispose();
    });

    it("experimental_branchTree throws when fetchStateHistory is false", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: false }),
        accessors
      );

      expect(() => orch.experimental_branchTree).toThrow(
        "`fetchStateHistory` must be set to `true` to use `experimental_branchTree`"
      );

      orch.dispose();
    });

    it("messages returns messages from values using accessor key", () => {
      const customAccessors: OrchestratorAccessors = {
        ...accessors,
        getMessagesKey: () => "chat",
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const orch = new StreamOrchestrator<any>(
        {
          assistantId: "test",
          initialValues: { chat: [{ id: "1", content: "yo", type: "human" }] },
        } as any,
        customAccessors
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(orch.messages).toHaveLength(1);

      orch.dispose();
    });

    it("filters headless tool interrupts from user-facing accessors", async () => {
      const toolImpl: HeadlessToolImplementation<{ city: string }, string> = {
        tool: { name: "get_weather" },
        execute: vi.fn().mockResolvedValue("sunny"),
      };
      const streamValues = {
        __interrupt__: [
          {
            id: "tool-int",
            value: {
              type: "tool",
              toolCall: {
                id: "call-1",
                name: "get_weather",
                args: { city: "SF" },
              },
            },
          },
        ],
        messages: [],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { event: "values" as const, data: streamValues };
        },
      };
      (client.runs.stream as ReturnType<typeof vi.fn>).mockReturnValue(mockStream);

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ tools: [toolImpl] }),
        accessors
      );

      await orch.submit({ messages: [] });

      expect(orch.interrupts).toEqual([]);
      expect(orch.interrupt).toBeUndefined();
      expect(toolImpl.execute).toHaveBeenCalledWith({ city: "SF" });
      expect(client.runs.stream).toHaveBeenCalledTimes(2);

      orch.dispose();
    });
  });

  describe("queue management", () => {
    it("cancelQueueItem removes entry and cancels on server", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      orch.pendingRuns.add({
        id: "run-1",
        values: { messages: [] },
        createdAt: new Date(),
      });

      expect(orch.queueSize).toBe(1);

      const removed = await orch.cancelQueueItem("run-1");

      expect(removed).toBe(true);
      expect(orch.queueSize).toBe(0);
      expect(client.runs.cancel).toHaveBeenCalledWith("t1", "run-1");

      orch.dispose();
    });

    it("cancelQueueItem returns false for unknown id", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      const removed = await orch.cancelQueueItem("nonexistent");

      expect(removed).toBe(false);
      expect(client.runs.cancel).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("clearQueue removes all entries and cancels on server", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      orch.pendingRuns.add({ id: "r1", values: null, createdAt: new Date() });
      orch.pendingRuns.add({ id: "r2", values: null, createdAt: new Date() });

      expect(orch.queueSize).toBe(2);

      await orch.clearQueue();

      expect(orch.queueSize).toBe(0);
      expect(client.runs.cancel).toHaveBeenCalledTimes(2);

      orch.dispose();
    });
  });

  describe("switchThread", () => {
    it("updates threadId and clears stream", () => {
      const onThreadId = vi.fn();
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ onThreadId }),
        accessors
      );
      orch.initThreadId("t1");

      const clearSpy = vi.spyOn(orch.stream, "clear");

      orch.switchThread("t2");

      expect(orch.threadId).toBe("t2");
      expect(clearSpy).toHaveBeenCalled();
      expect(onThreadId).toHaveBeenCalledWith("t2");

      orch.dispose();
    });

    it("switchThread to null resets threadId", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      orch.switchThread(null);

      expect(orch.threadId).toBeUndefined();

      orch.dispose();
    });

    it("switchThread to same value is a no-op", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");
      const listener = vi.fn();
      orch.subscribe(listener);
      listener.mockClear();

      orch.switchThread("t1");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("switchThread cancels pending queue entries", async () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      orch.pendingRuns.add({ id: "r1", values: null, createdAt: new Date() });
      orch.pendingRuns.add({ id: "r2", values: null, createdAt: new Date() });

      orch.switchThread("t2");

      expect(orch.queueSize).toBe(0);

      await vi.waitFor(() => {
        expect(client.runs.cancel).toHaveBeenCalledTimes(2);
      });

      orch.dispose();
    });
  });

  describe("stop", () => {
    it("calls stream.stop", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      const stopSpy = vi
        .spyOn(orch.stream, "stop")
        .mockResolvedValue(undefined);

      orch.stop();

      expect(stopSpy).toHaveBeenCalled();

      orch.dispose();
    });

    it("invokes onStop callback", () => {
      const onStop = vi.fn();
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ onStop }),
        accessors
      );

      vi.spyOn(orch.stream, "stop").mockImplementation(
        async (_values, opts) => {
          opts?.onStop?.({ mutate: vi.fn() });
        }
      );

      orch.stop();

      expect(onStop).toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("auto-reconnect", () => {
    it("shouldReconnect is false without reconnectOnMount", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.shouldReconnect).toBe(false);

      orch.dispose();
    });

    it("tryReconnect returns false when no storage", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.tryReconnect()).toBe(false);

      orch.dispose();
    });
  });

  describe("stream mode tracking", () => {
    it("trackStreamMode adds unique modes", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      orch.trackStreamMode("messages-tuple");
      orch.trackStreamMode("messages-tuple");
      orch.trackStreamMode("values");

      // No public accessor for trackedStreamModes, but we verify
      // it doesn't throw and toolCalls accessor adds modes
      expect(orch.toolCalls).toBeDefined();

      orch.dispose();
    });
  });

  describe("dispose", () => {
    it("stops notifications after dispose", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      const listener = vi.fn();
      orch.subscribe(listener);
      listener.mockClear();

      orch.dispose();

      // Modifying state after dispose should not notify
      orch.setBranch("new-branch");
      // setBranch checks equality first, but the notify inside won't fire
      // because dispose sets #disposed = true
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("subagents", () => {
    it("returns empty subagents initially", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.subagents.size).toBe(0);
      expect(orch.activeSubagents).toHaveLength(0);

      orch.dispose();
    });

    it("getSubagent returns undefined for unknown id", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.getSubagent("unknown")).toBeUndefined();

      orch.dispose();
    });

    it("getSubagentsByType returns empty array", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.getSubagentsByType("researcher")).toEqual([]);

      orch.dispose();
    });

    it("getSubagentsByMessage returns empty array", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.getSubagentsByMessage("msg-1")).toEqual([]);

      orch.dispose();
    });

    it("reconstructSubagentsIfNeeded returns null when conditions not met", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      expect(orch.reconstructSubagentsIfNeeded()).toBeNull();

      orch.dispose();
    });
  });

  describe("getMessagesMetadata", () => {
    it("returns undefined when no metadata available", () => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );

      /* eslint-disable @typescript-eslint/no-explicit-any */
      const result = orch.getMessagesMetadata({
        id: "msg-1",
        type: "human",
        content: "hi",
      } as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(result).toBeUndefined();

      orch.dispose();
    });
  });
});
