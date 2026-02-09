import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamManager } from "./manager.js";
import { MessageTupleManager } from "./messages.js";

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
});
