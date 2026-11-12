import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseMessage as CoreBaseMessage } from "@langchain/core/messages";

import { StreamManager } from "./manager.js";
import { MessageTupleManager } from "./messages.js";
import { SubagentManager } from "./subagents.js";
import type { Message } from "../types.messages.js";

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

  describe("messages the loaded state already holds", () => {
    it("updates a resent message in place instead of appending a copy", async () => {
      const events = [
        {
          event: "messages" as const,
          data: [{ id: "ai-a", type: "ai", content: "sunny" }, {}],
        },
        {
          event: "messages" as const,
          data: [{ id: "ai-b", type: "ai", content: "no news" }, {}],
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(async () => createMockStream(events), {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: {
          messages: [
            { id: "human-1", type: "human", content: "weather and news?" },
            { id: "ai-a", type: "ai", content: "sunny" },
          ],
        },
        callbacks: {},
        onSuccess: () => undefined,
        onError: vi.fn(),
      });

      expect(streamManager.values?.messages.map((m) => m.id)).toEqual([
        "human-1",
        "ai-a",
        "ai-b",
      ]);
    });

    it("updates a streamed message where a values event moved it", async () => {
      const events = [
        {
          event: "messages" as const,
          data: [{ id: "ai-a", type: "ai", content: "sun" }, {}],
        },
        {
          event: "values" as const,
          data: {
            messages: [
              { id: "ai-a", type: "ai", content: "sun" },
              { id: "human-1", type: "human", content: "weather?" },
            ],
          },
        },
        {
          event: "messages" as const,
          data: [{ id: "ai-a", type: "ai", content: "ny" }, {}],
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(async () => createMockStream(events), {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: {
          messages: [{ id: "human-1", type: "human", content: "weather?" }],
        },
        callbacks: {},
        onSuccess: () => undefined,
        onError: vi.fn(),
      });

      expect(
        streamManager.values?.messages.map((m) => [m.id, m.content])
      ).toEqual([
        ["ai-a", "sunny"],
        ["human-1", "weather?"],
      ]);
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

  describe("subagent message namespace routing", () => {
    it("prefers the stream event namespace over checkpoint metadata", async () => {
      const manager = new StreamManager<TestState>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
        subagentToolNames: ["task"],
      });
      const onError = vi.fn();

      const events = [
        {
          event: "messages" as const,
          data: [
            {
              id: "ai-1",
              type: "ai",
              content: "",
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
            {},
          ],
        },
        {
          event: "values|tools:stream-task-id" as const,
          data: {
            messages: [
              {
                id: "sub-human-1",
                type: "human",
                content: "Research AI trends",
              },
            ],
          },
        },
        {
          event: "messages|tools:stream-task-id" as const,
          data: [
            {
              id: "sub-ai-1",
              type: "ai",
              content: "",
              tool_calls: [
                {
                  id: "search-1",
                  name: "search_web",
                  args: { query: "AI trends" },
                },
              ],
            },
            { checkpoint_ns: "tools:metadata-task-id" },
          ],
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).enqueue(async () => createMockStream(events), {
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
      expect(manager.values?.messages).toHaveLength(1);
      expect(manager.values?.messages[0]?.id).toBe("ai-1");

      const subagent = manager.getSubagentsByMessage("ai-1")[0];
      expect(subagent).toBeDefined();
      expect(subagent?.messages).toHaveLength(1);
      expect(subagent?.toolCalls).toHaveLength(1);
      expect(subagent?.toolCalls[0]?.call.name).toBe("search_web");
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

    it("an unknown tool event kind never reaches onToolEvent", async () => {
      const onToolEvent = vi.fn();
      const onError = vi.fn();
      const events = [
        {
          event: "tools" as const,
          data: { event: "tool-started", tool_call_id: "call_1" },
        },
        { event: "tools" as const, data: null },
        {
          event: "tools" as const,
          data: { event: "on_tool_start", name: "weather", input: {} },
        },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(async () => createMockStream(events), {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: { onToolEvent },
        onSuccess: () => null,
        onError,
      });

      expect(onError).not.toHaveBeenCalled();
      expect(onToolEvent).toHaveBeenCalledTimes(1);
      expect(onToolEvent.mock.calls[0][0]).toMatchObject({
        event: "on_tool_start",
      });
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

  describe("parallel interrupt accumulation", () => {
    it("should accumulate interrupts from separate values events", async () => {
      // Simulates parallel branches each raising an interrupt in separate
      // values events during a single stream.
      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve A?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-B", value: "approve B?" }],
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
      expect(values.__interrupt__).toHaveLength(2);
      expect(values.__interrupt__[0].id).toBe("int-A");
      expect(values.__interrupt__[1].id).toBe("int-B");
    });

    it("should not duplicate interrupts when the same id arrives twice", async () => {
      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve A?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve A?" }],
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
    });

    it("should accumulate interrupts that have no id field", async () => {
      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ value: "approve A?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ value: "approve B?" }],
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
        __interrupt__: Array<{ value: string }>;
      };
      expect(values.__interrupt__).toHaveLength(2);
    });

    it("should preserve __interrupt__ across non-interrupt values events", async () => {
      // A non-interrupt values event arrives after an interrupt values event.
      // The __interrupt__ field must not be wiped.
      const events = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: { messages: [{ id: "1", content: "hi", type: "ai" }] },
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
        messages: Array<{ id: string }>;
      };
      expect(values.__interrupt__).toHaveLength(1);
      expect(values.__interrupt__[0].id).toBe("int-A");
    });

    it("should not overwrite existing messages with interrupt-only values payloads", async () => {
      const events = [
        {
          event: "values" as const,
          data: {
            messages: [{ id: "m-1", content: "hello", type: "human" }],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve?" }],
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
        messages: Array<{ id: string; content: string }>;
      };
      expect(values.__interrupt__).toHaveLength(1);
      expect(values.__interrupt__[0].id).toBe("int-A");
      expect(values.messages).toHaveLength(1);
      expect(values.messages[0].id).toBe("m-1");
      expect(values.messages[0].content).toBe("hello");
    });

    it("should clear stale __interrupt__ on new stream and show only remaining", async () => {
      // First stream: two parallel interrupts
      const firstStreamEvents = [
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-A", value: "approve A?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-B", value: "approve B?" }],
            messages: [],
          } as unknown as TestState,
        },
      ];

      const action1 = async () => createMockStream(firstStreamEvents);
      const onError = vi.fn();
      const baseOptions = {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] } as TestState,
        callbacks: {},
        onError,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action1, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      // Verify both interrupts are present
      let values = streamManager.values as unknown as {
        __interrupt__: Array<{ id: string; value: string }>;
      };
      expect(values.__interrupt__).toHaveLength(2);

      // Second stream (resume): backend re-raises only the remaining interrupt
      const secondStreamEvents = [
        {
          event: "values" as const,
          data: { messages: [] },
        },
        {
          event: "values" as const,
          data: {
            __interrupt__: [{ id: "int-B", value: "approve B?" }],
            messages: [],
          } as unknown as TestState,
        },
        {
          event: "values" as const,
          data: { messages: [] },
        },
      ];

      const action2 = async () => createMockStream(secondStreamEvents);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action2, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      expect(onError).not.toHaveBeenCalled();

      values = streamManager.values as unknown as {
        __interrupt__: Array<{ id: string; value: string }>;
      };
      expect(values.__interrupt__).toHaveLength(1);
      expect(values.__interrupt__[0].id).toBe("int-B");
    });

    it("should clear accumulated interrupts when a values event sends an empty array", async () => {
      const action1 = async () =>
        createMockStream([
          {
            event: "values" as const,
            data: {
              __interrupt__: [{ id: "int-A", value: "approve A?" }],
              messages: [],
            } as unknown as TestState,
          },
          {
            event: "values" as const,
            data: {
              __interrupt__: [{ id: "int-B", value: "approve B?" }],
              messages: [],
            } as unknown as TestState,
          },
        ]);
      const onError = vi.fn();
      const baseOptions = {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] } as TestState,
        callbacks: {},
        onError,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action1, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      const action2 = async () =>
        createMockStream([
          {
            event: "values" as const,
            data: {
              __interrupt__: [],
              messages: [],
            } as unknown as TestState,
          },
        ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action2, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      expect(onError).not.toHaveBeenCalled();
      expect(
        (streamManager.values as unknown as { __interrupt__: unknown[] })
          .__interrupt__
      ).toEqual([]);
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

  describe("abandoned run after clear()/stop()", () => {
    type State = { messages: Message[] };

    // The interrupt aborts this run's controller mid-stream; the stream then
    // returns normally instead of throwing AbortError, like streamWithRetry
    // does when the abort lands during its reconnect backoff.
    const runAbandoned = async (
      interrupt: (manager: StreamManager<State>) => void | Promise<void>
    ) => {
      const manager = new StreamManager<State>(new MessageTupleManager(), {
        throttle: false,
      });
      const onSuccess = vi.fn();
      const onFinish = vi.fn();

      await manager.start(
        async () => {
          async function* gen() {
            yield { event: "values" as const, data: { messages: [] } };
            await interrupt(manager);
          }
          return gen();
        },
        {
          getMessages: (values) => values.messages,
          setMessages: (current, messages) => ({ ...current, messages }),
          initialValues: { messages: [] },
          callbacks: {},
          onSuccess,
          onError: vi.fn(),
          onFinish,
        }
      );

      return { onSuccess, onFinish };
    };

    it("should skip onSuccess when the stream ends normally after clear()", async () => {
      const { onSuccess, onFinish } = await runAbandoned((m) => m.clear());

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("should skip onSuccess when the stream ends normally after stop()", async () => {
      const { onSuccess, onFinish } = await runAbandoned((m) =>
        m.stop({ messages: [] }, {})
      );

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe("stop() with a read", () => {
    type State = { messages: Message[]; count?: number };

    const history: State = { messages: [], count: 0 };
    const streamed: State = { messages: [], count: 1 };
    const kept: State = { messages: [], count: 2 };
    const options = {
      getMessages: (values: State) => values.messages ?? [],
      setMessages: (current: State, messages: Message[]) => ({
        ...current,
        messages,
      }),
      initialValues: { messages: [] } as State,
      callbacks: {},
      onSuccess: () => undefined,
      onError: vi.fn(),
    };
    const addTen = ({
      mutate,
    }: {
      mutate: (update: (prev: State) => Partial<State>) => void;
    }) => mutate((prev) => ({ count: (prev.count ?? 0) + 10 }));
    let manager: StreamManager<State>;

    const startRunningStream = async () => {
      let shown!: () => void;
      const started = new Promise<void>((resolve) => {
        shown = resolve;
      });
      void manager.start(async (signal) => {
        async function* gen() {
          yield { event: "values" as const, data: streamed };
          shown();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return gen() as never;
      }, options);
      await started;
    };
    const deferredRead = () => {
      let resolve!: (values: State) => void;
      const read = () =>
        new Promise<State>((r) => {
          resolve = r;
        });
      return { read, resolve: (values: State) => resolve(values) };
    };

    beforeEach(() => {
      manager = new StreamManager<State>(new MessageTupleManager(), {
        throttle: false,
      });
    });

    it.each([
      [
        "shows the read head with the onStop update on top",
        async () => kept,
        12,
      ],
      [
        "shows the history values with the onStop update on top",
        async () => null,
        10,
      ],
      [
        "keeps the stopped stream's values when the read returns undefined",
        async () => undefined,
        11,
      ],
      [
        "keeps the stopped stream's values when the read fails",
        async () => {
          throw new Error("offline");
        },
        11,
      ],
    ])("%s", async (_, read, count) => {
      await startRunningStream();

      await manager.stop(history, { onStop: addTen, read });

      expect(manager.values).toEqual({ messages: [], count });
    });

    it("clears the stream values when the read finds no head and onStop changed nothing", async () => {
      await startRunningStream();

      await manager.stop(history, { read: async () => null });

      expect(manager.values).toBeNull();
    });

    it("drops a read that resolves after a run queued before the stop begins", async () => {
      await startRunningStream();
      const queued = manager.start(
        async () =>
          createMockStream([
            { event: "values" as const, data: { messages: [], count: 3 } },
          ]) as never,
        options
      );
      const { read, resolve } = deferredRead();

      const stopping = manager.stop(history, { read });
      await queued;
      resolve(kept);
      await stopping;

      expect(manager.values).toEqual({ messages: [], count: 3 });
    });

    it("drops a read that resolves after clear()", async () => {
      await startRunningStream();
      const { read, resolve } = deferredRead();

      const stopping = manager.stop(history, { read });
      manager.clear();
      resolve(kept);
      await stopping;

      expect(manager.values).toBeNull();
    });

    it("does not read when no stream is running", async () => {
      const read = vi.fn(async () => kept);

      await manager.stop(history, { read });

      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("stream values", () => {
    type State = { messages: Message[]; count?: number };

    const startStream = (
      manager: StreamManager<State>,
      events: Array<{ event: string; data: unknown }>
    ) =>
      manager.start(async () => createMockStream(events) as never, {
        getMessages: (values) => values.messages ?? [],
        setMessages: (current, messages) => ({ ...current, messages }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError: vi.fn(),
      });
    let manager: StreamManager<State>;

    beforeEach(() => {
      manager = new StreamManager<State>(new MessageTupleManager(), {
        throttle: false,
      });
    });

    it("ignores values from a non-subagent subgraph namespace", async () => {
      await startStream(manager, [
        {
          event: "values",
          data: {
            messages: [{ id: "h1", type: "human", content: "hi" }],
            count: 1,
          },
        },
        {
          event: "values|research:1",
          data: { messages: [{ id: "s1", type: "ai", content: "notes" }] },
        },
      ]);

      expect(manager.values).toEqual({
        messages: [{ id: "h1", type: "human", content: "hi" }],
        count: 1,
      });
    });
  });

  describe("a message streamed again", () => {
    type State = { messages: Message[] };
    const human = { type: "human", id: "h1", content: "hi" } as Message;
    const values = { event: "values", data: { messages: [human] } };
    const chunk = (content: string) => ({
      event: "messages",
      data: [{ type: "ai", id: "a1", content }, {}],
    });
    const stream = (
      events: Array<{ event: string; data: unknown }>,
      options?: { isReplaying?: boolean }
    ) =>
      manager.start(async () => createMockStream(events) as never, {
        getMessages: (state) => state.messages ?? [],
        setMessages: (current, messages) => ({ ...current, messages }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError: vi.fn(),
        ...options,
      });
    const contents = (messages: Message[] | undefined) =>
      messages?.map((message) => message.content);
    let manager: StreamManager<State>;

    beforeEach(() => {
      manager = new StreamManager<State>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
        subagentToolNames: ["task"],
      });
    });

    it("starts over in a replay instead of extending the earlier copy", async () => {
      const run = [values, chunk("Hel"), chunk("lo")];

      await stream(run);
      await stream(run, { isReplaying: true });

      expect(contents(manager.values?.messages)).toEqual(["hi", "Hello"]);
    });

    it("extends the earlier copy when a stream resumes mid-message", async () => {
      await stream([values, chunk("Hel")]);
      await stream([chunk("lo")]);

      expect(contents(manager.values?.messages)).toEqual(["hi", "Hello"]);
    });

    it("starts a subagent's message over in a replay too", async () => {
      const subagentChunk = (content: string) => ({
        event: "messages|tools:task-ns",
        data: [{ type: "ai", id: "sub-ai-1", content }, {}],
      });
      const run = [
        {
          event: "messages",
          data: [
            {
              type: "ai",
              id: "ai-1",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  name: "task",
                  args: { subagent_type: "researcher", description: "Research" },
                },
              ],
            },
            {},
          ],
        },
        {
          event: "values|tools:task-ns",
          data: {
            messages: [{ type: "human", id: "sub-h1", content: "Research" }],
          },
        },
        subagentChunk("Hel"),
        subagentChunk("lo"),
      ];

      await stream(run);
      await stream(run, { isReplaying: true });

      const [subagent] = manager.getSubagentsByMessage("ai-1");
      expect(contents(subagent?.messages)).toEqual(["Hello"]);
    });
  });

  describe("throttle", () => {
    it("notifies at most once per interval while values keep changing", () => {
      vi.useFakeTimers();
      try {
        const manager = new StreamManager<TestState>(messageManager, {
          throttle: 100,
        });
        const listener = vi.fn();
        manager.subscribe(listener);

        for (let i = 0; i < 10; i += 1) {
          manager.setStreamValues({ messages: [], count: i });
          vi.advanceTimersByTime(20);
        }

        expect(listener).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("onError callback", () => {
    it("should keep prior interrupts visible when the next stream fails before values", async () => {
      const onError = vi.fn();
      const baseOptions = {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] } as TestState,
        callbacks: {},
        onError,
      };

      const action1 = async () =>
        createMockStream([
          {
            event: "values" as const,
            data: {
              __interrupt__: [{ id: "int-A", value: "approve?" }],
              messages: [],
            } as unknown as TestState,
          },
        ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action1, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      const streamError = new Error("Stream failed before values");
      const action2 = async () => {
        throw streamError;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (streamManager as any).enqueue(action2, {
        ...baseOptions,
        onSuccess: () => undefined,
      });

      expect(onError).toHaveBeenCalledWith(streamError);
      expect(
        (
          streamManager.values as unknown as {
            __interrupt__: Array<{ id: string; value: string }>;
          }
        ).__interrupt__
      ).toEqual([{ id: "int-A", value: "approve?" }]);
    });

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

  describe("pending subagent visibility", () => {
    const toolCalls = [
      {
        id: "call_1",
        name: "task",
        args: {
          subagent_type: "researcher",
          description: "Research AI trends",
        },
      },
    ];

    it("exposes pending subagents immediately after tool-call registration", () => {
      const mgr = new SubagentManager({
        subagentToolNames: ["task"],
      });

      mgr.registerFromToolCalls(toolCalls, "msg-1");

      const subagent = mgr.getSubagents().get("call_1");
      expect(subagent).toBeDefined();
      expect(subagent?.status).toBe("pending");
      expect(subagent?.startedAt).toBeNull();
      expect(mgr.getActiveSubagents()).toEqual([]);
    });

    it("returns pending subagents from getSubagentsByMessage before they start running", () => {
      const mgr = new SubagentManager({
        subagentToolNames: ["task"],
      });

      mgr.registerFromToolCalls(toolCalls, "msg-1");

      const subagents = mgr.getSubagentsByMessage("msg-1");
      expect(subagents).toHaveLength(1);
      expect(subagents[0]?.status).toBe("pending");
    });

    it("replays buffered subagent messages after namespace matching", () => {
      const mgr = new SubagentManager({
        subagentToolNames: ["task"],
      });

      mgr.registerFromToolCalls(toolCalls, "msg-1");

      mgr.addMessageToSubagent(
        "pregel-task-1",
        {
          id: "sub-ai-1",
          type: "ai",
          content: "",
          tool_calls: [
            {
              id: "search-1",
              name: "search_web",
              args: { query: "AI trends" },
            },
          ],
        },
        undefined
      );

      expect(mgr.getSubagent("call_1")?.toolCalls).toHaveLength(0);

      mgr.addMessageToSubagent(
        "pregel-task-1",
        {
          id: "sub-human-1",
          type: "human",
          content: "Research AI trends",
        },
        undefined
      );

      const subagent = mgr.getSubagent("call_1");
      expect(subagent?.toolCalls).toHaveLength(1);
      expect(subagent?.toolCalls[0]?.call.name).toBe("search_web");
    });
  });

  describe("SubagentManager aiMessageId update (OpenAI ID replacement)", () => {
    function createManager(onChange?: () => void) {
      return new SubagentManager({
        subagentToolNames: ["task"],
        onSubagentChange: onChange,
      });
    }

    const toolCalls = [
      {
        id: "call_1",
        name: "task",
        args: {
          subagent_type: "researcher",
          description: "Research AI trends",
        },
      },
    ];

    it("should update aiMessageId when provider replaces it", () => {
      const mgr = createManager();
      const streamingId = "lc_run--abc123";
      const finalId = "resp_xyz789";

      // Register with streaming ID
      mgr.registerFromToolCalls(toolCalls, streamingId);
      mgr.markRunning("call_1");

      // Verify lookup works with streaming ID
      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(1);

      // Re-register with final ID (simulating OpenAI replacing the ID)
      mgr.registerFromToolCalls(toolCalls, finalId);

      // Now lookup should work with the final ID
      expect(mgr.getSubagentsByMessage(finalId)).toHaveLength(1);
      // Old streaming ID should no longer match
      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(0);
    });

    it("should not clear aiMessageId when re-registering with null or undefined", () => {
      const mgr = createManager();
      const streamingId = "lc_run--abc123";

      mgr.registerFromToolCalls(toolCalls, streamingId);
      mgr.markRunning("call_1");

      // Re-register with null — should keep original ID
      mgr.registerFromToolCalls(toolCalls, null);
      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(1);

      // Re-register with undefined — should keep original ID
      mgr.registerFromToolCalls(toolCalls, undefined);
      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(1);
    });

    it("should not fire onSubagentChange when re-registering with the same ID", () => {
      const onChange = vi.fn();
      const mgr = createManager(onChange);

      mgr.registerFromToolCalls(toolCalls, "msg-1");
      onChange.mockClear();

      // Re-register with the same ID and same args — no change expected
      mgr.registerFromToolCalls(toolCalls, "msg-1");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("should update aiMessageId for multiple subagents from the same message", () => {
      const mgr = createManager();
      const streamingId = "lc_run--abc123";
      const finalId = "resp_xyz789";

      const multiToolCalls = [
        {
          id: "call_1",
          name: "task",
          args: {
            subagent_type: "researcher",
            description: "Research AI trends",
          },
        },
        {
          id: "call_2",
          name: "task",
          args: {
            subagent_type: "writer",
            description: "Write summary",
          },
        },
      ];

      mgr.registerFromToolCalls(multiToolCalls, streamingId);
      mgr.markRunning("call_1");
      mgr.markRunning("call_2");

      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(2);

      // Re-register with final ID
      mgr.registerFromToolCalls(multiToolCalls, finalId);

      expect(mgr.getSubagentsByMessage(finalId)).toHaveLength(2);
      expect(mgr.getSubagentsByMessage(streamingId)).toHaveLength(0);
    });
  });

  describe("fetchSubagentHistory namespace resolution", () => {
    type FetchThreads = Parameters<StreamManager<TestState>["fetchSubagentHistory"]>[0];

    /**
     * A discovery page entry shaped like a `select: ["checkpoint", "tasks"]`
     * response: no `values`, so matching reads only task results.
     */
    function entry(id: string, tasks: unknown[]) {
      return { checkpoint: { checkpoint_id: id, thread_id: "t" }, tasks };
    }

    /** A node task (not a Send) that wrote `messages`. */
    function nodeTask(name: string, messages: unknown[]) {
      return {
        id: `${name}-uuid`,
        name,
        path: ["__pregel_pull", name],
        result: { messages },
        checkpoint: null,
      };
    }

    function sendTask(
      id: string,
      index: number,
      opts: { name?: string; path?: unknown[]; messages?: unknown[] } = {}
    ) {
      return {
        id,
        name: opts.name ?? "tools",
        path: opts.path ?? ["__pregel_push", index, false],
        ...(opts.messages ? { result: { messages: opts.messages } } : {}),
        checkpoint: null,
      };
    }

    /**
     * A `getHistory` mock: the discovery page for the root namespace, and
     * one entry of `values.messages` per subagent namespace.
     */
    function historyMock(
      page: unknown[],
      byNamespace: Record<string, unknown[]>
    ) {
      return vi.fn(
        async (
          _threadId: string,
          opts?: { checkpoint?: { checkpoint_ns?: string } }
        ) => {
          const ns = opts?.checkpoint?.checkpoint_ns;
          if (ns) {
            return byNamespace[ns] ? [{ values: { messages: byNamespace[ns] } }] : [];
          }
          return page;
        }
      );
    }

    const contentsOf = (sm: StreamManager<TestState>, toolCallId: string) =>
      (sm.getSubagent(toolCallId)?.messages ?? []).map(
        (m) => (m as { content?: unknown }).content
      );

    it("does not bind a delegation to a newer turn's push tasks", async () => {
      const sm = new StreamManager<TestState>(messageManager, {
        throttle: false,
        subagentToolNames: ["task"],
      });
      // An older turn delegated "call-old", whose task result is outside the
      // fetched history; the newest turn only calls a regular tool.
      const delegation = {
        type: "ai",
        id: "ai-old",
        content: "",
        tool_calls: [
          {
            id: "call-old",
            name: "task",
            args: { subagent_type: "researcher", description: "Research" },
          },
        ],
      };
      const regularToolCall = {
        type: "ai",
        id: "ai-new",
        content: "",
        tool_calls: [{ id: "call-ls", name: "ls", args: {} }],
      };
      sm.reconstructSubagents(
        [delegation] as unknown as Parameters<typeof sm.reconstructSubagents>[0]
      );

      const getHistory = historyMock(
        [
          entry("cp-sends", [sendTask("uuid-ls", 0)]),
          entry("cp-model", [nodeTask("model", [regularToolCall])]),
        ],
        { "tools:uuid-ls": [{ type: "ai", id: "ai-ls", content: "ls output" }] }
      );

      await sm.fetchSubagentHistory(
        { getHistory } as unknown as FetchThreads,
        "thread-1"
      );

      expect(sm.getSubagent("call-old")?.messages).toEqual([]);
    });

    it("prefers a completed task's direct mapping over a newer pending checkpoint's positional guess", async () => {
      /**
       * Regression test: the newest checkpoint holds a still-pending (e.g.
       * interrupted) Send whose index points at "call-real", but "call-real"
       * was answered by an older, completed Send. The match by id from that
       * older Send's result must win over the index guess.
       */
      const sm = new StreamManager<TestState>(messageManager, {
        throttle: false,
        subagentToolNames: ["task"],
      });

      const aiMessage = {
        type: "ai",
        id: "ai-completed",
        content: "",
        tool_calls: [
          {
            id: "call-real",
            name: "task",
            args: {
              subagent_type: "researcher",
              description: "Research the real topic",
            },
          },
        ],
      };

      sm.reconstructSubagents(
        [aiMessage] as unknown as Parameters<typeof sm.reconstructSubagents>[0]
      );
      expect(sm.getSubagent("call-real")?.messages).toHaveLength(0);

      // Newest first:
      //   [0] pending Send at index 0, no result
      //   [1] the AIMessage it would index into
      //   [2] completed Send; its result maps call-real -> task:uuid-real
      const getHistory = historyMock(
        [
          entry("cp-pending", [
            sendTask("uuid-pending", 0, { name: "task" }),
          ]),
          entry("cp-model", [nodeTask("model", [aiMessage])]),
          entry("cp-done", [
            sendTask("uuid-real", 0, {
              name: "task",
              messages: [
                { type: "tool", tool_call_id: "call-real", content: "ok" },
              ],
            }),
          ]),
        ],
        {
          // Correct namespace, derived from the completed task result.
          "task:uuid-real": [
            { type: "human", id: "h-real", content: "Research the real topic" },
            { type: "ai", id: "ai-real", content: "Correct research result" },
          ],
          // Wrong namespace, returned only if the index guess wins.
          "task:uuid-pending": [
            { type: "ai", id: "ai-stale", content: "Stale pending result" },
          ],
        }
      );

      await sm.fetchSubagentHistory(
        { getHistory } as unknown as FetchThreads,
        "thread-1"
      );

      const contents = contentsOf(sm, "call-real");
      expect(contents).toContain("Correct research result");
      expect(contents).not.toContain("Stale pending result");
    });

    it.each([
      {
        label: "a regular tool call comes first",
        rejected: [] as string[],
        sends: ["uuid-search", "uuid-task"],
      },
      {
        label: "a human rejected the call before it",
        rejected: ["call-search"],
        sends: ["uuid-task"],
      },
    ])(
      "matches a subagent call to its own Send when $label",
      async ({ rejected, sends }) => {
        const sm = new StreamManager<TestState>(messageManager, {
          throttle: false,
          subagentToolNames: ["task"],
        });
        const aiMessage = {
          type: "ai",
          id: "ai-mixed",
          content: "",
          tool_calls: [
            { id: "call-search", name: "web_search", args: {} },
            {
              id: "call-task",
              name: "task",
              args: { subagent_type: "researcher", description: "Research" },
            },
          ],
        };
        const rejections = rejected.map((id) => ({
          type: "tool",
          id: `tool-${id}`,
          tool_call_id: id,
          status: "error",
          content: "User rejected the tool call.",
        }));
        sm.reconstructSubagents(
          [aiMessage, ...rejections] as unknown as Parameters<
            typeof sm.reconstructSubagents
          >[0]
        );

        // Newest first: the Sends, the HITL step that wrote the rejections
        // (if any), then the model step that wrote the AIMessage.
        const getHistory = historyMock(
          [
            entry(
              "cp-sends",
              sends.map((id, index) => sendTask(id, index))
            ),
            ...(rejections.length > 0
              ? [entry("cp-hitl", [nodeTask("review", rejections)])]
              : []),
            entry("cp-model", [nodeTask("model", [aiMessage])]),
          ],
          {
            "tools:uuid-task": [
              { type: "ai", id: "ai-sub", content: "Subagent progress" },
            ],
            "tools:uuid-search": [
              { type: "ai", id: "ai-search", content: "Search state" },
            ],
          }
        );

        await sm.fetchSubagentHistory(
          { getHistory } as unknown as FetchThreads,
          "thread-1"
        );

        const contents = contentsOf(sm, "call-task");
        expect(contents).toContain("Subagent progress");
        expect(contents).not.toContain("Search state");
      }
    );

    it.each([
      {
        label: "legacy Send path [PUSH, i]",
        path: ["__pregel_push", 0],
        maps: true,
      },
      {
        label: "aligned Send path [PUSH, i, false]",
        path: ["__pregel_push", 0, false],
        maps: true,
      },
      {
        label: "error-handler path (not a Send task)",
        path: ["__pregel_push", 0, false, "node_error_handler", false],
        maps: false,
      },
    ])(
      "positional fallback recognizes Send shapes correctly: $label",
      async ({ path, maps }) => {
        // A pending Send-shaped task and the subagent call it would index
        // into; a namespace payload exists for the task's namespace, so a
        // successful match is observable via getSubagent.
        const aiMessage = {
          type: "ai",
          id: "ai-shape",
          content: "",
          tool_calls: [
            {
              id: "call-shape",
              name: "task",
              args: { subagent_type: "researcher", description: "d" },
            },
          ],
        };
        const sm = new StreamManager<TestState>(messageManager, {
          throttle: false,
          subagentToolNames: ["task"],
        });
        // Register the pending subagent, as the stream would.
        sm.reconstructSubagents(
          [aiMessage] as unknown as Parameters<
            typeof sm.reconstructSubagents
          >[0]
        );
        const getHistory = historyMock(
          [
            entry("cp-shape", [sendTask("uuid-shape", 0, { name: "task", path })]),
            entry("cp-model", [nodeTask("model", [aiMessage])]),
          ],
          { "task:uuid-shape": [{ type: "human", content: "shape payload" }] }
        );
        await sm.fetchSubagentHistory(
          { getHistory } as unknown as FetchThreads,
          "thread-shape"
        );

        const subagent = sm.getSubagent("call-shape");
        if (maps) {
          expect(subagent).toBeDefined();
          expect(contentsOf(sm, "call-shape")).toContain("shape payload");
        } else {
          // A handler task is not a Send: no positional mapping, no fetch of
          // the task namespace.
          expect(subagent?.messages ?? []).toEqual([]);
        }
      }
    );

    it("matches by index for custom subagentToolNames", async () => {
      const sm = new StreamManager<TestState>(messageManager, {
        throttle: false,
        subagentToolNames: ["delegate"],
      });
      const aiMessage = {
        type: "ai",
        id: "ai-delegate",
        content: "",
        tool_calls: [
          {
            id: "call-delegate",
            name: "delegate",
            args: { subagent_type: "researcher", description: "Research" },
          },
        ],
      };
      sm.reconstructSubagents(
        [aiMessage] as unknown as Parameters<typeof sm.reconstructSubagents>[0]
      );
      const getHistory = historyMock(
        [
          entry("cp-sends", [sendTask("uuid-delegate", 0)]),
          entry("cp-model", [nodeTask("model", [aiMessage])]),
        ],
        {
          "tools:uuid-delegate": [
            { type: "ai", id: "ai-sub", content: "Delegated progress" },
          ],
        }
      );

      await sm.fetchSubagentHistory(
        { getHistory } as unknown as FetchThreads,
        "thread-1"
      );

      expect(contentsOf(sm, "call-delegate")).toContain("Delegated progress");
    });

    it("requests the discovery page with select but loads subagent messages in full", async () => {
      const sm = new StreamManager<TestState>(messageManager, {
        throttle: false,
        subagentToolNames: ["task"],
      });
      const aiMessage = {
        type: "ai",
        id: "ai-1",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "task",
            args: { subagent_type: "researcher", description: "Research" },
          },
        ],
      };
      sm.reconstructSubagents(
        [aiMessage] as unknown as Parameters<typeof sm.reconstructSubagents>[0]
      );
      const getHistory = historyMock(
        [
          entry("cp-sends", [sendTask("uuid-1", 0)]),
          entry("cp-model", [nodeTask("model", [aiMessage])]),
        ],
        { "tools:uuid-1": [{ type: "ai", id: "ai-sub", content: "progress" }] }
      );

      await sm.fetchSubagentHistory(
        { getHistory } as unknown as FetchThreads,
        "thread-1"
      );

      expect(getHistory.mock.calls.map(([, options]) => options)).toEqual([
        { limit: 20, select: ["checkpoint", "tasks"], signal: undefined },
        {
          checkpoint: { checkpoint_ns: "tools:uuid-1" },
          limit: 1,
          signal: undefined,
        },
      ]);
    });
  });

  describe("subagents bound by tool call id", () => {
    const task = (id: string, description: string) => ({
      id,
      name: "task",
      args: { subagent_type: "researcher", description },
    });
    const human = (id: string, content: string) => ({
      id,
      type: "human",
      content,
    });
    const ai = (id: string, content: string) => ({ id, type: "ai", content });

    async function run(
      manager: StreamManager<TestState>,
      events: Array<{ event: string; data: unknown }>
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).enqueue(async () => createMockStream(events), {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError: (error: unknown) => {
          throw error;
        },
      });
    }

    function subagentManager() {
      return new StreamManager<TestState>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
      });
    }

    it("parallel subagents with the same task text bind by tool call id", async () => {
      const manager = subagentManager();
      await run(manager, [
        {
          event: "messages",
          data: [
            {
              ...ai("ai-1", ""),
              tool_calls: [task("call_1", "Same task"), task("call_2", "Same task")],
            },
            {},
          ],
        },
        {
          event: "lifecycle|tools:b",
          data: { event: "started", namespace: ["tools:b"], tool_call_id: "call_2" },
        },
        {
          event: "lifecycle|tools:a",
          data: { event: "started", namespace: ["tools:a"], tool_call_id: "call_1" },
        },
        { event: "values|tools:b", data: { messages: [human("h-b", "Same task")] } },
        { event: "messages|tools:b", data: [ai("from-b", "b"), {}] },
        { event: "values|tools:a", data: { messages: [human("h-a", "Same task")] } },
        { event: "messages|tools:a", data: [ai("from-a", "a"), {}] },
      ]);

      expect(manager.getSubagent("call_1")?.namespace).toEqual(["tools:a"]);
      expect(manager.getSubagent("call_2")?.namespace).toEqual(["tools:b"]);
      expect(manager.getSubagent("call_1")?.messages.map((m) => m.id)).toEqual(["from-a"]);
      expect(manager.getSubagent("call_2")?.messages.map((m) => m.id)).toEqual(["from-b"]);
    });

    it("binds a subagent from the tool call id deepagents puts on its tokens", async () => {
      const manager = subagentManager();
      await run(manager, [
        {
          event: "messages",
          data: [
            {
              ...ai("ai-1", ""),
              tool_calls: [task("call_1", "Same task"), task("call_2", "Same task")],
            },
            {},
          ],
        },
        {
          event: "messages|tools:b",
          data: [ai("from-b", "b"), { lc_subagent_tool_call_id: "call_2" }],
        },
      ]);

      expect(manager.getSubagent("call_2")?.status).toBe("running");
      expect(manager.getSubagent("call_2")?.messages.map((m) => m.id)).toEqual(["from-b"]);
      expect(manager.getSubagent("call_1")?.messages).toEqual([]);
    });

    it("a graph a tool runs inside a subagent leaves the subagent's namespace alone", async () => {
      const manager = subagentManager();
      await run(manager, [
        {
          event: "messages",
          data: [
            { ...ai("ai-1", ""), tool_calls: [task("call_1", "Research")] },
            {},
          ],
        },
        {
          event: "messages|tools:a",
          data: [ai("own", "a"), { lc_subagent_tool_call_id: "call_1" }],
        },
        {
          event: "messages|tools:a|tools:s",
          data: [ai("tool-graph", "s"), { lc_subagent_tool_call_id: "call_1" }],
        },
        {
          event: "messages|tools:a|tools:b",
          data: [ai("nested", "b"), { lc_subagent_tool_call_id: "call_nested" }],
        },
      ]);

      expect(manager.getSubagent("call_1")).toMatchObject({
        namespace: ["tools:a"],
        parentId: null,
        depth: 1,
      });
    });

    it("a failed lifecycle event ends the subagent with its error, and a retry starts it again", async () => {
      const manager = subagentManager();
      const lifecycle = (event: string) => ({
        event: "lifecycle|tools:a",
        data: {
          event,
          namespace: ["tools:a"],
          tool_call_id: "call_1",
          error: { error: "Error", message: "boom" },
        },
      });
      await run(manager, [
        { event: "messages", data: [{ ...ai("ai-1", ""), tool_calls: [task("call_1", "x")] }, {}] },
        lifecycle("started"),
        lifecycle("failed"),
      ]);
      expect(manager.getSubagent("call_1")).toMatchObject({ status: "error", error: "boom" });

      await run(manager, [lifecycle("started")]);
      expect(manager.getSubagent("call_1")).toMatchObject({ status: "running", error: null });
    });
  });

  describe("a restarted run", () => {
    const tuple = (id: string, content: string) => [
      { id, type: "ai", content },
      {},
    ];

    async function run(
      manager: StreamManager<TestState>,
      events: Array<{ event: string; data: unknown }>,
      isReplaying = false
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).enqueue(async () => createMockStream(events), {
        getMessages: (values: TestState) => values.messages ?? [],
        setMessages: (current: TestState, messages: TestState["messages"]) => ({
          ...current,
          messages,
        }),
        initialValues: { messages: [] },
        callbacks: {},
        onSuccess: () => undefined,
        onError: (error: unknown) => {
          throw error;
        },
        isReplaying,
      });
    }

    const finished = { id: "done", type: "human", content: "hi" };

    it("drops the cut attempt's message and keeps finished steps", async () => {
      await run(streamManager, [
        { event: "metadata", data: { run_id: "r", attempt: 1 } },
        { event: "values", data: { messages: [finished] } },
        { event: "messages", data: tuple("cut", "Hel") },
        { event: "metadata", data: { run_id: "r", attempt: 2 } },
        { event: "messages", data: tuple("again", "Hello") },
      ]);

      expect(streamManager.values?.messages).toEqual([
        finished,
        expect.objectContaining({ id: "again", content: "Hello" }),
      ]);
    });

    it("drops the subagent card its cut attempt started", async () => {
      const manager = new StreamManager<TestState>(new MessageTupleManager(), {
        throttle: false,
        filterSubagentMessages: true,
      });
      const withTask = (id: string, callId: string) => ({
        id,
        type: "ai",
        content: "",
        tool_calls: [
          {
            id: callId,
            name: "task",
            args: { subagent_type: "researcher", description: "x" },
          },
        ],
      });
      await run(manager, [
        { event: "metadata", data: { run_id: "r", attempt: 1 } },
        { event: "values", data: { messages: [finished, withTask("kept", "call_kept")] } },
        { event: "messages", data: [withTask("cut", "call_cut"), {}] },
        { event: "metadata", data: { run_id: "r", attempt: 2 } },
      ]);

      expect(manager.getSubagent("call_cut")).toBeUndefined();
    });

    it("a message sent again by the new attempt starts over", async () => {
      await run(streamManager, [
        { event: "metadata", data: { run_id: "r", attempt: 1 } },
        { event: "messages", data: tuple("same", "Hel") },
        { event: "metadata", data: { run_id: "r", attempt: 2 } },
        { event: "messages", data: tuple("same", "Hello") },
      ]);

      expect(streamManager.values?.messages).toEqual([
        expect.objectContaining({ id: "same", content: "Hello" }),
      ]);
    });

    it("a replay that holds a restart resets once", async () => {
      await run(streamManager, [{ event: "messages", data: tuple("cut", "Hel") }]);
      await run(
        streamManager,
        [
          { event: "metadata", data: { run_id: "r", attempt: 1 } },
          { event: "values", data: { messages: [finished] } },
          { event: "messages", data: tuple("cut", "Hel") },
          { event: "metadata", data: { run_id: "r", attempt: 2 } },
          { event: "messages", data: tuple("again", "Hello") },
        ],
        true
      );

      expect(streamManager.values?.messages).toEqual([
        finished,
        expect.objectContaining({ id: "again", content: "Hello" }),
      ]);
    });
  });
});
