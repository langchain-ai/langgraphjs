import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  StreamOrchestrator,
  type OrchestratorAccessors,
  type StreamOrchestratorOptions,
} from "./orchestrator.js";
import type { AnyStreamOptions } from "./types.js";
import type { Client } from "../client.js";
import type { HeadlessToolImplementation } from "../headless-tools.js";
import { HumanMessage } from "@langchain/core/messages";

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
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ status: "success" }),
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
  overrides?: Partial<StreamOrchestratorOptions<TestState>>
): StreamOrchestratorOptions<TestState> {
  return {
    assistantId: "test-assistant",
    ...overrides,
  } as StreamOrchestratorOptions<TestState>;
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

  describe("strict resume", () => {
    it("passes strictResume from submit to the run", async () => {
      (client.runs.stream as Mock).mockImplementation(() =>
        (async function* () {})()
      );
      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");
      await vi.waitFor(() => expect(orch.historyData.isLoading).toBe(false));

      await orch.submit(
        { messages: [] },
        { command: { resume: "yes" }, strictResume: true }
      );

      orch.dispose();
      expect((client.runs.stream as Mock).mock.calls[0][2]).toMatchObject({
        strictResume: true,
      });
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

    it("queues a submit made while streaming with the same stream modes", async () => {
      let submitSignal: AbortSignal | undefined;
      (client.runs.stream as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _threadId: string,
          _assistantId: string,
          payload: { signal: AbortSignal }
        ) => {
          submitSignal = payload.signal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { event: "values" as const, data: { messages: [] } };
              await new Promise<never>((_resolve, reject) => {
                submitSignal?.addEventListener("abort", () => {
                  const err = new Error("The operation was aborted");
                  err.name = "AbortError";
                  reject(err);
                });
              });
            },
          };
        }
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");
      orch.trackStreamMode("messages-tuple");

      const firstSubmit = orch.submit({ messages: [] });
      await flushMicrotasks();
      expect(orch.isLoading).toBe(true);

      await orch.submit({ messages: [] });

      expect(orch.queueSize).toBe(1);
      expect(client.runs.create).toHaveBeenCalledWith(
        "t1",
        "test-assistant",
        expect.objectContaining({
          multitaskStrategy: "enqueue",
          streamMode: expect.arrayContaining(["values", "messages-tuple"]),
        })
      );

      await orch.stop();
      await firstSubmit;
      orch.dispose();
    });

    it("forwards multitaskStrategy 'reject' while streaming and reports the server error", async () => {
      let submitSignal: AbortSignal | undefined;
      (client.runs.stream as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _threadId: string,
          _assistantId: string,
          payload: { signal: AbortSignal }
        ) => {
          submitSignal = payload.signal;
          return {
            async *[Symbol.asyncIterator]() {
              yield { event: "values" as const, data: { messages: [] } };
              await new Promise<never>((_resolve, reject) => {
                submitSignal?.addEventListener("abort", () => {
                  const err = new Error("The operation was aborted");
                  err.name = "AbortError";
                  reject(err);
                });
              });
            },
          };
        }
      );
      const conflict = new Error("HTTP 409: Thread is busy");
      (client.runs.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        conflict
      );

      const onError = vi.fn();
      const submitOnError = vi.fn();
      const orch = new StreamOrchestrator<TestState>(
        createOptions({ onError }),
        accessors
      );
      orch.initThreadId("t1");

      const firstSubmit = orch.submit({ messages: [] });
      await vi.waitFor(() => {
        expect(orch.isLoading).toBe(true);
      });

      await orch.submit(
        { messages: [] },
        { multitaskStrategy: "reject", onError: submitOnError }
      );

      expect(client.runs.create).toHaveBeenCalledWith(
        "t1",
        "test-assistant",
        expect.objectContaining({ multitaskStrategy: "reject" })
      );
      expect(onError).toHaveBeenCalledWith(conflict, undefined);
      expect(submitOnError).toHaveBeenCalledWith(conflict, undefined);
      expect(orch.queueSize).toBe(0);

      await orch.stop();
      await firstSubmit;
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

  describe("joinStream of a live run", () => {
    function createControlledStream() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release,
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { event: "values" as const, data: { messages: [] } };
            await released;
          },
        },
      };
    }

    function createAbortableStream(signal: AbortSignal) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { event: "values" as const, data: { messages: [] } };
          await new Promise<never>((_resolve, reject) => {
            const abort = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort);
          });
        },
      };
    }

    function trackLoadingStarts(orch: StreamOrchestrator<TestState>) {
      const starts = { count: 0 };
      let wasLoading = orch.isLoading;
      orch.subscribe(() => {
        if (orch.isLoading && !wasLoading) starts.count += 1;
        wasLoading = orch.isLoading;
      });
      return starts;
    }

    it("does not rejoin a run already joined by reconnect", async () => {
      const { stream, release } = createControlledStream();
      (client.runs.joinStream as ReturnType<typeof vi.fn>).mockReturnValue(
        stream
      );
      const storage = {
        getItem: vi.fn().mockReturnValue("run-1"),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      // Run metadata storage is only resolved in a browser.
      vi.stubGlobal("window", {});

      const orch = new StreamOrchestrator<TestState>(
        createOptions({ reconnectOnMount: () => storage }),
        accessors
      );
      orch.initThreadId("t1");
      const loadingStarts = trackLoadingStarts(orch);

      expect(orch.tryReconnect()).toBe(true);
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));

      const secondJoin = orch.joinStream("run-1");
      release();
      await secondJoin;
      await vi.waitFor(() => expect(orch.isLoading).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.runs.joinStream).toHaveBeenCalledTimes(1);
      expect(orch.isLoading).toBe(false);
      expect(loadingStarts.count).toBe(1);

      orch.dispose();
      vi.unstubAllGlobals();
    });

    it("does not join the run it is streaming from its own submit", async () => {
      const { stream, release } = createControlledStream();
      (client.runs.stream as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _threadId: string,
          _assistantId: string,
          payload: { onRunCreated?: (params: { run_id: string }) => void }
        ) => {
          payload.onRunCreated?.({ run_id: "run-1" });
          return stream;
        }
      );

      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");
      const loadingStarts = trackLoadingStarts(orch);

      const submitted = orch.submit({ messages: [] });
      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());

      const join = orch.joinStream("run-1");
      release();
      await Promise.all([submitted, join]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.runs.joinStream).not.toHaveBeenCalled();
      expect(orch.isLoading).toBe(false);
      expect(loadingStarts.count).toBe(1);

      orch.dispose();
    });

    it("still joins a different run after the current one", async () => {
      const first = createControlledStream();
      const second = createControlledStream();
      (client.runs.joinStream as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(first.stream)
        .mockReturnValueOnce(second.stream);

      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      const joinFirst = orch.joinStream("run-1");
      const joinSecond = orch.joinStream("run-2");
      first.release();
      second.release();
      await Promise.all([joinFirst, joinSecond]);

      expect(client.runs.joinStream).toHaveBeenCalledTimes(2);
      expect(client.runs.joinStream).toHaveBeenNthCalledWith(
        2,
        "t1",
        "run-2",
        expect.anything()
      );

      orch.dispose();
    });

    it("joins a run again right after stop() aborted its stream", async () => {
      const rejoined = createControlledStream();
      (client.runs.joinStream as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(
          (
            _threadId: string,
            _runId: string,
            payload: { signal: AbortSignal }
          ) => createAbortableStream(payload.signal)
        )
        .mockReturnValueOnce(rejoined.stream);

      const orch = new StreamOrchestrator<TestState>(
        createOptions(),
        accessors
      );
      orch.initThreadId("t1");

      void orch.joinStream("run-1");
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      void orch.stop();
      const rejoin = orch.joinStream("run-1");
      await vi.waitFor(() =>
        expect(client.runs.joinStream).toHaveBeenCalledTimes(2)
      );

      const thirdJoin = orch.joinStream("run-1");
      rejoined.release();
      await Promise.all([rejoin, thirdJoin]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.runs.joinStream).toHaveBeenCalledTimes(2);

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

describe("StreamOrchestrator runs", () => {
  type RunEvent = { event: string; data: unknown };
  type RunsStreamPayload = {
    signal: AbortSignal;
    onRunCreated?: (run: { run_id: string }) => void;
  };

  let client: Client;

  beforeEach(() => {
    client = createMockClient();
  });

  function orchestrator(options?: Partial<StreamOrchestratorOptions<TestState>>) {
    return new StreamOrchestrator<TestState>(
      createOptions(options),
      createAccessors(client)
    );
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function openUntil(signal: AbortSignal, ended?: Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      void ended?.then(resolve);
      const abort = () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
    });
  }

  function mockRunStream(
    events: RunEvent[] = [{ event: "values", data: { messages: [] } }],
    options: { created?: Promise<void>; ended?: Promise<void> } = {}
  ) {
    (client.runs.stream as Mock).mockImplementation(
      (_threadId: string, _assistantId: string, payload: RunsStreamPayload) => ({
        async *[Symbol.asyncIterator]() {
          await Promise.race([options.created, openUntil(payload.signal)]);
          payload.onRunCreated?.({ run_id: "run-1" });
          yield* events;
          await openUntil(payload.signal, options.ended);
        },
      })
    );
  }

  function mockJoinStream(events: RunEvent[] = [], ended?: Promise<void>) {
    (client.runs.joinStream as Mock).mockImplementation(
      (_threadId: string, _runId: string, payload: RunsStreamPayload) => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
          await openUntil(payload.signal, ended);
        },
      })
    );
  }

  const message = (id: string) => ({ id, content: id, type: "human" });

  const streamInput = (call = 0) =>
    (client.runs.stream as Mock).mock.calls[call][2].input;

  describe("durableRuns", () => {
    it.each([
      { durableRuns: undefined, streamResumable: true, onDisconnect: "continue" },
      { durableRuns: false, streamResumable: false, onDisconnect: "cancel" },
    ])(
      "durableRuns $durableRuns: creates a new thread, then its run with onDisconnect $onDisconnect",
      async ({ durableRuns, streamResumable, onDisconnect }) => {
        mockRunStream(undefined, { ended: Promise.resolve() });
        const orch = orchestrator({ durableRuns });

        await orch.submit({ messages: [] });

        expect(client.threads.create).toHaveBeenCalledOnce();
        expect(client.runs.stream).toHaveBeenCalledWith(
          "new-thread-1",
          "test-assistant",
          expect.objectContaining({ streamResumable, onDisconnect })
        );
        orch.dispose();
      }
    );

    it("stop() cancels the run it streams, which then ends stopped", async () => {
      mockRunStream();
      const onRunEnd = vi.fn();
      const orch = orchestrator({ onRunEnd });
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await orch.stop();

      expect(client.runs.cancel).toHaveBeenCalledExactlyOnceWith("t1", "run-1");
      await vi.waitFor(() =>
        expect(onRunEnd).toHaveBeenCalledWith({
          runId: "run-1",
          reason: "stopped",
        })
      );
      orch.dispose();
    });

    it("stop() before the run's id arrives stops at once and cancels the run once it does", async () => {
      const created = deferred();
      mockRunStream(undefined, { created: created.promise });
      const orch = orchestrator();
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());
      await orch.stop();
      await vi.waitFor(() => expect(orch.isLoading).toBe(false));
      expect(client.runs.cancel).not.toHaveBeenCalled();

      created.resolve();
      await vi.waitFor(() =>
        expect(client.runs.cancel).toHaveBeenCalledExactlyOnceWith(
          "t1",
          "run-1"
        )
      );
      orch.dispose();
    });

    it("stop() before the run's request is sent sends none, also after a thread switch", async () => {
      const thread = deferred();
      (client.threads.create as Mock).mockReturnValueOnce(
        thread.promise.then(() => ({ thread_id: "t-new" }))
      );
      mockRunStream(undefined, { created: new Promise(() => {}) });
      const orch = orchestrator();

      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(client.threads.create).toHaveBeenCalled());
      orch.switchThread("t2");
      await orch.stop();
      thread.resolve();
      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());

      const request: AbortSignal = (client.runs.stream as Mock).mock.calls[0][2]
        .signal;
      expect(request.aborted).toBe(true);
      orch.dispose();
    });

    it("stop() before an id that never arrives stops at once and closes the request after 5 s", async () => {
      vi.useFakeTimers();
      try {
        mockRunStream(undefined, { created: new Promise<void>(() => {}) });
        const orch = orchestrator();
        orch.initThreadId("t1");
        void orch.submit({ messages: [] });
        await vi.advanceTimersByTimeAsync(0);
        const request: AbortSignal = (client.runs.stream as Mock).mock
          .calls[0][2].signal;

        await orch.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(orch.isLoading).toBe(false);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(request.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(request.aborted).toBe(true);
        expect(client.runs.cancel).not.toHaveBeenCalled();
        orch.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop() cancels the run it found after a load", async () => {
      (client.runs.list as Mock).mockResolvedValue([{ run_id: "run-9" }]);
      mockJoinStream();
      const orch = orchestrator();
      orch.initThreadId("t1");

      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await orch.stop();

      expect(client.runs.cancel).toHaveBeenCalledExactlyOnceWith("t1", "run-9");
      orch.dispose();
    });

    it("stop() leaves a run the app joined going", async () => {
      mockJoinStream();
      const orch = orchestrator();
      orch.initThreadId("t1");
      await orch.hydrationPromise;

      void orch.joinStream("run-9");
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await orch.stop();

      expect(orch.isLoading).toBe(false);
      expect(client.runs.cancel).not.toHaveBeenCalled();
      orch.dispose();
    });

    it.each([
      {
        name: "stop({ cancel: false })",
        end: (orch: StreamOrchestrator<TestState>) =>
          orch.stop({ cancel: false }),
      },
      {
        name: "dispose()",
        end: (orch: StreamOrchestrator<TestState>) => orch.dispose(),
      },
    ])("$name leaves the run going", async ({ end }) => {
      mockRunStream();
      const orch = orchestrator();
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await end(orch);
      await flushMicrotasks();

      expect(client.runs.cancel).not.toHaveBeenCalled();
      orch.dispose();
    });
  });

  describe("its own run", () => {
    it("streams once when a join of it arrives before its id", async () => {
      const created = deferred();
      mockRunStream(undefined, {
        created: created.promise,
        ended: Promise.resolve(),
      });
      const orch = orchestrator();
      orch.initThreadId("t1");

      const submitted = orch.submit({ messages: [] });
      const joined = orch.joinStream("run-1");
      created.resolve();
      await Promise.all([submitted, joined]);

      expect(client.runs.joinStream).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("sends a server-queued run only once the run being submitted exists", async () => {
      const created = deferred();
      mockRunStream(undefined, { created: created.promise });
      const orch = orchestrator();
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });
      const queued = orch.submit({ messages: [] });
      await flushMicrotasks(10);
      expect(client.runs.create).not.toHaveBeenCalled();

      created.resolve();
      await queued;
      expect(client.runs.create).toHaveBeenCalledOnce();
      await orch.stop();
      orch.dispose();
    });

    it("turns off the v3 marker on every run it creates", async () => {
      mockRunStream();
      const config = { configurable: { user_id: "u1" } };
      const orch = orchestrator();
      orch.initThreadId("t1");

      void orch.submit({ messages: [] }, { config });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await orch.submit({ messages: [] }, { config });

      const runConfig = {
        configurable: { user_id: "u1", __event_streaming_v2: false },
      };
      expect((client.runs.stream as Mock).mock.calls[0][2].config).toEqual(
        runConfig
      );
      expect((client.runs.create as Mock).mock.calls[0][2].config).toEqual(
        runConfig
      );
      await orch.stop();
      orch.dispose();
    });

    it("leaves the v3 marker off a run that sends context, which the server would refuse", async () => {
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.submit({ messages: [] }, { context: { user_id: "u1" } });

      expect((client.runs.stream as Mock).mock.calls[0][2]).toMatchObject({
        config: undefined,
        context: { user_id: "u1" },
      });
      orch.dispose();
    });

    it("passes the reconnect options to its run streams and joins", async () => {
      const reconnect = {
        maxReconnectAttempts: 2,
        reconnectDelayMs: () => 10,
        onReconnect: vi.fn(),
        onConnected: vi.fn(),
        streamIdleReconnect: 0,
      };
      mockRunStream(undefined, { ended: Promise.resolve() });
      mockJoinStream([], Promise.resolve());
      const orch = orchestrator(reconnect);
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });
      await orch.joinStream("run-2");

      expect((client.runs.stream as Mock).mock.calls[0][2]).toMatchObject(
        reconnect
      );
      expect((client.runs.joinStream as Mock).mock.calls[0][2]).toMatchObject(
        reconnect
      );
      orch.dispose();
    });
  });

  describe("onRunEnd", () => {
    const end = (status: string) => ({ event: "end", data: { status } });
    const error = (name: string) => ({
      event: "error",
      data: { error: name, message: name },
    });

    it.each([
      { name: "an end event", events: [end("success")], reason: "success" },
      {
        name: "a root interrupt",
        events: [{ event: "updates", data: { __interrupt__: [] } }, end("success")],
        reason: "interrupt",
      },
      { name: "a timeout", events: [end("timeout")], reason: "error" },
      { name: "an error event", events: [error("ValueError")], reason: "error" },
      { name: "a cancel", events: [error("UserInterrupt")], reason: "stopped" },
    ])("says $reason after $name", async ({ events, reason }) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      mockRunStream(events, { ended: Promise.resolve() });
      const onRunEnd = vi.fn();
      const orch = orchestrator({ onRunEnd });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      await vi.waitFor(() =>
        expect(onRunEnd).toHaveBeenCalledExactlyOnceWith({
          runId: "run-1",
          reason,
        })
      );
      expect(client.runs.get).not.toHaveBeenCalled();
      orch.dispose();
    });

    it.each([
      { name: "the run's status", read: () => Promise.resolve({ status: "error" }), reason: "error" },
      {
        name: "a 404 for a rolled back run",
        read: () => Promise.reject(Object.assign(new Error(), { status: 404 })),
        reason: "stopped",
      },
    ])("without an end event, takes $name", async ({ read, reason }) => {
      mockRunStream(undefined, { ended: Promise.resolve() });
      (client.runs.get as Mock).mockImplementation(read);
      const onRunEnd = vi.fn();
      const orch = orchestrator({ onRunEnd });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      await vi.waitFor(() =>
        expect(onRunEnd).toHaveBeenCalledExactlyOnceWith({
          runId: "run-1",
          reason,
        })
      );
      expect(client.runs.get).toHaveBeenCalledWith("t1", "run-1");
      orch.dispose();
    });
  });

  describe("thread loads", () => {
    it("hydrationPromise settles once the thread's state is read", async () => {
      let read!: (state: unknown) => void;
      (client.threads.getState as Mock).mockReturnValueOnce(
        new Promise((resolve) => {
          read = resolve;
        })
      );
      const orch = orchestrator();
      orch.initThreadId("t1");
      let settled = false;
      void orch.hydrationPromise.then(() => {
        settled = true;
      });

      await flushMicrotasks();
      expect(settled).toBe(false);
      read(createThreadState({ messages: [message("m1")] }));
      await orch.hydrationPromise;

      expect(settled).toBe(true);
      expect(orch.messages).toEqual([message("m1")]);
      orch.dispose();
    });

    it("hydrate() reads the thread again and shows it over values an earlier run left", async () => {
      mockRunStream(
        [{ event: "values", data: { messages: [message("streamed")] } }],
        { ended: Promise.resolve() }
      );
      const orch = orchestrator();
      orch.initThreadId("t1");
      await orch.hydrationPromise;
      await orch.submit({ messages: [] });
      expect(orch.messages).toEqual([message("streamed")]);

      (client.threads.getState as Mock).mockResolvedValueOnce(
        createThreadState({ messages: [message("saved")] })
      );
      await orch.hydrate();

      expect(orch.messages).toEqual([message("saved")]);
      orch.dispose();
    });

    it("hydrate() with another thread switches to it", async () => {
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.hydrate("t2");

      expect(orch.threadId).toBe("t2");
      expect(client.threads.getState).toHaveBeenLastCalledWith("t2");
      orch.dispose();
    });

    it("joins the thread's running run from the loaded checkpoint, naming no stream mode", async () => {
      (client.runs.list as Mock).mockResolvedValue([{ run_id: "run-9" }]);
      mockJoinStream([], Promise.resolve());
      const orch = orchestrator();

      orch.initThreadId("t1");
      await orch.hydrationPromise;

      expect(client.runs.list).toHaveBeenCalledWith("t1", {
        status: "running",
        limit: 1,
      });
      expect(client.runs.joinStream).toHaveBeenCalledExactlyOnceWith(
        "t1",
        "run-9",
        expect.objectContaining({
          lastEventId: "-1",
          checkpointId: "cp1",
          streamMode: undefined,
        })
      );
      orch.dispose();
    });

    it("with durableRuns false, loads a thread without asking for its runs", async () => {
      const orch = orchestrator({ durableRuns: false });

      orch.initThreadId("t1");
      await orch.hydrationPromise;

      expect(client.runs.list).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("reads the thread again when its run ended during the load", async () => {
      (client.threads.getState as Mock).mockResolvedValueOnce({
        ...createThreadState({ messages: [] }),
        next: ["agent"],
      });
      const orch = orchestrator();

      orch.initThreadId("t1");
      await orch.hydrationPromise;

      expect(client.runs.joinStream).not.toHaveBeenCalled();
      expect(client.threads.getState).toHaveBeenCalledTimes(2);
      orch.dispose();
    });
  });

  describe("respond()", () => {
    const pendingState = (...ids: string[]) => ({
      ...createThreadState({ messages: [] }),
      next: ["review"],
      tasks: [
        {
          id: "task-1",
          name: "review",
          interrupts: ids.map((id) => ({ id, value: { question: id } })),
          checkpoint: null,
          state: null,
          error: null,
        },
      ],
    });

    function streamOptions(call = 0) {
      return (client.runs.stream as Mock).mock.calls[call][2];
    }

    it("answers the newest interrupt shown, by id", async () => {
      (client.threads.getState as Mock).mockResolvedValue(
        pendingState("i1", "i2")
      );
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator();
      orch.initThreadId("t1");
      await orch.hydrationPromise;

      await orch.respond("yes");

      expect(streamOptions()).toMatchObject({
        command: { resume: { i2: "yes" } },
        multitaskStrategy: "enqueue",
        strictResume: true,
      });
      orch.dispose();
    });

    it("with strictResume false, asks for no strict check", async () => {
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.respond("yes", { interruptId: "i1", strictResume: false });

      expect(streamOptions()).toMatchObject({ strictResume: false });
      orch.dispose();
    });

    it("respondAll() sends every answer in one run, with update messages as plain dicts", async () => {
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.respondAll(
        { i1: "a", i2: "b" },
        { update: { messages: [new HumanMessage({ id: "h1", content: "hi" })] } }
      );

      expect(streamOptions().command).toEqual({
        resume: { i1: "a", i2: "b" },
        update: {
          messages: [expect.objectContaining({ id: "h1", type: "human" })],
        },
        goto: undefined,
      });
      expect(streamOptions().command.update.messages[0]).not.toBeInstanceOf(
        HumanMessage
      );
      orch.dispose();
    });

    it.each([
      { name: "no thread", thread: undefined, error: "No active thread" },
      { name: "no interrupt", thread: "t1", error: "No pending interrupt" },
    ])("throws with $name to answer", async ({ thread, error }) => {
      const orch = orchestrator();
      orch.initThreadId(thread);
      await orch.hydrationPromise;

      await expect(orch.respond("yes")).rejects.toThrow(error);
      expect(client.runs.stream).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("resolves once its run is created, while the run still streams", async () => {
      const created = deferred();
      mockRunStream(undefined, { created: created.promise });
      const orch = orchestrator();
      orch.initThreadId("t1");
      let resolved = false;

      const responded = orch
        .respond("yes", { interruptId: "i1" })
        .then(() => {
          resolved = true;
        });
      await flushMicrotasks(10);
      expect(resolved).toBe(false);

      created.resolve();
      await responded;
      expect(orch.isLoading).toBe(true);
      await orch.stop();
      orch.dispose();
    });

    it("during a run waits in the queue and never interrupts it", async () => {
      mockRunStream([
        { event: "values", data: { messages: [], __interrupt__: [{ id: "i1" }] } },
      ]);
      const orch = orchestrator();
      orch.initThreadId("t1");
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.interrupts).toHaveLength(1));

      await orch.respond("ok");

      expect(client.runs.create).toHaveBeenCalledWith(
        "t1",
        "test-assistant",
        expect.objectContaining({
          command: expect.objectContaining({ resume: { i1: "ok" } }),
          multitaskStrategy: "enqueue",
        })
      );
      expect(client.runs.stream).toHaveBeenCalledOnce();
      expect(orch.isLoading).toBe(true);
      await orch.stop();
      orch.dispose();
    });

    it("hides an answered interrupt, and when the queued answer can't be sent, shows it again and rejects", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      let reject!: (error: Error) => void;
      (client.runs.create as Mock).mockReturnValueOnce(
        new Promise((_resolve, fail) => {
          reject = fail;
        })
      );
      mockRunStream([
        { event: "values", data: { messages: [], __interrupt__: [{ id: "i1" }] } },
      ]);
      const onError = vi.fn();
      const orch = orchestrator({ onError });
      orch.initThreadId("t1");
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.interrupts).toHaveLength(1));

      const responded = orch.respond("ok");
      expect(orch.interrupts).toEqual([]);
      expect(orch.interrupt).toBeUndefined();

      reject(new Error("busy"));
      await expect(responded).rejects.toThrow("busy");
      expect(orch.interrupts.map((interrupt) => interrupt.id)).toEqual(["i1"]);
      expect(onError).toHaveBeenCalled();
      await orch.stop();
      orch.dispose();
    });

    it("shows an answered interrupt again once its run ends with it pending", async () => {
      (client.threads.getState as Mock).mockResolvedValue(pendingState("i1"));
      mockRunStream(
        [{ event: "values", data: { messages: [], __interrupt__: [{ id: "i1" }] } }],
        { ended: Promise.resolve() }
      );
      const orch = orchestrator();
      orch.initThreadId("t1");
      await orch.hydrationPromise;

      await orch.respond("not yet");
      await vi.waitFor(() => expect(orch.isLoading).toBe(false));

      expect(orch.interrupts.map((interrupt) => interrupt.id)).toEqual(["i1"]);
      orch.dispose();
    });

    it("stop() cancels a run respond() started", async () => {
      mockRunStream();
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.respond("yes", { interruptId: "i1" });
      await orch.stop();

      expect(client.runs.cancel).toHaveBeenCalledExactlyOnceWith("t1", "run-1");
      orch.dispose();
    });
  });

  describe("interrupt namespaces", () => {
    it("come from the deepest updates event that raised the interrupt", async () => {
      const raised = { __interrupt__: [{ id: "i1", value: "?" }] };
      mockRunStream([
        { event: "updates|tools:a|tools:b", data: raised },
        { event: "updates|tools:a", data: raised },
        { event: "values", data: { messages: [], ...raised } },
      ]);
      const orch = orchestrator();
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });

      await vi.waitFor(() =>
        expect(orch.interrupts).toEqual([
          expect.objectContaining({ id: "i1", namespace: ["tools:a", "tools:b"] }),
        ])
      );
      await orch.stop();
      orch.dispose();
    });

    it("come from the task's checkpoint for interrupts read from the state", async () => {
      (client.threads.getState as Mock).mockResolvedValue({
        ...createThreadState({ messages: [] }),
        next: ["tools"],
        tasks: [
          {
            id: "task-1",
            name: "tools",
            interrupts: [{ id: "i1", value: "?" }],
            checkpoint: { checkpoint_ns: "tools:abc" },
            state: null,
            error: null,
          },
        ],
      });
      const orch = orchestrator();
      orch.initThreadId("t1");
      await orch.hydrationPromise;

      expect(orch.interrupts).toEqual([
        expect.objectContaining({ id: "i1", namespace: ["tools:abc"] }),
      ]);
      orch.dispose();
    });
  });

  describe("queue: local", () => {
    it("keeps a submit made during a run and sends it once the run ends", async () => {
      const ended = deferred();
      mockRunStream(undefined, { ended: ended.promise });
      const orch = orchestrator({ queue: "local" });
      orch.initThreadId("t1");
      void orch.submit({ messages: [message("first")] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));

      await orch.submit({ messages: [message("second")] });
      expect(orch.queueEntries).toEqual([
        expect.objectContaining({ values: { messages: [message("second")] } }),
      ]);
      expect(client.runs.create).not.toHaveBeenCalled();

      ended.resolve();
      await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalledTimes(2));
      expect(streamInput(1)).toMatchObject({ messages: [message("second")] });
      expect(orch.queueSize).toBe(0);
      orch.dispose();
    });

    it("cancels and clears entries without a request", async () => {
      mockRunStream();
      const orch = orchestrator({ queue: "local" });
      orch.initThreadId("t1");
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));
      await orch.submit({ messages: [] });
      await orch.submit({ messages: [] });

      expect(await orch.cancelQueueItem(orch.queueEntries[0].id)).toBe(true);
      await orch.clearQueue();

      expect(orch.queueSize).toBe(0);
      expect(client.runs.cancel).not.toHaveBeenCalled();
      await orch.stop();
      orch.dispose();
    });

    it("sends a submit with reject to the server, which refuses it", async () => {
      mockRunStream();
      const orch = orchestrator({ queue: "local" });
      orch.initThreadId("t1");
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));

      await orch.submit({ messages: [] }, { multitaskStrategy: "reject" });

      expect(orch.queueSize).toBe(1);
      expect(client.runs.create).toHaveBeenCalledWith(
        "t1",
        "test-assistant",
        expect.objectContaining({ multitaskStrategy: "reject" })
      );
      await orch.stop();
      orch.dispose();
    });
  });

  it("shows a submit's input at once and sends the ids it minted", async () => {
    mockRunStream(undefined, { created: new Promise(() => {}) });
    const orch = orchestrator();
    orch.initThreadId("t1");
    await orch.hydrationPromise;

    void orch.submit({ messages: [{ type: "human", content: "hi" }] } as never);
    await vi.waitFor(() => expect(orch.messages).toHaveLength(1));

    const [shown] = orch.messageInstances;
    expect(shown).toMatchObject({ content: "hi" });
    expect(shown.id).toEqual(expect.any(String));
    expect(streamInput().messages).toEqual([
      expect.objectContaining({ type: "human", content: "hi", id: shown.id }),
    ]);
    orch.dispose();
  });

  it("a submit with its own optimisticValues shows only those and sends its input as it is", async () => {
    mockRunStream(undefined, { created: new Promise(() => {}) });
    const orch = orchestrator();
    orch.initThreadId("t1");
    await orch.hydrationPromise;
    const input = { type: "human", content: "hi" };

    void orch.submit({ messages: [input] } as never, {
      optimisticValues: (prev: TestState) => ({
        ...prev,
        messages: [...(prev.messages ?? []), input],
      }),
    } as never);
    await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());

    expect(orch.messages).toHaveLength(1);
    expect(streamInput().messages).toEqual([input]);
    orch.dispose();
  });

  it("with optimistic false, sends the input as it is and shows nothing early", async () => {
    mockRunStream(undefined, { created: new Promise(() => {}) });
    const orch = orchestrator({ optimistic: false });
    orch.initThreadId("t1");
    await orch.hydrationPromise;
    const input = { type: "human", content: "hi" };

    void orch.submit({ messages: [input] } as never);
    await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalled());

    expect(orch.messages).toHaveLength(0);
    expect(streamInput().messages).toEqual([input]);
    orch.dispose();
  });

  it("a submit with interrupt during a run replaces its stream at once", async () => {
    mockRunStream();
    const orch = orchestrator();
    orch.initThreadId("t1");
    void orch.submit({ messages: [] });
    await vi.waitFor(() => expect(orch.isLoading).toBe(true));

    void orch.submit({ messages: [] }, { multitaskStrategy: "interrupt" });

    await vi.waitFor(() => expect(client.runs.stream).toHaveBeenCalledTimes(2));
    expect(
      (client.runs.stream as Mock).mock.calls[0][2].signal.aborted
    ).toBe(true);
    await orch.stop();
    orch.dispose();
  });

  describe("activate()", () => {
    it("survives StrictMode's remount, and the last release disposes", () => {
      vi.useFakeTimers();
      try {
        const orch = orchestrator();
        const listener = vi.fn();
        orch.subscribe(listener);

        orch.activate()();
        const release = orch.activate();
        vi.runAllTimers();
        orch.setBranch("a");
        expect(listener).toHaveBeenCalledOnce();

        release();
        vi.runAllTimers();
        orch.setBranch("b");
        expect(listener).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("lifecycle and tool events", () => {
    function withInfo(info: () => Promise<unknown>) {
      const read = vi.fn(info);
      (client as unknown as { info: Mock }).info = read;
      return read;
    }
    const lifecycleServer = () =>
      withInfo(() => Promise.resolve({ flags: { stream_lifecycle: true } }));
    const sentModes = (call = 0) =>
      (client.runs.stream as Mock).mock.calls[call][2].streamMode;
    const taskCall = {
      id: "call_1",
      name: "task",
      args: { subagent_type: "researcher", description: "Research" },
    };
    const started = {
      event: "lifecycle|tools:a",
      data: { event: "started", namespace: ["tools:a"], tool_call_id: "call_1" },
    };
    const withTask = {
      event: "updates",
      data: {
        model: {
          messages: [{ id: "ai-1", type: "ai", content: "", tool_calls: [taskCall] }],
        },
      },
    };

    it("two engines on one client read /info once", async () => {
      const read = lifecycleServer();
      orchestrator({ filterSubagentMessages: true }).dispose();
      orchestrator({ onToolEvent: vi.fn() }).dispose();
      await flushMicrotasks();

      expect(read).toHaveBeenCalledOnce();
    });

    it.each([
      { flags: { stream_lifecycle: true }, sent: true },
      { flags: {}, sent: false },
    ])("asks for lifecycle and tools when the server's flags are $flags: $sent", async ({ flags, sent }) => {
      withInfo(() => Promise.resolve({ flags }));
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator({
        filterSubagentMessages: true,
        onToolEvent: vi.fn(),
      });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(sentModes().includes("lifecycle")).toBe(sent);
      expect(sentModes().includes("tools")).toBe(sent);
      orch.dispose();
    });

    it("a failed /info read leaves lifecycle and tools out", async () => {
      withInfo(() => Promise.reject(new Error("no route")));
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(sentModes()).toEqual(["values", "updates"]);
      orch.dispose();
    });

    it.each([
      { status: undefined, again: true },
      { status: 503, again: true },
      { status: 404, again: false },
    ])("a failed /info read with status $status is read again by the next run: $again", async ({ status, again }) => {
      const read = withInfo(() => Promise.reject(Object.assign(new Error("failed"), { status })));
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });
      read.mockResolvedValue({ flags: { stream_lifecycle: true } });
      await orch.submit({ messages: [] });

      expect(read).toHaveBeenCalledTimes(again ? 2 : 1);
      expect(sentModes(1).includes("lifecycle")).toBe(again);
      orch.dispose();
    });

    it("a submit's own streamMode goes as it is", async () => {
      withInfo(() => Promise.resolve({ flags: {} }));
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator();
      orch.initThreadId("t1");

      await orch.submit({ messages: [] }, { streamMode: ["tools"] });

      expect(sentModes()).toContain("tools");
      orch.dispose();
    });

    it("a 422 for lifecycle is retried once without lifecycle and tools", async () => {
      lifecycleServer();
      (client.runs.stream as Mock).mockImplementation(
        (_threadId: string, _assistantId: string, payload: RunsStreamPayload) => ({
          async *[Symbol.asyncIterator]() {
            if ((payload as unknown as { streamMode: string[] }).streamMode.includes("lifecycle")) {
              throw Object.assign(new Error("Unprocessable"), { status: 422 });
            }
            payload.onRunCreated?.({ run_id: "run-1" });
            yield { event: "values", data: { messages: [message("m1")] } };
          },
        })
      );
      const onError = vi.fn();
      const orch = orchestrator({
        filterSubagentMessages: true,
        onToolEvent: vi.fn(),
        onError,
      });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(client.runs.stream).toHaveBeenCalledTimes(2);
      expect(sentModes(0)).toEqual(expect.arrayContaining(["lifecycle", "tools"]));
      expect(sentModes(1)).toEqual(["values", "updates"]);
      expect(onError).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("a queued run refused with a 422 is created again without lifecycle", async () => {
      lifecycleServer();
      const end = deferred();
      mockRunStream(undefined, { ended: end.promise });
      (client.runs.create as Mock)
        .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
        .mockResolvedValueOnce({ run_id: "run-2", created_at: new Date().toISOString() });
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");
      const first = orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));

      await orch.submit({ messages: [] });

      const modes = (client.runs.create as Mock).mock.calls.map((call) => call[2].streamMode);
      expect(modes).toEqual([
        expect.arrayContaining(["lifecycle"]),
        ["values", "updates"],
      ]);
      expect(orch.queueEntries.map((entry) => entry.id)).toEqual(["run-2"]);
      end.resolve();
      await first;
      orch.dispose();
    });

    it("a run cancelled mid-subagent closes it with an error", async () => {
      lifecycleServer();
      mockRunStream(
        [withTask, started, { event: "error", data: { error: "UserInterrupt", message: "" } }],
        { ended: Promise.resolve() }
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      await vi.waitFor(() =>
        expect(orch.getSubagent("call_1")?.status).toBe("error")
      );
      orch.dispose();
    });

    it.each([
      { name: "a stop that doesn't cancel", stop: { cancel: false } },
      { name: "a dropped connection", drop: true },
    ])("$name leaves the run's subagents running", async ({ stop, drop }) => {
      lifecycleServer();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      (client.runs.stream as Mock).mockImplementation(
        (_threadId: string, _assistantId: string, payload: RunsStreamPayload) => ({
          async *[Symbol.asyncIterator]() {
            payload.onRunCreated?.({ run_id: "run-1" });
            yield withTask;
            yield started;
            if (drop) throw new TypeError("network error");
            await openUntil(payload.signal);
          },
        })
      );
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");

      const run = orch.submit({ messages: [] });
      await vi.waitFor(() =>
        expect(orch.getSubagent("call_1")?.status).toBe("running")
      );
      if (stop) await orch.stop(stop);
      await run;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(orch.getSubagent("call_1")?.status).toBe("running");
      expect(client.runs.cancel).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("stop() that cancels the run closes its subagents", async () => {
      lifecycleServer();
      mockRunStream([withTask, started]);
      const orch = orchestrator({ filterSubagentMessages: true });
      orch.initThreadId("t1");

      void orch.submit({ messages: [] });
      await vi.waitFor(() =>
        expect(orch.getSubagent("call_1")?.status).toBe("running")
      );
      await orch.stop();

      expect(orch.getSubagent("call_1")?.status).toBe("error");
      expect(client.runs.cancel).toHaveBeenCalledWith("t1", "run-1");
      orch.dispose();
    });

    it("a paused run leaves its subagent running", async () => {
      lifecycleServer();
      mockRunStream(
        [
          withTask,
          started,
          { event: "updates", data: { __interrupt__: [] } },
          { event: "end", data: { status: "success" } },
        ],
        { ended: Promise.resolve() }
      );
      const onRunEnd = vi.fn();
      const orch = orchestrator({ filterSubagentMessages: true, onRunEnd });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalled());
      expect(orch.getSubagent("call_1")?.status).toBe("running");
      orch.dispose();
    });

    it("hands each event to channel listeners in the 1.x shape", async () => {
      mockRunStream(
        [
          { event: "custom", data: { kind: "stats" } },
          { event: "custom|tools:a", data: 2 },
          { event: "end", data: { status: "success" } },
        ],
        { ended: Promise.resolve() }
      );
      const orch = orchestrator();
      orch.initThreadId("t1");
      const events: unknown[] = [];
      orch.onChannelEvent((event) => events.push(event));

      await orch.submit({ messages: [] });

      expect(events).toEqual([
        {
          method: "custom",
          params: { namespace: [], timestamp: expect.any(Number), data: { payload: { kind: "stats" } } },
        },
        {
          method: "custom",
          params: { namespace: ["tools:a"], timestamp: expect.any(Number), data: { payload: 2 } },
        },
        {
          method: "lifecycle",
          params: { namespace: [], timestamp: expect.any(Number), data: { event: "completed" } },
        },
      ]);
      orch.dispose();
    });

    it("a throwing channel listener doesn't end the stream", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      mockRunStream(
        [
          { event: "custom", data: 1 },
          { event: "values", data: { messages: [message("m1")] } },
        ],
        { ended: Promise.resolve() }
      );
      const onError = vi.fn();
      const orch = orchestrator({ onError });
      orch.initThreadId("t1");
      orch.onChannelEvent(() => {
        throw new Error("listener bug");
      });

      await orch.submit({ messages: [] });

      expect(onError).not.toHaveBeenCalled();
      expect(orch.error).toBeUndefined();
      orch.dispose();
    });
  });

  describe("scoped subagents", () => {
    const flags = { stream_lifecycle: true, stream_namespaces: true };
    function withFlags(serverFlags: Record<string, boolean> | undefined) {
      const read = vi.fn(() =>
        serverFlags == null
          ? Promise.reject(new Error("no route"))
          : Promise.resolve({ flags: serverFlags })
      );
      (client as unknown as { info: Mock }).info = read;
      return read;
    }
    const streamed = (call = 0) =>
      (client.runs.stream as Mock).mock.calls[call][2];
    const joined = (call = 0) =>
      (client.runs.joinStream as Mock).mock.calls[call][2];

    it("a run it creates streams subgraphs, and on a filtering server only the main conversation", async () => {
      withFlags(flags);
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(streamed()).toMatchObject({
        streamSubgraphs: true,
        streamNamespaces: [""],
      });
      expect(streamed().streamMode).toContain("lifecycle");
      orch.dispose();
    });

    it.each([
      { name: "scopedSubagents off", options: {}, serverFlags: flags },
      {
        name: "a server without stream_namespaces",
        options: { scopedSubagents: true },
        serverFlags: { stream_lifecycle: true },
      },
      {
        name: "a submit with streamSubgraphs false",
        options: { scopedSubagents: true },
        serverFlags: flags,
        submit: { streamSubgraphs: false },
      },
    ])("with $name the run's stream asks for no namespace", async ({ options, serverFlags, submit }) => {
      withFlags(serverFlags);
      mockRunStream(undefined, { ended: Promise.resolve() });
      const orch = orchestrator(options);
      orch.initThreadId("t1");

      await orch.submit({ messages: [] }, submit);

      expect(streamed().streamNamespaces).toBeUndefined();
      orch.dispose();
    });

    it("the 422 retry drops the namespace filter too", async () => {
      withFlags(flags);
      (client.runs.stream as Mock).mockImplementation(
        (_threadId: string, _assistantId: string, payload: RunsStreamPayload) => ({
          async *[Symbol.asyncIterator]() {
            if ((payload as unknown as { streamMode: string[] }).streamMode.includes("lifecycle")) {
              throw Object.assign(new Error("Unprocessable"), { status: 422 });
            }
            payload.onRunCreated?.({ run_id: "run-1" });
            yield { event: "values", data: { messages: [] } };
          },
        })
      );
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(streamed(0).streamNamespaces).toEqual([""]);
      expect(streamed(1).streamNamespaces).toBeUndefined();
      orch.dispose();
    });

    it.each([
      { stream_mode: ["values", "lifecycle"], subgraphs: true, namespaces: [""] },
      { stream_mode: ["values"], subgraphs: true, namespaces: undefined },
      { stream_mode: ["values", "lifecycle"], subgraphs: false, namespaces: undefined },
    ])(
      "a joined run with stream_mode $stream_mode and subgraphs $subgraphs streams namespaces $namespaces",
      async ({ stream_mode, subgraphs, namespaces }) => {
        withFlags(flags);
        (client.runs.list as Mock).mockResolvedValue([
          { run_id: "run-9", kwargs: { stream_mode, subgraphs } },
        ]);
        mockJoinStream([], Promise.resolve());
        const orch = orchestrator({ scopedSubagents: true });

        orch.initThreadId("t1");
        await orch.hydrationPromise;
        await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalled());

        expect(joined().streamNamespaces).toEqual(namespaces);
        expect(client.runs.get).not.toHaveBeenCalled();
        orch.dispose();
      }
    );

    it("keeps subagent tokens out of the main conversation on a server that can't filter", async () => {
      withFlags({ stream_lifecycle: true });
      mockRunStream(
        [
          { event: "values", data: { messages: [message("m1")] } },
          {
            event: "messages|tools:a",
            data: [{ id: "sub", type: "ai", content: "subagent" }, {}],
          },
        ],
        { ended: Promise.resolve() }
      );
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");

      await orch.submit({ messages: [] });

      expect(streamed().streamNamespaces).toBeUndefined();
      expect(orch.messages.map((m) => m.id)).toEqual(["m1"]);
      orch.dispose();
    });

    it("a run queued on the server streams subgraphs too", async () => {
      withFlags(flags);
      const end = deferred();
      mockRunStream(undefined, { ended: end.promise });
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");
      const first = orch.submit({ messages: [] });
      await vi.waitFor(() => expect(orch.isLoading).toBe(true));

      await orch.submit({ messages: [] });

      expect((client.runs.create as Mock).mock.calls[0][2]).toMatchObject({
        streamSubgraphs: true,
      });
      end.resolve();
      await first;
      orch.dispose();
    });

    it("a run the app joins is read once for its options", async () => {
      withFlags(flags);
      (client.runs.get as Mock).mockResolvedValue({
        status: "running",
        kwargs: { stream_mode: ["lifecycle"], subgraphs: true },
      });
      mockJoinStream([], Promise.resolve());
      const orch = orchestrator({ scopedSubagents: true, durableRuns: false });
      orch.initThreadId("t1");

      await orch.joinStream("run-7");

      expect(client.runs.get).toHaveBeenCalledWith("t1", "run-7", {
        signal: expect.any(AbortSignal),
      });
      expect(joined().streamNamespaces).toEqual([""]);
      orch.dispose();
    });

    it("a held scope joins the engine's own run, filtered to its namespace", async () => {
      withFlags(flags);
      const end = deferred();
      mockRunStream(undefined, { ended: end.promise });
      mockJoinStream([
        {
          event: "messages|tools:a",
          data: [{ id: "a1", type: "ai", content: "from a" }, {}],
        },
      ]);
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");
      const scope = orch.scopes.acquire(["tools:a"]);

      const run = orch.submit({ messages: [] });
      await vi.waitFor(() =>
        expect(scope.getSnapshot().messages.map((m) => m.id)).toEqual(["a1"])
      );

      expect(joined()).toMatchObject({
        lastEventId: "-1",
        streamNamespaces: ["tools:a"],
      });
      end.resolve();
      await run;
      scope.release();
      orch.dispose();
    });

    it("stop() ends the panels' join, also when the run goes on", async () => {
      withFlags(flags);
      mockRunStream();
      mockJoinStream();
      const orch = orchestrator({ scopedSubagents: true });
      orch.initThreadId("t1");
      const scope = orch.scopes.acquire(["tools:a"]);
      void orch.submit({ messages: [] });
      await vi.waitFor(() => expect(client.runs.joinStream).toHaveBeenCalled());

      await orch.stop({ cancel: false });

      expect(joined().signal.aborted).toBe(true);
      scope.release();
      orch.dispose();
    });

    it("leaves a reloaded subagent's history to its scope", async () => {
      withFlags(flags);
      const state = createThreadState(createSubagentStateValues());
      (client.threads.getHistory as Mock).mockResolvedValue([state]);
      const orch = orchestrator({
        scopedSubagents: true,
        fetchStateHistory: true,
      });
      orch.initThreadId("t1");
      await orch.hydrationPromise;

      expect(orch.reconstructSubagentsIfNeeded()).toBeNull();

      expect(orch.getSubagent("task-1")?.status).toBe("complete");
      expect(client.threads.getHistory).toHaveBeenCalledOnce();
      orch.dispose();
    });

    it("warns once per client when the server can't filter subagents", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      withFlags({});
      orchestrator({ scopedSubagents: true }).dispose();
      orchestrator({ scopedSubagents: true }).dispose();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());

      expect(warn).toHaveBeenCalledOnce();
    });

    it("finds a reloaded subagent's namespace in its task tool message, and binds it", async () => {
      withFlags(flags);
      const values = createSubagentStateValues();
      values.messages[2].artifact = { lc_subagent_checkpoint_ns: "tools:stamped" };
      (client.threads.getState as Mock).mockResolvedValue(createThreadState(values));
      const orch = orchestrator({ filterSubagentMessages: true, scopedSubagents: true });
      orch.initThreadId("t1");
      await orch.hydrationPromise;
      orch.reconstructSubagentsIfNeeded();

      await expect(orch.resolveSubagentNamespace("task-1")).resolves.toEqual([
        "tools:stamped",
      ]);
      expect(orch.getSubagent("task-1")?.namespace).toEqual(["tools:stamped"]);
      expect(client.threads.getHistory).not.toHaveBeenCalled();
      orch.dispose();
    });

    it("finds a paused subagent's namespace in one lean page of the thread's history", async () => {
      withFlags(flags);
      const values = createSubagentStateValues();
      const [, aiMessage] = values.messages;
      values.messages.pop();
      (client.threads.getState as Mock).mockResolvedValue(
        createThreadState(values)
      );
      (client.threads.getHistory as Mock).mockResolvedValue([
        {
          tasks: [
            {
              id: "pregel-1",
              name: "tools",
              path: ["__pregel_push", 0],
              interrupts: [],
            },
          ],
        },
        {
          tasks: [
            {
              id: "model-1",
              name: "model",
              path: ["__pregel_pull", "model"],
              result: { messages: [aiMessage] },
            },
          ],
        },
      ]);
      const orch = orchestrator({
        filterSubagentMessages: true,
        scopedSubagents: true,
      });
      orch.initThreadId("t1");
      await orch.hydrationPromise;
      orch.reconstructSubagentsIfNeeded();

      await expect(orch.resolveSubagentNamespace("task-1")).resolves.toEqual([
        "tools:pregel-1",
      ]);
      expect(client.threads.getHistory).toHaveBeenCalledOnce();
      expect(orch.getSubagent("task-1")?.namespace).toEqual(["tools:pregel-1"]);
      orch.dispose();
    });
  });
});
