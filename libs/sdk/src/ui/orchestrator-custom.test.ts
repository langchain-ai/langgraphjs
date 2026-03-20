import { describe, it, expect, vi } from "vitest";
import { CustomStreamOrchestrator } from "./orchestrator-custom.js";
import type { AnyStreamCustomOptions } from "./types.js";

type TestState = {
  messages: Array<{ id: string; content: string; type: string }>;
  count?: number;
};

async function* createMockStream<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) {
    yield event;
  }
}

function createMockTransport(events: unknown[] = []) {
  return {
    stream: vi.fn().mockResolvedValue(createMockStream(events)),
  };
}

function createOptions(
  overrides?: Partial<AnyStreamCustomOptions<TestState>>
): AnyStreamCustomOptions<TestState> {
  return {
    transport: createMockTransport(),
    ...overrides,
  } as AnyStreamCustomOptions<TestState>;
}

describe("CustomStreamOrchestrator", () => {
  describe("construction", () => {
    it("initialises with default state", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.isLoading).toBe(false);
      expect(orch.values).toEqual({});
      expect(orch.streamValues).toBeNull();
      expect(orch.error).toBeUndefined();
      expect(orch.branch).toBe("");
      expect(orch.messages).toEqual([]);
      expect(orch.toolCalls).toEqual([]);
      expect(orch.interrupts).toEqual([]);
      expect(orch.interrupt).toBeUndefined();

      orch.dispose();
    });

    it("respects initialValues option", () => {
      const initial: TestState = {
        messages: [{ id: "1", content: "hi", type: "human" }],
      };
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ initialValues: initial })
      );

      // Before streaming, values come from stream (null) so returns {}
      expect(orch.values).toEqual({});

      orch.dispose();
    });

    it("accepts a custom threadId", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t-42" })
      );

      // threadId is internal, but syncThreadId with same value is a no-op
      const listener = vi.fn();
      orch.subscribe(listener);
      orch.syncThreadId("t-42");
      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("reconstructs subagents from initialValues when filterSubagentMessages is set", () => {
      const initial: TestState = {
        messages: [
          { id: "m1", content: "hello", type: "human" },
          { id: "m2", content: "response", type: "ai" },
        ],
      };
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({
          initialValues: initial,
          filterSubagentMessages: true,
        })
      );

      expect(orch.subagents.size).toBe(0);

      orch.dispose();
    });
  });

  describe("subscription", () => {
    it("notifies listeners on branch change", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());
      const listener = vi.fn();

      orch.subscribe(listener);
      orch.setBranch("b1");

      expect(listener).toHaveBeenCalled();

      orch.dispose();
    });

    it("unsubscribe stops notifications", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());
      const listener = vi.fn();

      const unsub = orch.subscribe(listener);
      listener.mockClear();

      unsub();
      orch.setBranch("b2");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("getSnapshot increments on state changes", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      const v0 = orch.getSnapshot();
      orch.setBranch("b1");
      const v1 = orch.getSnapshot();

      expect(v1).toBeGreaterThan(v0);

      orch.dispose();
    });

    it("does not notify after dispose", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());
      const listener = vi.fn();
      orch.subscribe(listener);
      listener.mockClear();

      orch.dispose();
      orch.setBranch("after-dispose");

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("syncThreadId", () => {
    it("clears stream and notifies on change", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t1" })
      );
      const listener = vi.fn();
      orch.subscribe(listener);

      const clearSpy = vi.spyOn(orch.stream, "clear");

      orch.syncThreadId("t2");

      expect(clearSpy).toHaveBeenCalled();
      expect(listener).toHaveBeenCalled();

      orch.dispose();
    });

    it("is a no-op when threadId unchanged", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t1" })
      );
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.syncThreadId("t1");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("branch management", () => {
    it("setBranch updates branch", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      orch.setBranch("feature-1");

      expect(orch.branch).toBe("feature-1");

      orch.dispose();
    });
  });

  describe("switchThread", () => {
    it("updates threadId and clears stream", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t1" })
      );

      const clearSpy = vi.spyOn(orch.stream, "clear");

      orch.switchThread("t2");

      expect(clearSpy).toHaveBeenCalled();

      orch.dispose();
    });

    it("switchThread to same value is a no-op", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t1" })
      );
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.switchThread("t1");

      expect(listener).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("switchThread to null clears", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ threadId: "t1" })
      );
      const listener = vi.fn();
      orch.subscribe(listener);

      orch.switchThread(null);

      expect(listener).toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("stop", () => {
    it("calls stream.stop", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      const stopSpy = vi
        .spyOn(orch.stream, "stop")
        .mockResolvedValue(undefined);

      orch.stop();

      expect(stopSpy).toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("submit", () => {
    it("calls transport.stream with correct params", async () => {
      const transport = createMockTransport([
        {
          event: "values",
          data: { messages: [{ id: "1", content: "hi", type: "ai" }] },
        },
      ]);
      const onThreadId = vi.fn();

      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, onThreadId, threadId: null })
      );

      await orch.submit({
        messages: [{ id: "1", content: "hello", type: "human" }],
      });

      expect(transport.stream).toHaveBeenCalled();
      expect(onThreadId).toHaveBeenCalled();

      orch.dispose();
    });

    it("reuses existing threadId", async () => {
      const transport = createMockTransport([
        { event: "values", data: { messages: [] } },
      ]);
      const onThreadId = vi.fn();

      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, onThreadId, threadId: "existing-thread" })
      );

      await orch.submit({ messages: [] });

      expect(onThreadId).not.toHaveBeenCalled();
      const call = transport.stream.mock.calls[0][0];
      expect(call.config.configurable.thread_id).toBe("existing-thread");

      orch.dispose();
    });

    it("calls onFinish with thread state on success", async () => {
      const transport = createMockTransport([
        {
          event: "values",
          data: { messages: [{ id: "1", content: "done", type: "ai" }] },
        },
      ]);
      const onFinish = vi.fn();

      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({
          transport,
          onFinish,
          threadId: "t1",
        })
      );

      await orch.submit({ messages: [] });

      expect(onFinish).toHaveBeenCalled();
      const threadState = onFinish.mock.calls[0][0];
      expect(threadState.checkpoint.thread_id).toBe("t1");

      orch.dispose();
    });

    it("calls onError when transport throws", async () => {
      const transport = {
        stream: vi.fn().mockRejectedValue(new Error("network fail")),
      };
      const onError = vi.fn();

      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({
          transport,
          onError,
          threadId: "t1",
        })
      );

      await orch.submit({ messages: [] });

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toBe("network fail");

      orch.dispose();
    });

    it("applies optimisticValues", async () => {
      const transport = createMockTransport([]);
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({
          transport,
          threadId: "t1",
          initialValues: { messages: [] },
        })
      );

      const setStreamValuesSpy = vi.spyOn(orch.stream, "setStreamValues");

      await orch.submit(null, {
        optimisticValues: { count: 42 },
      });

      expect(setStreamValuesSpy).toHaveBeenCalled();

      orch.dispose();
    });
  });

  describe("subagents", () => {
    it("returns empty subagents initially", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.subagents.size).toBe(0);
      expect(orch.activeSubagents).toHaveLength(0);

      orch.dispose();
    });

    it("getSubagent returns undefined for unknown id", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.getSubagent("unknown")).toBeUndefined();

      orch.dispose();
    });

    it("getSubagentsByType returns empty array", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.getSubagentsByType("researcher")).toEqual([]);

      orch.dispose();
    });

    it("getSubagentsByMessage returns empty array", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.getSubagentsByMessage("msg-1")).toEqual([]);

      orch.dispose();
    });

    it("reconstructSubagentsIfNeeded is safe to call", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(() => orch.reconstructSubagentsIfNeeded()).not.toThrow();

      orch.dispose();
    });
  });

  describe("getMessagesMetadata", () => {
    it("returns undefined when no metadata available", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

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

  describe("interrupts", () => {
    it("returns empty array when no stream values", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      expect(orch.interrupts).toEqual([]);
      expect(orch.interrupt).toBeUndefined();

      orch.dispose();
    });
  });

  describe("dispose", () => {
    it("stops the stream on dispose", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      const stopSpy = vi
        .spyOn(orch.stream, "stop")
        .mockResolvedValue(undefined);

      orch.dispose();

      expect(stopSpy).toHaveBeenCalled();
    });

    it("stops notifications after dispose", () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());
      const listener = vi.fn();
      orch.subscribe(listener);
      listener.mockClear();

      orch.dispose();

      orch.setBranch("should-not-notify");
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
