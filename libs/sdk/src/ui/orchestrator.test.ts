import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  StreamOrchestrator,
  type OrchestratorAccessors,
} from "./orchestrator.js";
import type { AnyStreamOptions } from "./types.js";
import type { Client } from "../client.js";
import type { HeadlessToolImplementation } from "../headless-tools.js";

type TestState = {
  messages: Array<
    { id: string; content: string; type: string } & Record<string, unknown>
  >;
  count?: number;
};

async function flushMicrotasks(count = 4) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

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

function createSubagentStateValues(): TestState {
  return {
    messages: [
      { id: "m1", content: "research tires", type: "human" },
      {
        id: "m2",
        content: "",
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            type: "tool_call",
            args: {
              description: "Calculate tire sizes",
              subagent_type: "researcher",
            },
          },
        ],
      },
      {
        id: "m3",
        content: "completed",
        type: "tool",
        name: "task",
        tool_call_id: "task-1",
      },
    ],
  };
}

function createThreadState(values: TestState) {
  return {
    values,
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
  };
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
    const pendingToolState = () => ({
      ...createThreadState({ messages: [] }),
      next: ["tools"],
      tasks: [
        {
          id: "task-1",
          name: "tools",
          error: null,
          interrupts: [
            {
              id: "int-1",
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
        },
      ],
    });
    const weatherTool = (): HeadlessToolImplementation<
      { city: string },
      string
    > => ({
      tool: { name: "get_weather" },
      execute: vi.fn().mockResolvedValue("sunny"),
    });

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

    it("runs a pending headless tool found in the snapshot once and resumes", async () => {
      const toolImpl = weatherTool();
      (client.threads.getState as Mock).mockResolvedValue(pendingToolState());
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ tools: [toolImpl] }),
        accessors
      );
      orch.initThreadId("t1");

      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());
      await flushMicrotasks(20);

      expect(toolImpl.execute).toHaveBeenCalledTimes(1);
      expect(toolImpl.execute).toHaveBeenCalledWith({ city: "SF" });
      expect(client.runs.stream).toHaveBeenCalledTimes(1);
      expect(client.runs.stream).toHaveBeenCalledWith(
        "t1",
        "test-assistant",
        expect.objectContaining({
          command: expect.objectContaining({
            resume: { "int-1": { "call-1": "sunny" } },
          }),
        })
      );

      orch.dispose();
    });

    it("waits for a rejoined run to end before running a pending headless tool", async () => {
      const toolImpl = weatherTool();
      let serveHead!: (state: unknown) => void;
      (client.threads.getState as Mock)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            serveHead = resolve;
          })
        )
        .mockResolvedValue(pendingToolState());
      let endRun!: () => void;
      (client.runs.joinStream as Mock).mockImplementationOnce(() =>
        (async function* () {
          await new Promise<void>((resolve) => {
            endRun = resolve;
          });
          yield { event: "values", data: { messages: [] } };
        })()
      );
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ tools: [toolImpl] }),
        accessors
      );
      orch.initThreadId("t1");
      const join = orch.joinStream("run-1");
      serveHead(pendingToolState());
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      await flushMicrotasks(20);
      expect(toolImpl.execute).not.toHaveBeenCalled();

      endRun();
      await join;
      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());
      await flushMicrotasks(20);

      expect(toolImpl.execute).toHaveBeenCalledTimes(1);
      expect(client.runs.stream).toHaveBeenCalledTimes(1);

      orch.dispose();
    });

    it.each([
      {
        via: "joinStream",
        run: (orch: StreamOrchestrator<TestState>) => orch.joinStream("run-1"),
      },
      {
        via: "submit",
        run: (orch: StreamOrchestrator<TestState>) =>
          orch.submit({ messages: [] }, { command: { resume: "yes" } }),
      },
    ])(
      "does not run a pending tool from a read that resolves after a run ends ($via)",
      async ({ run }) => {
        const toolImpl = weatherTool();
        let serveHead!: (state: unknown) => void;
        (client.threads.getState as Mock).mockReturnValueOnce(
          new Promise((resolve) => {
            serveHead = resolve;
          })
        );
        const answered = () =>
          (async function* () {
            yield { event: "values", data: { messages: [] } };
          })();
        (client.runs.joinStream as Mock).mockImplementationOnce(answered);
        (client.runs.stream as Mock).mockImplementationOnce(answered);

        const orch = new StreamOrchestrator<TestState>(
          createOptions({ tools: [toolImpl] }),
          accessors
        );
        orch.initThreadId("t1");
        await run(orch);
        serveHead(pendingToolState());
        await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
        await flushMicrotasks(20);

        expect(toolImpl.execute).not.toHaveBeenCalled();

        orch.dispose();
      }
    );

    it("does not run a pending tool from the read after stop()", async () => {
      const toolImpl = weatherTool();
      (client.threads.getHistory as Mock).mockResolvedValue([
        createThreadState({ messages: [] }),
      ]);
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true, tools: [toolImpl] }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      (client.runs.joinStream as Mock).mockImplementationOnce(
        (
          _threadId: string,
          _runId: string,
          { signal }: { signal: AbortSignal }
        ) =>
          (async function* () {
            await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            });
            yield { event: "values", data: { messages: [] } };
          })()
      );
      let serveHead!: (states: unknown) => void;
      (client.threads.getHistory as Mock).mockReturnValueOnce(
        new Promise((resolve) => {
          serveHead = resolve;
        })
      );

      const join = orch.joinStream("run-1");
      await flushMicrotasks();
      const stopping = orch.stop();
      await join;
      serveHead([pendingToolState()]);
      await stopping;
      await flushMicrotasks(20);

      expect(toolImpl.execute).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("does not run a pending tool from a read that lands after a thread switch", async () => {
      const toolImpl = weatherTool();
      (client.threads.getState as Mock).mockResolvedValue({
        ...createThreadState({ messages: [] }),
        next: ["review"],
        tasks: [
          {
            id: "task-0",
            name: "review",
            error: null,
            interrupts: [{ id: "int-0", value: "approve?" }],
          },
        ],
      });
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ tools: [toolImpl] }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      let finishRead!: (state: unknown) => void;
      (client.threads.getState as Mock)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishRead = resolve;
          })
        )
        .mockResolvedValue(createThreadState({ messages: [] }));
      (client.runs.stream as Mock).mockImplementationOnce(() =>
        (async function* () {
          yield { event: "values", data: { messages: [] } };
        })()
      );

      const run = orch.submit({ messages: [] }, { command: { resume: "yes" } });
      await vi.waitFor(() =>
        expect(client.threads.getState).toHaveBeenCalledTimes(2)
      );
      orch.switchThread("t2");
      finishRead(pendingToolState());
      await run;
      await flushMicrotasks(20);

      expect(orch.threadId).toBe("t2");
      expect(toolImpl.execute).not.toHaveBeenCalled();

      orch.dispose();
    });

    it.each([
      { shownWhenToolEnds: "t1", resumedThreads: ["t1"] },
      { shownWhenToolEnds: "t2", resumedThreads: [] },
    ])(
      "resumes a pending tool's thread only if it is still shown when the tool ends ($shownWhenToolEnds)",
      async ({ shownWhenToolEnds, resumedThreads }) => {
        let finishTool!: (result: string) => void;
        const toolImpl = {
          tool: { name: "get_weather" },
          execute: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                finishTool = resolve;
              })
          ),
        };
        (client.threads.getState as Mock).mockResolvedValue(pendingToolState());
        (client.runs.stream as Mock).mockImplementation(() =>
          (async function* () {})()
        );
        const orch = new StreamOrchestrator<TestState>(
          createOptions({ tools: [toolImpl] }),
          accessors
        );
        orch.initThreadId("t1");
        await vi.waitFor(() => expect(toolImpl.execute).toHaveBeenCalled());
        (client.threads.getState as Mock).mockResolvedValue(
          createThreadState({ messages: [] })
        );

        orch.switchThread(shownWhenToolEnds);
        finishTool("sunny");
        await flushMicrotasks(20);

        expect(
          (client.runs.stream as Mock).mock.calls.map(([threadId]) => threadId)
        ).toEqual(resumedThreads);
        orch.dispose();
      }
    );

    it("runs a pending tool again when its thread is reopened after a switch dropped its result", async () => {
      let finishFirstRun!: (result: string) => void;
      const toolImpl = {
        tool: { name: "get_weather" },
        execute: vi
          .fn()
          .mockReturnValueOnce(
            new Promise<string>((resolve) => {
              finishFirstRun = resolve;
            })
          )
          .mockResolvedValue("sunny"),
      };
      (client.threads.getState as Mock).mockImplementation(
        async (threadId: string) =>
          threadId === "t1"
            ? pendingToolState()
            : createThreadState({ messages: [] })
      );
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ tools: [toolImpl] }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(toolImpl.execute).toHaveBeenCalled());
      orch.switchThread("t2");
      finishFirstRun("stale");
      await flushMicrotasks(20);

      orch.switchThread("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      await flushMicrotasks(20);

      expect(toolImpl.execute).toHaveBeenCalledTimes(2);
      expect(
        (client.runs.stream as Mock).mock.calls.map(([threadId]) => threadId)
      ).toEqual(["t1"]);
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

  describe("implicit checkpoint", () => {
    const checkpoint = (checkpoint_id: string) => ({
      thread_id: "t1",
      checkpoint_id,
      checkpoint_ns: "",
      checkpoint_map: null,
    });
    const state = (id: string, parent?: string) => ({
      ...createThreadState({ messages: [] }),
      checkpoint: checkpoint(id),
      parent_checkpoint: parent ? checkpoint(parent) : null,
    });

    const sentCheckpoint = async (history: unknown[], branch = "") => {
      (client.threads.getHistory as Mock).mockResolvedValue(history);
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      orch.setBranch(branch);

      await orch.submit({ messages: [] });

      orch.dispose();
      return (client.runs.stream as Mock).mock.calls[0][2].checkpoint;
    };

    it("does not pin the cached head when the latest branch is shown", async () => {
      const history = [state("cp-b", "cp-a"), state("cp-a")];
      expect(await sentCheckpoint(history)).toBeUndefined();
    });

    it("does not pin the head for a submit with interrupt during a run", async () => {
      (client.threads.getHistory as Mock).mockResolvedValue([state("cp-1")]);
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      (client.threads.getHistory as Mock).mockResolvedValue([
        state("cp-2", "cp-1"),
        state("cp-1"),
      ]);

      const first = orch.submit({ messages: [] });
      await orch.submit({ messages: [] }, { multitaskStrategy: "interrupt" });
      await first;

      orch.dispose();
      const second = (client.runs.stream as Mock).mock.calls[1][2];
      expect(second.checkpoint).toBeUndefined();
    });

    it.each([
      {
        view: "an older branch picked with setBranch",
        history: [state("cp-b", "cp-r"), state("cp-a", "cp-r"), state("cp-r")],
        branch: "cp-a",
        shownHead: "cp-a",
      },
      {
        view: "the default branch, not the newest",
        history: [
          state("cp-a2", "cp-a"),
          state("cp-b", "cp-r"),
          state("cp-a", "cp-r"),
          state("cp-r"),
        ],
        branch: "",
        shownHead: "cp-b",
      },
    ])(
      "still forks from the shown head on $view",
      async ({ history, branch, shownHead }) => {
        const sent = await sentCheckpoint(history, branch);
        expect(sent?.checkpoint_id).toBe(shownHead);
      }
    );
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
      await flushMicrotasks();

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

    it("reconciles the stream buffer against server state after a cancel", async () => {
      const partialValues: TestState = {
        messages: [{ id: "m1", content: "partial", type: "ai" }],
      };

      let submitSignal: AbortSignal | undefined;
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { event: "values" as const, data: partialValues };
          // Hang until the run is aborted, like a real in-flight fetch would.
          await new Promise<never>((_resolve, reject) => {
            submitSignal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
      };
      (client.runs.stream as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _threadId: string,
          _assistantId: string,
          payload: { signal: AbortSignal }
        ) => {
          submitSignal = payload.signal;
          return mockStream;
        }
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      const submitPromise = orch.submit({ messages: [] });
      await flushMicrotasks();

      // The in-flight chunk is optimistically visible while streaming.
      expect(orch.messages).toEqual(partialValues.messages);

      await orch.stop();
      await flushMicrotasks();

      // The cancelled run was never persisted server-side (mocked
      // `getState` reports empty messages), so the stray buffered chunk
      // must not stay stuck once `stop()` resolves.
      expect(orch.messages).toEqual([]);
      expect(client.threads.getState).toHaveBeenCalledWith("t1");

      await submitPromise;
      orch.dispose();
    });
  });

  describe("joinStream", () => {
    const message = (id: string, type = "human") => ({ id, content: id, type });
    const serve = (values: TestState) => {
      const state = createThreadState(values);
      (client.threads.getState as Mock).mockResolvedValue(state);
      (client.threads.getHistory as Mock).mockResolvedValue([state]);
    };

    it("shows the head read after the run when history is enabled", async () => {
      serve({ messages: [message("h0")] });
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ fetchStateHistory: true }),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      const final = { id: "a0", content: "Hello world", type: "ai" };
      serve({ messages: [message("h0"), final] });

      (client.runs.joinStream as Mock).mockImplementationOnce(() =>
        (async function* () {
          yield {
            event: "values",
            data: {
              messages: [
                message("h0"),
                { id: "a0", content: "Hello", type: "ai" },
              ],
            },
          };
        })()
      );
      await orch.joinStream("run-1");

      expect(orch.messages).toEqual([message("h0"), final]);
      orch.dispose();
    });
  });

  describe("thread state after a run", () => {
    type StreamEvents = Array<{ event: string; data: unknown }>;

    const message = (id: string, type = "human") => ({ id, content: id, type });
    const stateWith = (
      values: TestState,
      extra: Record<string, unknown> = {}
    ) => ({ ...createThreadState(values), ...extra });
    const interrupted = () =>
      stateWith(
        { messages: [message("h0")] },
        {
          next: ["review"],
          tasks: [
            {
              id: "task-1",
              name: "review",
              error: null,
              interrupts: [{ id: "int-1", value: "approve?" }],
            },
          ],
        }
      );

    const getState = () => client.threads.getState as Mock;
    const getHistory = () => client.threads.getHistory as Mock;
    const reads = (fetchStateHistory: boolean) =>
      fetchStateHistory ? getHistory() : getState();
    const serve = (state: Record<string, unknown>) => {
      getState().mockResolvedValue(state);
      getHistory().mockResolvedValue([state]);
    };

    const eventsOf = (events: StreamEvents) =>
      (async function* () {
        yield* events;
      })();
    const mockRun = (events: StreamEvents) => {
      (client.runs.stream as Mock).mockImplementationOnce(() =>
        eventsOf(events)
      );
    };
    const mockJoin = (events: StreamEvents) => {
      (client.runs.joinStream as Mock).mockImplementationOnce(() =>
        eventsOf(events)
      );
    };

    const openThread = async (
      options?: Partial<AnyStreamOptions<TestState>>
    ) => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(options),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      return orch;
    };

    const answeringRuns = [
      {
        via: "submit",
        run: async (
          orch: StreamOrchestrator<TestState>,
          events: StreamEvents
        ) => {
          mockRun(events);
          await orch.submit({ messages: [] }, { command: { resume: "yes" } });
        },
      },
      {
        via: "joinStream",
        run: async (
          orch: StreamOrchestrator<TestState>,
          events: StreamEvents
        ) => {
          mockJoin(events);
          await orch.joinStream("run-1");
        },
      },
    ];

    it.each(answeringRuns)(
      "a run that answers an interrupt removes it ($via)",
      async ({ run }) => {
        serve(interrupted());
        const orch = await openThread();
        expect(orch.interrupts.map((i) => i.id)).toEqual(["int-1"]);
        const answered = [message("h0"), message("a0", "ai")];
        serve(stateWith({ messages: answered }));

        await run(orch, [{ event: "values", data: { messages: answered } }]);

        expect(orch.interrupts).toEqual([]);
        expect(orch.messages).toEqual(answered);
        orch.dispose();
      }
    );

    it("a run on a thread with nothing pending reads no state", async () => {
      serve(stateWith({ messages: [message("h0")] }));
      const orch = await openThread();

      mockRun([
        {
          event: "values",
          data: { messages: [message("h0"), message("a0", "ai")] },
        },
      ]);
      await orch.submit({ messages: [] });

      expect(getState()).toHaveBeenCalledTimes(1);
      orch.dispose();
    });

    it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
      "a failed read after a run puts no error on the thread opened since (fetchStateHistory: $fetchStateHistory)",
      async ({ fetchStateHistory }) => {
        serve(interrupted());
        const orch = await openThread({ fetchStateHistory });
        let failRead!: (error: Error) => void;
        reads(fetchStateHistory).mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            failRead = reject;
          })
        );
        const answered = [message("h0"), message("a0", "ai")];

        mockRun([{ event: "values", data: { messages: answered } }]);
        const run = orch.submit(
          { messages: [] },
          { command: { resume: "yes" } }
        );
        await vi.waitFor(() =>
          expect(reads(fetchStateHistory)).toHaveBeenCalledTimes(2)
        );
        serve(stateWith({ messages: [message("other")] }));
        orch.switchThread("t2");
        await vi.waitFor(() =>
          expect(orch.messages).toEqual([message("other")])
        );
        failRead(new Error("offline"));
        await run;
        await flushMicrotasks();

        expect(orch.threadId).toBe("t2");
        expect(orch.historyData.error).toBeUndefined();
        expect(orch.error).toBeUndefined();
        orch.dispose();
      }
    );

    it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
      "a failed read after a run still finishes the run (fetchStateHistory: $fetchStateHistory)",
      async ({ fetchStateHistory }) => {
        const onFinish = vi.fn(() => {});
        serve(interrupted());
        const orch = await openThread({
          fetchStateHistory,
          onFinish,
          onError: vi.fn(),
        });
        getState().mockRejectedValue(new Error("offline"));
        getHistory().mockRejectedValue(new Error("offline"));
        const answered = [message("h0"), message("a0", "ai")];

        mockRun([{ event: "values", data: { messages: answered } }]);
        await orch.submit({ messages: [] }, { command: { resume: "yes" } });

        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(orch.streamError).toBeUndefined();
        expect(orch.messages).toEqual(answered);
        orch.dispose();
      }
    );

    it.each(answeringRuns)(
      "a failed read after a run reports no error without history ($via)",
      async ({ run }) => {
        const onError = vi.fn();
        serve(interrupted());
        const orch = await openThread({ onError });
        getState().mockRejectedValue(new Error("offline"));

        await run(orch, [
          {
            event: "values",
            data: { messages: [message("h0"), message("a0", "ai")] },
          },
        ]);

        expect(orch.error).toBeUndefined();
        expect(onError).not.toHaveBeenCalled();
        orch.dispose();
      }
    );
  });

  describe("thread state after stop", () => {
    type StreamEvents = Array<{ event: string; data: unknown }>;

    const message = (id: string, type = "human") => ({ id, content: id, type });
    const stateWith = (
      values: TestState,
      extra: Record<string, unknown> = {}
    ) => ({ ...createThreadState(values), ...extra });
    const interrupted = () =>
      stateWith(
        { messages: [message("h0")] },
        {
          next: ["review"],
          tasks: [
            {
              id: "task-1",
              name: "review",
              error: null,
              interrupts: [{ id: "int-1", value: "approve?" }],
            },
          ],
        }
      );
    const cancelledRun = () =>
      stateWith(
        { messages: [message("h0")] },
        {
          next: ["agent"],
          tasks: [
            {
              id: "task-2",
              name: "agent",
              error: "CancelledError()",
              interrupts: [],
            },
          ],
        }
      );

    const getState = () => client.threads.getState as Mock;
    const getHistory = () => client.threads.getHistory as Mock;
    const reads = (fetchStateHistory: boolean) =>
      fetchStateHistory ? getHistory() : getState();
    const serve = (state: Record<string, unknown>) => {
      getState().mockResolvedValue(state);
      getHistory().mockResolvedValue([state]);
    };
    const deferRead = (fetchStateHistory: boolean) => {
      let resolve!: (value: unknown) => void;
      const read = new Promise((r) => {
        resolve = r;
      });
      reads(fetchStateHistory).mockReturnValueOnce(read);
      return (state: ReturnType<typeof stateWith>) =>
        resolve(fetchStateHistory ? [state] : state);
    };

    const streamOf = (
      events: StreamEvents,
      signal: AbortSignal,
      hang: boolean
    ) => ({
      async *[Symbol.asyncIterator]() {
        yield* events;
        if (!hang) return;
        await new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort);
        });
      },
    });
    const mockRun = (events: StreamEvents, { hang = false } = {}) => {
      (client.runs.stream as Mock).mockImplementationOnce(
        (
          _threadId: string,
          _assistantId: string,
          payload: { signal: AbortSignal }
        ) => streamOf(events, payload.signal, hang)
      );
    };
    const mockJoin = (events: StreamEvents, { hang = false } = {}) => {
      (client.runs.joinStream as Mock).mockImplementationOnce(
        (_threadId: string, _runId: string, payload: { signal: AbortSignal }) =>
          streamOf(events, payload.signal, hang)
      );
    };

    const openThread = async (
      options?: Partial<AnyStreamOptions<TestState>>,
      threadId: string | undefined = "t1"
    ) => {
      const orch = new StreamOrchestrator<TestState>(
        createOptions(options),
        accessors
      );
      orch.initThreadId(threadId);
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));
      return orch;
    };

    it.each([
      {
        label: "an existing thread",
        threadId: "t1",
        opened: [message("h0"), message("a0", "ai")],
      },
      { label: "a new chat", threadId: undefined, opened: [] },
    ])(
      "stop keeps the turns of this session on $label",
      async ({ threadId, opened }) => {
        const saved = [
          ...opened,
          message("h1"),
          message("a1", "ai"),
          message("h2"),
        ];
        serve(stateWith({ messages: opened }));
        const orch = await openThread({}, threadId);
        serve(stateWith({ messages: saved }));

        mockRun([{ event: "values", data: { messages: saved.slice(0, -1) } }]);
        await orch.submit({ messages: [] });
        mockRun(
          [
            {
              event: "values",
              data: { messages: [...saved, message("a2", "ai")] },
            },
          ],
          { hang: true }
        );
        const running = orch.submit({ messages: [] });
        await flushMicrotasks();
        await orch.stop();

        expect(orch.messages).toEqual(saved);
        await running;
        orch.dispose();
      }
    );

    it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
      "stop shows no error or breakpoint from the cancel (fetchStateHistory: $fetchStateHistory)",
      async ({ fetchStateHistory }) => {
        serve(interrupted());
        const orch = await openThread({ fetchStateHistory });
        serve(cancelledRun());

        mockRun([], { hang: true });
        const running = orch.submit(
          { messages: [] },
          { command: { resume: "yes" } }
        );
        await flushMicrotasks();
        await orch.stop();

        expect(orch.interrupts).toEqual([]);
        expect(orch.error).toBeUndefined();
        expect(orch.messages).toEqual([message("h0")]);
        await running;
        orch.dispose();
      }
    );

    it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
      "stop applies onStop edits to the state read after it (fetchStateHistory: $fetchStateHistory)",
      async ({ fetchStateHistory }) => {
        serve(stateWith({ messages: [message("h0")] }));
        const orch = await openThread({
          fetchStateHistory,
          onStop: ({ mutate }) =>
            mutate((prev) => ({ ...prev, count: (prev.count ?? 0) + 1 })),
        });
        const saved = [message("h0"), message("h1")];
        serve(stateWith({ messages: saved }));

        mockRun([{ event: "values", data: { messages: saved } }], {
          hang: true,
        });
        const running = orch.submit({ messages: [] });
        await flushMicrotasks();
        await orch.stop();

        expect(orch.values).toEqual({ messages: saved, count: 1 });
        await running;
        orch.dispose();
      }
    );

    it("a failed read after stop keeps the screen and shows no error", async () => {
      const onError = vi.fn();
      serve(stateWith({ messages: [message("h0")] }));
      const orch = await openThread({ onError });
      getState().mockRejectedValue(new Error("offline"));

      const streamed = [message("h0"), message("h1")];
      mockRun([{ event: "values", data: { messages: streamed } }], {
        hang: true,
      });
      const running = orch.submit({ messages: [] });
      await flushMicrotasks();
      await orch.stop();

      expect(orch.messages).toEqual(streamed);
      expect(orch.error).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      await running;
      orch.dispose();
    });

    it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
      "a thread switch during the read after stop drops the read (fetchStateHistory: $fetchStateHistory)",
      async ({ fetchStateHistory }) => {
        serve(stateWith({ messages: [message("h0")] }));
        const orch = await openThread({ fetchStateHistory });
        const finishRead = deferRead(fetchStateHistory);

        mockRun([{ event: "values", data: { messages: [message("h0")] } }], {
          hang: true,
        });
        const running = orch.submit({ messages: [] });
        await flushMicrotasks();
        const stopping = orch.stop();
        await flushMicrotasks();
        orch.switchThread(null);
        finishRead(stateWith({ messages: [message("h0"), message("h1")] }));
        await stopping;

        expect(orch.messages).toEqual([]);
        expect(orch.historyData.data).toBeUndefined();
        await running;
        orch.dispose();
      }
    );

    it.each([
      { fetchStateHistory: false, multitaskStrategy: undefined },
      { fetchStateHistory: true, multitaskStrategy: undefined },
      { fetchStateHistory: false, multitaskStrategy: "interrupt" as const },
    ])(
      "stop does not overwrite a run queued before it (fetchStateHistory: $fetchStateHistory, multitaskStrategy: $multitaskStrategy)",
      async ({ fetchStateHistory, multitaskStrategy }) => {
        serve(stateWith({ messages: [message("h0")] }));
        const orch = await openThread({ fetchStateHistory });
        const finishRead = deferRead(fetchStateHistory);

        mockRun(
          [
            {
              event: "values",
              data: { messages: [message("h0"), message("h1")] },
            },
          ],
          { hang: true }
        );
        const running = orch.submit({ messages: [] });
        await flushMicrotasks();
        const queued = [message("h0"), message("h2")];
        mockRun([{ event: "values", data: { messages: queued } }], {
          hang: true,
        });
        mockJoin([{ event: "values", data: { messages: queued } }], {
          hang: true,
        });
        void orch.submit({ messages: [] }, { multitaskStrategy });
        await flushMicrotasks();
        const stopping = orch.stop();
        await vi.waitFor(() => expect(orch.messages).toEqual(queued));
        finishRead(stateWith({ messages: [message("h0"), message("h1")] }));
        await stopping;

        expect(orch.messages).toEqual(queued);
        orch.dispose();
        await running;
      }
    );

    it("stop does not overwrite a run that starts and ends during the read", async () => {
      serve(stateWith({ messages: [message("h0")] }));
      const orch = await openThread();
      const finishRead = deferRead(false);

      mockRun([{ event: "values", data: { messages: [message("h0")] } }], {
        hang: true,
      });
      const running = orch.submit({ messages: [] });
      await flushMicrotasks();
      const stopping = orch.stop();
      await running;
      const next = [message("h0"), message("h-next")];
      mockRun([{ event: "values", data: { messages: next } }]);
      await orch.submit({ messages: [] });
      finishRead(stateWith({ messages: [message("h0")] }));
      await stopping;

      expect(orch.messages).toEqual(next);
      orch.dispose();
    });

    it("dispose during a run reads no state", async () => {
      serve(stateWith({ messages: [message("h0")] }));
      const orch = await openThread();

      mockRun([{ event: "values", data: { messages: [message("h0")] } }], {
        hang: true,
      });
      const running = orch.submit({ messages: [] });
      await flushMicrotasks();
      orch.dispose();
      await running;
      await flushMicrotasks();

      expect(getState()).toHaveBeenCalledTimes(1);
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

    it("does not fetch subagent history when fetchStateHistory is false", async () => {
      const values = createSubagentStateValues();
      (client.threads.getState as ReturnType<typeof vi.fn>).mockResolvedValue(
        createThreadState(values)
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({
          fetchStateHistory: false,
          filterSubagentMessages: true,
        }),
        accessors
      );

      orch.initThreadId("t1");

      await vi.waitFor(() => {
        expect(orch.historyData.isLoading).toBe(false);
      });

      expect(orch.reconstructSubagentsIfNeeded()).toBeNull();
      expect(orch.subagents.size).toBe(1);
      expect(client.threads.getHistory).not.toHaveBeenCalled();

      orch.dispose();
    });

    it("uses fetchStateHistory limit for subagent history discovery", async () => {
      const values = createSubagentStateValues();
      (client.threads.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(
        [createThreadState(values)]
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions({
          fetchStateHistory: { limit: 2 },
          filterSubagentMessages: true,
        }),
        accessors
      );

      orch.initThreadId("t1");

      await vi.waitFor(() => {
        expect(orch.historyData.isLoading).toBe(false);
      });

      (client.threads.getHistory as ReturnType<typeof vi.fn>).mockClear();

      const controller = orch.reconstructSubagentsIfNeeded();

      await vi.waitFor(() => {
        expect(client.threads.getHistory).toHaveBeenCalledWith(
          "t1",
          expect.objectContaining({ limit: 2 })
        );
      });

      controller?.abort();
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

describe("StreamOrchestrator.joinStream", () => {
  it("replays the run only when it joins from the first event", async () => {
    const orch = new StreamOrchestrator<TestState>(
      createOptions(),
      createAccessors(createMockClient())
    );
    orch.setThreadId("t1");
    const start = vi.spyOn(orch.stream, "start").mockResolvedValue();

    await orch.joinStream("run-1");
    await orch.joinStream("run-1", "5");

    expect(start.mock.calls.map((call) => call[1].isReplaying)).toEqual([
      true,
      false,
    ]);
    orch.dispose();
  });
});
