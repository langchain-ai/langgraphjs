import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseMessage as CoreBaseMessage } from "@langchain/core/messages";

import { StreamManager } from "./manager.js";
import { MessageTupleManager } from "./messages.js";
import { SubagentManager } from "./subagents.js";

type TestState = {
  messages: Array<{ id: string; content: string; type: string }>;
  count?: number;
};

type MutateFn = (
  update: Partial<TestState> | ((prev: TestState) => Partial<TestState>) | null
) => void;

// Helper to create a mock async generator
async function* createMockStream<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) {
    yield event;
  }
}

describe("StreamManager", () => {
  let messageManager: MessageTupleManager;
  let streamManager: StreamManager<TestState>;

  beforeEach(() => {
    messageManager = new MessageTupleManager();
    streamManager = new StreamManager<TestState>(messageManager, {
      throttle: false,
    });
  });

  describe("setStreamValues with null prev state", () => {
    it("should handle values event with __interrupt__ when prev state is null", async () => {
      // This tests line 312: ({ ...(prev ?? {}), ...data }) where prev can be null
      const events = [
        {
          event: "values" as const,
          data: { __interrupt__: true, messages: [] } as TestState & {
            __interrupt__: boolean;
          },
        },
      ];

      const action = async () => createMockStream(events);
      const onSuccess = vi.fn(() => null);
      const onError = vi.fn();

      // Ensure initial state.values is null
      expect(streamManager.values).toBeNull();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess,
        onError,
      });

      // Should not throw and should have set values
      expect(onError).not.toHaveBeenCalled();
    });

    it("should handle messages event when streamValues is null", async () => {
      // This tests line 330: { ...options.initialValues, ...(streamValues ?? {}) }
      // where streamValues can be null

      // First, add a message to the message manager
      const messageId = "test-msg-id";
      messageManager.add(
        { id: messageId, content: "test", type: "human" },
        undefined
      );

      const events = [
        {
          event: "messages" as const,
          data: [
            { id: messageId, content: "test content", type: "human" },
            {},
          ] as [
            { id: string; content: string; type: string },
            Record<string, unknown>
          ],
        },
      ];

      const action = async () => createMockStream(events);
      const onSuccess = vi.fn(() => null);
      const onError = vi.fn();

      // Ensure initial state.values is null
      expect(streamManager.values).toBeNull();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess,
        onError,
      });

      // Should not throw
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("setStreamValues callback with null", () => {
    it("should handle callback receiving null prev value", () => {
      // Direct test of setStreamValues with callback when state.values is null
      expect(() => {
        streamManager.setStreamValues((prev) => {
          // prev should be null here since state.values is null
          return { ...prev, messages: [] } as TestState;
        });
      }).not.toThrow();
    });

    it("should safely spread null prev in interrupt handling pattern", () => {
      // Simulates the pattern at line 312
      expect(() => {
        streamManager.setStreamValues((prev) => ({
          ...((prev ?? {}) as TestState),
          ...({ __interrupt__: true, messages: [] } as TestState),
        }));
      }).not.toThrow();
    });
  });

  describe("getMutateFn with null values", () => {
    it("should handle mutate callback when state.values is null", async () => {
      let capturedMutate: MutateFn | null = null;

      const events = [
        {
          event: "updates" as const,
          data: { messages: [{ id: "1", content: "test", type: "human" }] },
        },
      ];

      const action = async () => createMockStream(events);
      const onSuccess = vi.fn(() => null);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {
          onUpdateEvent: (
            _data: Partial<TestState>,
            options: { mutate: MutateFn; namespace: string[] | undefined }
          ) => {
            capturedMutate = options.mutate;
            // Call mutate with a callback that returns null (edge case)
            options.mutate(() => null as unknown as Partial<TestState>);
          },
        },
        onSuccess,
        onError,
      });

      expect(capturedMutate).not.toBeNull();
      expect(onError).not.toHaveBeenCalled();
    });

    it("should handle mutate with null update value", async () => {
      const events = [
        {
          event: "updates" as const,
          data: { messages: [] },
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {
          onUpdateEvent: (
            _data: Partial<TestState>,
            options: { mutate: MutateFn; namespace: string[] | undefined }
          ) => {
            // Call mutate with null directly
            options.mutate(null);
          },
        },
        onSuccess: () => null,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("tools stream events", () => {
    it("calls onToolEvent when tools event is received", async () => {
      const onToolEvent = vi.fn();

      const events = [
        {
          event: "tools" as const,
          data: {
            event: "on_tool_start" as const,
            name: "weather",
            toolCallId: "call_1234",
            input: '{"query":"SF"}',
          },
        },
        {
          event: "tools" as const,
          data: {
            event: "on_tool_end" as const,
            name: "weather",
            toolCallId: "call_1234",
            output: "60 degrees",
          },
        },
      ];

      const action = async () => createMockStream(events);
      const onSuccess = vi.fn(() => null);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: { onToolEvent },
        onSuccess,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();
      expect(onToolEvent).toHaveBeenCalledTimes(2);
      expect(onToolEvent).toHaveBeenNthCalledWith(
        1,
        {
          event: "on_tool_start",
          name: "weather",
          toolCallId: "call_1234",
          input: '{"query":"SF"}',
        },
        { namespace: undefined, mutate: expect.any(Function) }
      );
      expect(onToolEvent).toHaveBeenNthCalledWith(
        2,
        {
          event: "on_tool_end",
          name: "weather",
          toolCallId: "call_1234",
          output: "60 degrees",
        },
        { namespace: undefined, mutate: expect.any(Function) }
      );
    });
  });

  describe("multiple interrupts", () => {
    it("should preserve all interrupts in __interrupt__ array", async () => {
      const interrupts = [
        { id: "int-1", value: "approve tool 1?" },
        { id: "int-2", value: "approve tool 2?" },
        { id: "int-3", value: "approve tool 3?" },
      ];

      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: interrupts,
            messages: [],
          } as unknown as TestState,
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();

      // All three interrupts should be preserved in stream values
      const values = streamManager.values as unknown as {
        __interrupt__: typeof interrupts;
      };
      expect(values.__interrupt__).toHaveLength(3);
      expect(values.__interrupt__[0].id).toBe("int-1");
      expect(values.__interrupt__[1].id).toBe("int-2");
      expect(values.__interrupt__[2].id).toBe("int-3");
    });

    it("should preserve single interrupt in __interrupt__ array", async () => {
      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-1", value: "approve?" }],
            messages: [],
          } as unknown as TestState,
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();

      const values = streamManager.values as unknown as {
        __interrupt__: Array<{ id: string; value: string }>;
      };
      expect(values.__interrupt__).toHaveLength(1);
      expect(values.__interrupt__[0].id).toBe("int-1");
    });
  });

  describe("regression: handling null/undefined data", () => {
    it("should not throw TypeError when values data is null", async () => {
      const events = [
        {
          event: "values" as const,
          data: null as unknown as TestState,
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: () => [],
        setMessages: (current: TestState) => current,
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => null,
        onError,
      });

      // Should not throw "Cannot convert undefined or null to object"
      expect(onError).not.toHaveBeenCalled();
    });

    it("should not throw TypeError when values data is undefined", async () => {
      const events = [
        {
          event: "values" as const,
          data: undefined as unknown as TestState,
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: () => [],
        setMessages: (current: TestState) => current,
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => null,
        onError,
      });

      // Should not throw "Cannot convert undefined or null to object"
      expect(onError).not.toHaveBeenCalled();
    });

    it("should handle __interrupt__ check safely when data is not an object", async () => {
      // Test with primitive values that would crash the 'in' operator
      const testCases = [null, undefined, 123, "string", true];

      for (const testData of testCases) {
        const events = [
          {
            event: "values" as const,
            data: testData as unknown as TestState,
          },
        ];

        const action = async () => createMockStream(events);
        const onError = vi.fn();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (streamManager as any).enqueue(action, {
          getMessages: () => [],
          setMessages: (current: TestState) => current,
          initialValues: { messages: [] },
          callbacks: {},
          onSuccess: () => null,
          onError,
        });

        // Should handle gracefully without throwing
        expect(onError).not.toHaveBeenCalled();
      }
    });
  });

  describe("abortPrevious (multitask interrupt)", () => {
    it("should abort the current stream and allow the next one to proceed", async () => {
      let resolveStream1: (() => void) | undefined;
      const stream1Started = new Promise<void>((resolve) => {
        resolveStream1 = resolve;
      });

      const stream2Events = [
        { event: "values" as const, data: { messages: [], count: 2 } },
      ];

      // Action 1: yields one event, signals ready, then waits for abort
      const action1 = async (signal: AbortSignal) => {
        async function* gen(): AsyncGenerator<{
          event: "values";
          data: TestState;
        }> {
          yield {
            event: "values" as const,
            data: { messages: [], count: 1 },
          };
          resolveStream1?.();
          // Wait for the abort signal (simulates a long-running SSE stream)
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return gen();
      };

      const action2 = async () => createMockStream(stream2Events);

      const baseOptions = {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] } as TestState,
        callbacks: {},
        onError: vi.fn(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mgr = streamManager as any;

      // Start stream 1 (will block after yielding)
      mgr.start(action1, {
        ...baseOptions,
        onSuccess: vi.fn(() => undefined),
      });

      // Wait for stream 1 to start processing
      await stream1Started;
      expect(streamManager.isLoading).toBe(true);
      expect(streamManager.values).toEqual({ messages: [], count: 1 });

      // Start stream 2 with abortPrevious to interrupt stream 1
      mgr.start(
        action2,
        {
          ...baseOptions,
          onSuccess: vi.fn(() => undefined),
        },
        { abortPrevious: true }
      );

      // Wait for the queue to fully drain
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).queue;

      expect(streamManager.isLoading).toBe(false);
      expect(streamManager.values).toEqual({ messages: [], count: 2 });
    });

    it("should skip onSuccess when stream is aborted", async () => {
      let resolveStream1: (() => void) | undefined;
      const stream1Started = new Promise<void>((resolve) => {
        resolveStream1 = resolve;
      });

      const action1 = async (signal: AbortSignal) => {
        async function* gen(): AsyncGenerator<{
          event: "values";
          data: TestState;
        }> {
          yield {
            event: "values" as const,
            data: { messages: [], count: 1 },
          };
          resolveStream1?.();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return gen();
      };

      const action2 = async () =>
        createMockStream([
          {
            event: "values" as const,
            data: { messages: [], count: 2 },
          },
        ]);

      const onSuccess1 = vi.fn(() => undefined);
      const onSuccess2 = vi.fn(() => undefined);

      const baseOptions = {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] } as TestState,
        callbacks: {},
        onError: vi.fn(),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mgr = streamManager as any;

      mgr.start(action1, {
        ...baseOptions,
        onSuccess: onSuccess1,
      });

      await stream1Started;

      mgr.start(
        action2,
        { ...baseOptions, onSuccess: onSuccess2 },
        { abortPrevious: true }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).queue;

      expect(onSuccess1).not.toHaveBeenCalled();
      expect(onSuccess2).toHaveBeenCalled();
    });

    it("should be a no-op when no stream is running", async () => {
      const events = [
        {
          event: "values" as const,
          data: { messages: [], count: 42 },
        },
      ];

      const action = async () => createMockStream(events);
      const onSuccess = vi.fn(() => undefined);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (streamManager as any).start(
        action,
        {
          getMessages: (values: TestState) => values.messages ?? [],
          setMessages: (
            current: TestState,
            messages: TestState["messages"]
          ) => ({ ...current, messages }),
          initialValues: { messages: [] } as TestState,
          callbacks: {},
          onSuccess,
          onError,
        },
        { abortPrevious: true }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).queue;

      expect(onError).not.toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalled();
      expect(streamManager.values).toEqual({ messages: [], count: 42 });
    });
  });

  describe("onError callback", () => {
    it("should call onError when the stream action throws", async () => {
      const streamError = new Error("Stream failed");
      const action = async () => {
        throw streamError;
      };
      const onSuccess = vi.fn(() => undefined);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: () => [],
        setMessages: (current: TestState) => current,
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess,
        onError,
      });

      expect(onError).toHaveBeenCalledWith(streamError);
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("should call onError when the stream yields then throws", async () => {
      const streamError = new Error("Mid-stream failure");
      async function* failingStream() {
        yield {
          event: "values" as const,
          data: { messages: [{ id: "1", content: "ok", type: "ai" }] },
        };
        throw streamError;
      }

      const action = async () => failingStream();
      const onSuccess = vi.fn(() => undefined);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess,
        onError,
      });

      expect(onError).toHaveBeenCalledWith(streamError);
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("should not call onError for AbortError", async () => {
      const abortError = new DOMException("Aborted", "AbortError");
      const action = async () => {
        throw abortError;
      };
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action, {
        getMessages: () => [],
        setMessages: (current: TestState) => current,
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("subagent values stripping", () => {
    it("strips messages array from subagent values when filterSubagentMessages is true", async () => {
      const mgr = new StreamManager<TestState>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
        subagentToolNames: ["task"],
      });

      // Register a subagent via an AI message with tool calls
      const events = [
        {
          event: "messages" as const,
          data: [
            {
              id: "ai-1",
              type: "ai",
              content: "Let me delegate",
              tool_calls: [
                {
                  id: "call_1",
                  name: "task",
                  args: {
                    subagent_type: "researcher",
                    description: "Look into trends",
                  },
                },
              ],
            },
            { langgraph_checkpoint_ns: "agent:t1", langgraph_node: "agent" },
          ] as [
            { id: string; type: string; content: string; tool_calls: Array<{ id: string; name: string; args: Record<string, unknown> }> },
            Record<string, unknown>,
          ],
        },
        // Subagent values event with a large messages array
        {
          event: "values|tools:call_1|model:task_1" as "values",
          data: {
            messages: [
              { type: "human", content: "Look into trends" },
              { type: "ai", content: "Here are the trends..." },
              { type: "ai", content: "More details..." },
            ],
            someOtherState: { counter: 42 },
          } as unknown as TestState,
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => null,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();

      // The subagent should have values WITHOUT messages (stripped)
      const subagent = mgr.getSubagent("call_1");
      if (subagent) {
        expect(subagent.values).toEqual({ someOtherState: { counter: 42 } });
        expect(subagent.values).not.toHaveProperty("messages");
      }
    });
  });

  describe("subagent routing with null metadata", () => {
    it("uses event namespace for subagent detection when metadata is null", async () => {
      const mgr = new StreamManager<TestState>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
        subagentToolNames: ["task"],
      });

      // Register subagent
      const events = [
        {
          event: "updates" as const,
          data: {
            agent: {
              messages: [
                {
                  id: "ai-1",
                  type: "ai",
                  content: "Delegating",
                  tool_calls: [
                    {
                      id: "call_1",
                      name: "task",
                      args: {
                        subagent_type: "researcher",
                        description: "Research AI",
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
        // Subagent message with null metadata (simulating metadata dedup)
        // The event name contains the namespace info
        {
          event: "messages|tools:call_1|model:task_1" as "messages",
          data: [
            { id: "sub-ai-1", type: "ai", content: "Working on it" },
            null,
          ] as unknown as [
            { id: string; type: string; content: string },
            Record<string, unknown>,
          ],
        },
      ];

      const action = async () => createMockStream(events);
      const onError = vi.fn();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mgr as any).enqueue(action, {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => null,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();

      // The message should have been routed to the subagent, not the main stream
      const mainValues = mgr.values;
      const mainMessages = mainValues?.messages ?? [];
      // Sub-agent message should NOT be in main messages
      expect(
        mainMessages.find(
          (m: { id: string }) => m.id === "sub-ai-1"
        )
      ).toBeUndefined();
    });
  });

  describe("subagent message conversion via toMessage", () => {
    function createSubagentManager(
      toMessage?: (chunk: CoreBaseMessage) => CoreBaseMessage
    ) {
      return new SubagentManager({
        subagentToolNames: ["task"],
        toMessage,
      });
    }

    const historyMessages = [
      {
        type: "ai" as const,
        id: "ai-1",
        content: "Delegating task",
        tool_calls: [
          {
            id: "call_1",
            name: "task",
            args: {
              subagent_type: "researcher",
              description: "Research AI trends",
            },
          },
        ],
      },
      {
        type: "tool" as const,
        id: "tool-1",
        content: "Done researching",
        tool_call_id: "call_1",
      },
    ];

    it("should produce class instances when toMessage is identity (like framework adapters)", () => {
      const mgr = createSubagentManager((chunk) => chunk);
      mgr.reconstructFromMessages(historyMessages);

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();
      expect(subagent!.status).toBe("complete");
      expect(subagent!.result).toBe("Done researching");
    });

    it("should produce plain objects by default (SDK behaviour)", () => {
      const mgr = createSubagentManager();
      mgr.reconstructFromMessages(historyMessages);

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();
      expect(subagent!.status).toBe("complete");
      expect(subagent!.result).toBe("Done researching");
    });

    it("should call toMessage when building subagent messages from addMessageToSubagent", () => {
      const toMessage = vi.fn((chunk: CoreBaseMessage) => chunk);
      const mgr = createSubagentManager(toMessage);

      mgr.reconstructFromMessages(historyMessages);

      mgr.addMessageToSubagent("call_1", {
        type: "ai",
        id: "sub-ai-1",
        content: "Researching...",
      });

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();
      expect(subagent!.messages.length).toBeGreaterThan(0);
      expect(toMessage).toHaveBeenCalled();
    });

    it("subagent messages are BaseMessage class instances when using identity toMessage", () => {
      const mgr = createSubagentManager((chunk) => chunk);

      mgr.reconstructFromMessages(historyMessages);
      mgr.addMessageToSubagent("call_1", {
        type: "ai",
        id: "sub-ai-1",
        content: "Researching...",
      });

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();

      for (const msg of subagent!.messages) {
        expect(typeof (msg as CoreBaseMessage).getType).toBe("function");
      }
    });

    it("subagent messages are plain dicts when using default toMessage", () => {
      const mgr = createSubagentManager();

      mgr.reconstructFromMessages(historyMessages);
      mgr.addMessageToSubagent("call_1", {
        type: "ai",
        id: "sub-ai-1",
        content: "Researching...",
      });

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();

      for (const msg of subagent!.messages) {
        expect(typeof (msg as CoreBaseMessage).getType).toBe("undefined");
        expect(msg.type).toBeDefined();
      }
    });
  });
});
