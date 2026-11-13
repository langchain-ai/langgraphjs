import { describe, it, expect, vi } from "vitest";
import { CustomStreamOrchestrator } from "./orchestrator-custom.js";
import type { AnyStreamCustomOptions } from "./types.js";

type TestState = {
  messages: Array<{ id?: string; content: string; type: string }>;
  count?: number;
};

async function* createMockStream<T>(events: T[]): AsyncGenerator<T> {
  for (const event of events) {
    yield event;
  }
}

function createMockTransport(events: unknown[] = []) {
  return {
    stream: vi.fn().mockImplementation(async () => createMockStream(events)),
  };
}

/** Each run streams its events once `open()` releases it, oldest first. */
function gatedTransport(...runs: unknown[][]) {
  const opens: Array<() => void> = [];
  const transport = {
    stream: vi.fn().mockImplementation(async () => {
      const events = runs.shift() ?? [];
      const gate = new Promise<void>((resolve) => opens.push(resolve));
      return (async function* () {
        await gate;
        yield* events;
      })();
    }),
  };
  return { transport, open: () => opens.shift()?.() };
}

const human = (id: string, content: string) => ({ id, type: "human", content });

const sentThreads = (transport: { stream: ReturnType<typeof vi.fn> }) =>
  transport.stream.mock.calls.map(
    ([payload]) => payload.config.configurable.thread_id
  );

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

    it("shows initialValues until a run streams", () => {
      const initial: TestState = {
        messages: [{ id: "1", content: "hi", type: "human" }],
      };
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ initialValues: initial })
      );

      expect(orch.values).toEqual(initial);
      expect(orch.messages).toHaveLength(1);

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

    it("stays on the thread its first submit created", async () => {
      const transport = createMockTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport })
      );

      await orch.submit({ messages: [] });
      await orch.submit({ messages: [] });

      const [first, second] = sentThreads(transport);
      expect(second).toBe(first);
      expect(orch.threadId).toBe(first);

      orch.dispose();
    });

    it("sends a submit made during a new chat's first run to that chat's thread", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport })
      );

      const first = orch.submit({ messages: [] });
      const second = orch.submit({ messages: [] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      open();
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(2));
      open();
      await Promise.all([first, second]);

      const [a, b] = sentThreads(transport);
      expect(b).toBe(a);

      orch.dispose();
    });

    it("drops a submit waiting behind a run when the thread switches", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );

      const first = orch.submit({ messages: [] });
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      orch.switchThread("t2");
      const loading: boolean[] = [];
      orch.subscribe(() => loading.push(orch.isLoading));
      open();
      await first;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(transport.stream).toHaveBeenCalledTimes(1);
      expect(loading).not.toContain(true);

      orch.dispose();
    });

    it("drops a submit waiting behind a run when the run is stopped", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );

      const first = orch.submit({ messages: [] });
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      await orch.stop();
      open();
      await first;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(transport.stream).toHaveBeenCalledTimes(1);

      orch.dispose();
    });

    it("lists a submit made during a run until its turn, and drops it when cancelled", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      const first = orch.submit({ messages: [human("h1", "one")] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));

      void orch.submit({ messages: [human("h2", "two")] });
      expect(orch.queueEntries.map((entry) => entry.values)).toEqual([
        { messages: [human("h2", "two")] },
      ]);

      expect(await orch.cancelQueueItem(orch.queueEntries[0].id)).toBe(true);
      open();
      await first;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(orch.queueEntries).toEqual([]);
      expect(transport.stream).toHaveBeenCalledTimes(1);

      orch.dispose();
    });

    it("starts a switched thread empty, without the first thread's initialValues", () => {
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({
          threadId: "t1",
          initialValues: { messages: [human("h0", "earlier")] },
        })
      );

      orch.switchThread("t2");

      expect(orch.messages).toEqual([]);

      orch.dispose();
    });

    it("keeps the messages shown and adds its input at once", async () => {
      const { transport, open } = gatedTransport([
        { event: "values", data: { messages: [human("h1", "hi")] } },
      ]);
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      const done = orch.submit({ messages: [human("h1", "hi")] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      open();
      await done;

      void orch.submit({ messages: [human("h2", "again")] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(2));

      expect(orch.messages.map((message) => message.id)).toEqual(["h1", "h2"]);

      open();
      orch.dispose();
    });

    it("leaves a run in flight as shown until a submit waiting behind it starts", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      const first = orch.submit({ messages: [human("h1", "one")] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));

      const second = orch.submit({ messages: [human("h2", "two")] });
      expect(orch.messages.map((message) => message.id)).toEqual(["h1"]);

      open();
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(2));
      expect(orch.messages.map((message) => message.id)).toEqual(["h1", "h2"]);

      open();
      await Promise.all([first, second]);
      orch.dispose();
    });

    it("with optimistic false, sends the input as passed and shows it when the server does", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1", optimistic: false })
      );
      const input = { messages: [{ type: "human", content: "hi" }] };
      const done = orch.submit(input);
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));

      expect(transport.stream.mock.calls[0][0].input).toBe(input);
      expect(orch.messages).toEqual([]);

      open();
      await done;
      orch.dispose();
    });

    it("sends the input's messages with the ids they're shown with", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      const done = orch.submit({ messages: [{ type: "human", content: "hi" }] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));

      const [sent] = transport.stream.mock.calls[0][0].input.messages;
      expect(sent.id).toEqual(expect.any(String));
      expect(orch.messages[0].id).toBe(sent.id);

      open();
      await done;
      orch.dispose();
    });
  });

  describe("respond", () => {
    const interrupted = {
      event: "values",
      data: { messages: [], __interrupt__: [{ id: "i1", value: "approve?" }] },
    };

    it("resumes the newest interrupt, hidden until its run ends", async () => {
      const { transport, open } = gatedTransport(
        [interrupted],
        [{ event: "values", data: { messages: [] } }]
      );
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      const asked = orch.submit({ messages: [] });
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
      open();
      await asked;
      expect(orch.interrupts.map((interrupt) => interrupt.id)).toEqual(["i1"]);

      const answered = orch.respond("yes");
      expect(orch.interrupts).toEqual([]);
      expect(orch.interrupt).toBeUndefined();
      await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(2));
      expect(transport.stream.mock.calls[1][0].command).toEqual({
        resume: { i1: "yes" },
      });

      open();
      await answered;
      expect(orch.interrupts).toEqual([]);
      orch.dispose();
    });

    it("rejects and shows the interrupt again when the answer can't be sent", async () => {
      const transport = {
        stream: vi
          .fn()
          .mockImplementationOnce(async () => createMockStream([interrupted]))
          .mockRejectedValueOnce(new Error("offline")),
      };
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      await orch.submit({ messages: [] });

      await expect(orch.respond("yes")).rejects.toThrow("offline");
      expect(orch.interrupts.map((interrupt) => interrupt.id)).toEqual(["i1"]);

      orch.dispose();
    });

    it("rejects when no interrupt waits", async () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      await expect(orch.respond("yes")).rejects.toThrow("No pending interrupt");

      orch.dispose();
    });

    it("answers the interrupt `interrupt` shows, with no id given", async () => {
      const transport = createMockTransport([
        {
          event: "values",
          data: {
            messages: [],
            __interrupt__: [
              { id: "a", value: "first?" },
              { id: "b", value: "second?" },
            ],
          },
        },
      ]);
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );
      await orch.submit({ messages: [] });
      expect(orch.interrupt?.id).toBe("a");

      await orch.respond("yes");

      expect(transport.stream.mock.calls[1][0].command.resume).toEqual({
        a: "yes",
      });
      orch.dispose();
    });

    it("resolves an answer once its run starts", async () => {
      const { transport, open } = gatedTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );

      const answered = orch.respondAll({ i1: "yes" }).then(() => "resolved");
      const later = new Promise((resolve) => setTimeout(resolve, 50, "pending"));

      expect(await Promise.race([answered, later])).toBe("resolved");
      open();
      orch.dispose();
    });

    it("rejects an answer with no thread", async () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());

      await expect(orch.respondAll({ i1: "yes" })).rejects.toThrow(
        "No active thread"
      );

      orch.dispose();
    });

    it("respondAll sends every answer, update and goto in one resume command", async () => {
      const transport = createMockTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );

      await orch.respondAll(
        { i1: "yes", i2: "no" },
        { update: { count: 1 }, goto: "next" }
      );

      expect(transport.stream.mock.calls[0][0].command).toEqual({
        resume: { i1: "yes", i2: "no" },
        update: { count: 1 },
        goto: "next",
      });

      orch.dispose();
    });
  });

  describe("as a binding's engine", () => {
    it("hydrate() switches to another thread and resolves, reading nothing", async () => {
      const transport = createMockTransport();
      const orch = new CustomStreamOrchestrator<TestState>(
        createOptions({ transport, threadId: "t1" })
      );

      await orch.hydrate("t2");
      await orch.hydrate();

      expect(orch.threadId).toBe("t2");
      expect(transport.stream).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("disposes a tick after activate()'s cleanup, unless activated again", async () => {
      const orch = new CustomStreamOrchestrator<TestState>(createOptions());
      const stop = vi.spyOn(orch.stream, "stop").mockResolvedValue(undefined);
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

      orch.activate()();
      orch.activate();
      await tick();
      expect(stop).not.toHaveBeenCalled();

      orch.activate()();
      await tick();
      expect(stop).toHaveBeenCalled();
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
