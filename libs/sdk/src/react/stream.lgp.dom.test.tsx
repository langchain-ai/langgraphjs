// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStream } from "./stream.js";
import type { Client } from "../client.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Message = { id: string; content: string; type: string };
type State = { messages: Message[]; count?: number };
type StreamEvents = Array<{ event: string; data: unknown }>;
type View = {
  current: ReturnType<typeof useStream<State>>;
  rerender: (options: Record<string, unknown>) => Promise<void>;
};

const message = (id: string, type = "human"): Message => ({
  id,
  content: id,
  type,
});

const threadState = (values: State, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

const interrupted = () =>
  threadState(
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

function createClient() {
  return {
    threads: {
      getState: vi.fn(),
      getHistory: vi.fn(),
      create: vi.fn().mockResolvedValue({ thread_id: "t1" }),
    },
    runs: {
      stream: vi.fn(),
      joinStream: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}
type TestClient = ReturnType<typeof createClient>;

function serve(client: TestClient, state: Record<string, unknown>) {
  client.threads.getState.mockResolvedValue(state);
  client.threads.getHistory.mockResolvedValue([state]);
}

const userThread = () => ({
  data: [threadState({ messages: [message("h0")] })],
  error: undefined,
  isLoading: false,
  mutate: vi.fn().mockResolvedValue(undefined),
});

const countStops = ({
  mutate,
}: {
  mutate: (update: (prev: State) => Partial<State>) => void;
}) => mutate((prev) => ({ ...prev, count: (prev.count ?? 0) + 1 }));

function deferRead(client: TestClient, fetchStateHistory: boolean) {
  let resolve!: (value: unknown) => void;
  const read = new Promise((r) => {
    resolve = r;
  });
  (fetchStateHistory
    ? client.threads.getHistory
    : client.threads.getState
  ).mockReturnValueOnce(read);
  return (state: ReturnType<typeof threadState>) =>
    resolve(fetchStateHistory ? [state] : state);
}

function streamOf(events: StreamEvents, signal: AbortSignal, hang: boolean) {
  return (async function* () {
    yield* events;
    if (!hang) return;
    await new Promise<never>((_resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
    });
  })();
}

function mockRun(
  client: TestClient,
  events: StreamEvents,
  { hang = false } = {}
) {
  client.runs.stream.mockImplementationOnce(
    (
      threadId: string,
      _assistantId: string,
      payload: {
        signal: AbortSignal;
        onRunCreated?: (params: { run_id: string; thread_id: string }) => void;
      }
    ) => {
      payload.onRunCreated?.({ run_id: "run-1", thread_id: threadId });
      return streamOf(events, payload.signal, hang);
    }
  );
}

function mockJoin(client: TestClient, events: StreamEvents) {
  client.runs.joinStream.mockImplementationOnce(
    (_threadId: string, _runId: string, payload: { signal: AbortSignal }) =>
      streamOf(events, payload.signal, false)
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function renderStream(
  client: TestClient,
  options: Record<string, unknown> = {}
) {
  const view = {} as View;
  function Probe({ props }: { props: Record<string, unknown> }) {
    view.current = useStream<State>({
      assistantId: "agent",
      client: client as unknown as Client,
      ...props,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  view.rerender = async (next) => {
    await act(async () => root.render(<Probe props={next} />));
  };
  await view.rerender(options);
  await settle();
  unmounts.push(() => act(() => root.unmount()));
  return view;
}

async function submit(view: View, submitOptions?: Record<string, unknown>) {
  await act(async () => {
    await view.current.submit({ messages: [] }, submitOptions);
  });
}

async function startRun(view: View, submitOptions?: Record<string, unknown>) {
  let running!: Promise<unknown>;
  await act(async () => {
    running = view.current.submit({ messages: [] }, submitOptions);
  });
  await settle();
  return { running };
}

async function stop(view: View, ...runs: Array<{ running: Promise<unknown> }>) {
  await act(async () => {
    await view.current.stop();
    await Promise.all(runs.map((run) => run.running));
  });
}

async function startStop(view: View) {
  let stopping!: Promise<void>;
  await act(async () => {
    stopping = view.current.stop();
  });
  return { stopping };
}

describe("useStream (old engine) joinStream", () => {
  it("shows the head read after the run when history is enabled", async () => {
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const view = await renderStream(client, {
      threadId: "t1",
      fetchStateHistory: true,
    });
    const final = { id: "a0", content: "Hello world", type: "ai" };
    serve(client, threadState({ messages: [message("h0"), final] }));

    mockJoin(client, [
      {
        event: "values",
        data: {
          messages: [message("h0"), { id: "a0", content: "Hello", type: "ai" }],
        },
      },
    ]);
    await act(async () => {
      await view.current.joinStream("run-1");
    });

    expect(view.current.messages).toEqual([message("h0"), final]);
  });
});

describe("useStream (old engine) thread state after a run", () => {
  const answeringRuns = [
    {
      via: "submit",
      run: async (client: TestClient, view: View, events: StreamEvents) => {
        mockRun(client, events);
        await submit(view, { command: { resume: "yes" } });
      },
    },
    {
      via: "joinStream",
      run: async (client: TestClient, view: View, events: StreamEvents) => {
        mockJoin(client, events);
        await act(async () => {
          await view.current.joinStream("run-1");
        });
      },
    },
  ];

  it.each(answeringRuns)(
    "a run that answers an interrupt removes it ($via)",
    async ({ run }) => {
      const client = createClient();
      serve(client, interrupted());
      const view = await renderStream(client, { threadId: "t1" });
      expect(view.current.interrupts.map((i) => i.id)).toEqual(["int-1"]);
      const answered = [message("h0"), message("a0", "ai")];
      serve(client, threadState({ messages: answered }));

      await run(client, view, [
        { event: "values", data: { messages: answered } },
      ]);

      expect(view.current.interrupts).toEqual([]);
      expect(view.current.messages).toEqual(answered);
    }
  );

  it("a run on a thread with nothing pending reads no state", async () => {
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const view = await renderStream(client, { threadId: "t1" });

    mockRun(client, [
      {
        event: "values",
        data: { messages: [message("h0"), message("a0", "ai")] },
      },
    ]);
    await submit(view);

    expect(client.threads.getState).toHaveBeenCalledTimes(1);
  });

  it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
    "a failed read after a run still finishes the run (fetchStateHistory: $fetchStateHistory)",
    async ({ fetchStateHistory }) => {
      const onFinish = vi.fn(() => {});
      const onError = vi.fn();
      const client = createClient();
      serve(client, interrupted());
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory,
        onFinish,
        onError,
      });
      client.threads.getState.mockRejectedValue(new Error("offline"));
      client.threads.getHistory.mockRejectedValue(new Error("offline"));
      const answered = [message("h0"), message("a0", "ai")];

      mockRun(client, [{ event: "values", data: { messages: answered } }]);
      await submit(view, { command: { resume: "yes" } });

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ run_id: "run-1" })
      );
      expect(view.current.messages).toEqual(answered);
    }
  );

  it.each(answeringRuns)(
    "a failed read after a run reports no error without history ($via)",
    async ({ run }) => {
      const onError = vi.fn();
      const client = createClient();
      serve(client, interrupted());
      const view = await renderStream(client, { threadId: "t1", onError });
      client.threads.getState.mockRejectedValue(new Error("offline"));

      await run(client, view, [
        {
          event: "values",
          data: { messages: [message("h0"), message("a0", "ai")] },
        },
      ]);

      expect(view.current.error).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it.each(answeringRuns)(
    "a run with a user thread whose mutate returns no promise still finishes ($via)",
    async ({ run }) => {
      const onFinish = vi.fn(() => {});
      const onError = vi.fn();
      const client = createClient();
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory: true,
        thread: { ...userThread(), mutate: vi.fn() },
        onFinish,
        onError,
      });

      await run(client, view, [
        {
          event: "values",
          data: { messages: [message("h0"), message("a0", "ai")] },
        },
      ]);

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(view.current.error).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    }
  );
});

describe("useStream (old engine) thread state after stop", () => {
  const cancelledRun = () =>
    threadState(
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

  it.each([
    {
      label: "an existing thread",
      options: { threadId: "t1" },
      opened: [message("h0"), message("a0", "ai")],
    },
    { label: "a new chat", options: {}, opened: [] },
  ])(
    "stop keeps the turns of this session on $label",
    async ({ options, opened }) => {
      const saved = [
        ...opened,
        message("h1"),
        message("a1", "ai"),
        message("h2"),
      ];
      const client = createClient();
      serve(client, threadState({ messages: opened }));
      const view = await renderStream(client, options);
      serve(client, threadState({ messages: saved }));

      mockRun(client, [
        { event: "values", data: { messages: saved.slice(0, -1) } },
      ]);
      await submit(view);
      mockRun(
        client,
        [
          {
            event: "values",
            data: { messages: [...saved, message("a2", "ai")] },
          },
        ],
        { hang: true }
      );
      await stop(view, await startRun(view));

      expect(view.current.messages).toEqual(saved);
    }
  );

  it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
    "stop shows no error or breakpoint from the cancel (fetchStateHistory: $fetchStateHistory)",
    async ({ fetchStateHistory }) => {
      const client = createClient();
      serve(client, interrupted());
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory,
      });
      serve(client, cancelledRun());

      mockRun(client, [], { hang: true });
      await stop(view, await startRun(view, { command: { resume: "yes" } }));

      expect(view.current.interrupts).toEqual([]);
      expect(view.current.error).toBeUndefined();
      expect(view.current.messages).toEqual([message("h0")]);
    }
  );

  it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
    "stop applies onStop edits to the state read after it (fetchStateHistory: $fetchStateHistory)",
    async ({ fetchStateHistory }) => {
      const client = createClient();
      serve(client, threadState({ messages: [message("h0")] }));
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory,
        onStop: countStops,
      });
      const saved = [message("h0"), message("h1")];
      serve(client, threadState({ messages: saved }));

      mockRun(client, [{ event: "values", data: { messages: saved } }], {
        hang: true,
      });
      await stop(view, await startRun(view));

      expect(view.current.values).toEqual({ messages: saved, count: 1 });
    }
  );

  it("a failed read after stop keeps the screen and shows no error", async () => {
    const onError = vi.fn();
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const view = await renderStream(client, { threadId: "t1", onError });
    client.threads.getState.mockRejectedValue(new Error("offline"));

    const streamed = [message("h0"), message("h1")];
    mockRun(client, [{ event: "values", data: { messages: streamed } }], {
      hang: true,
    });
    await stop(view, await startRun(view));

    expect(view.current.messages).toEqual(streamed);
    expect(view.current.error).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  const onStopCases = [
    {
      label: "no onStop",
      onStop: undefined,
      values: { messages: [message("h0")] },
    },
    {
      label: "an onStop edit",
      onStop: countStops,
      values: { messages: [message("h0")], count: 1 },
    },
  ];

  it.each(onStopCases)(
    "stop falls back to a user thread's data when its mutate returns nothing ($label)",
    async ({ onStop, values }) => {
      const client = createClient();
      const thread = userThread();
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory: true,
        thread,
        onStop,
      });

      mockRun(
        client,
        [
          {
            event: "values",
            data: { messages: [message("h0"), message("partial", "ai")] },
          },
        ],
        { hang: true }
      );
      await stop(view, await startRun(view));

      expect(thread.mutate).toHaveBeenCalledWith("t1");
      expect(view.current.values).toEqual(values);
    }
  );

  it("after stop, a user thread whose mutate returns nothing shows its data as it changes", async () => {
    const client = createClient();
    const thread = userThread();
    const options = { threadId: "t1", fetchStateHistory: true, thread };
    const view = await renderStream(client, options);

    mockRun(
      client,
      [
        {
          event: "values",
          data: { messages: [message("h0"), message("partial", "ai")] },
        },
      ],
      { hang: true }
    );
    await stop(view, await startRun(view));
    const refreshed = [message("h0"), message("h1")];
    await view.rerender({
      ...options,
      thread: { ...thread, data: [threadState({ messages: refreshed })] },
    });

    expect(view.current.messages).toEqual(refreshed);
  });

  it.each(onStopCases)(
    "stop with a user thread and no history reads nothing and shows that thread's data ($label)",
    async ({ onStop, values }) => {
      const client = createClient();
      serve(client, threadState({ messages: [message("server")] }));
      const thread = userThread();
      const view = await renderStream(client, {
        threadId: "t1",
        thread,
        onStop,
      });

      mockRun(
        client,
        [
          {
            event: "values",
            data: { messages: [message("h0"), message("partial", "ai")] },
          },
        ],
        { hang: true }
      );
      await stop(view, await startRun(view));

      expect(client.threads.getState).not.toHaveBeenCalled();
      expect(thread.mutate).not.toHaveBeenCalled();
      expect(view.current.values).toEqual(values);
    }
  );

  it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
    "a thread switch during the read after stop drops the read (fetchStateHistory: $fetchStateHistory)",
    async ({ fetchStateHistory }) => {
      const client = createClient();
      const view = await renderStream(client, { fetchStateHistory });
      const finishRead = deferRead(client, fetchStateHistory);

      mockRun(
        client,
        [{ event: "values", data: { messages: [message("h0")] } }],
        { hang: true }
      );
      const run = await startRun(view);
      const { stopping } = await startStop(view);
      await act(async () => {
        view.current.switchThread(null);
      });
      await act(async () => {
        finishRead(threadState({ messages: [message("h0"), message("h1")] }));
        await stopping;
        await run.running;
      });

      expect(view.current.messages).toEqual([]);
    }
  );

  it.each([{ fetchStateHistory: false }, { fetchStateHistory: true }])(
    "stop does not overwrite a run queued before it (fetchStateHistory: $fetchStateHistory)",
    async ({ fetchStateHistory }) => {
      const client = createClient();
      serve(client, threadState({ messages: [message("h0")] }));
      const view = await renderStream(client, {
        threadId: "t1",
        fetchStateHistory,
      });
      const finishRead = deferRead(client, fetchStateHistory);

      mockRun(
        client,
        [
          {
            event: "values",
            data: { messages: [message("h0"), message("h1")] },
          },
        ],
        { hang: true }
      );
      const first = await startRun(view);
      const queued = [message("h0"), message("h2")];
      mockRun(client, [{ event: "values", data: { messages: queued } }], {
        hang: true,
      });
      const second = await startRun(view);
      const { stopping } = await startStop(view);
      await settle();
      expect(view.current.messages).toEqual(queued);
      await act(async () => {
        finishRead(threadState({ messages: [message("h0"), message("h1")] }));
        await stopping;
      });

      expect(view.current.messages).toEqual(queued);
      await stop(view, first, second);
    }
  );

  it("stop does not overwrite a run that starts and ends during the read", async () => {
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const view = await renderStream(client, { threadId: "t1" });
    const finishRead = deferRead(client, false);

    mockRun(
      client,
      [{ event: "values", data: { messages: [message("h0")] } }],
      { hang: true }
    );
    const first = await startRun(view);
    const { stopping } = await startStop(view);
    await act(async () => {
      await first.running;
    });
    const next = [message("h0"), message("h-next")];
    mockRun(client, [{ event: "values", data: { messages: next } }]);
    await submit(view);
    await act(async () => {
      finishRead(threadState({ messages: [message("h0")] }));
      await stopping;
    });

    expect(view.current.messages).toEqual(next);
  });
});
