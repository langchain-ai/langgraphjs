// @vitest-environment jsdom
import { Activity, StrictMode, act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useStream } from "./stream.js";
import type { Client } from "../client.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Message = { id: string; content: string; type: string };
type State = { messages: Message[] };
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

const weatherCall = {
  id: "int-1",
  value: {
    type: "tool",
    toolCall: { id: "call-1", name: "get_weather", args: { city: "SF" } },
  },
};

const pendingTool = () =>
  threadState(
    { messages: [message("h0")] },
    {
      next: ["tools"],
      tasks: [
        { id: "task-1", name: "tools", error: null, interrupts: [weatherCall] },
      ],
    }
  );

const weatherTool = (execute = vi.fn().mockResolvedValue("sunny")) => ({
  tool: { name: "get_weather" },
  execute,
});

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

function mockRun(client: TestClient, events: StreamEvents) {
  client.runs.stream.mockImplementationOnce(
    (
      threadId: string,
      _assistantId: string,
      payload: {
        onRunCreated?: (params: { run_id: string; thread_id: string }) => void;
      }
    ) => {
      payload.onRunCreated?.({ run_id: "run-1", thread_id: threadId });
      return (async function* () {
        yield* events;
      })();
    }
  );
}

function mockJoin(client: TestClient, events: StreamEvents) {
  client.runs.joinStream.mockImplementationOnce(() =>
    (async function* () {
      yield* events;
    })()
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
  options: Record<string, unknown> = {},
  wrap = (probe: ReactElement) => probe
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
    await act(async () => root.render(wrap(<Probe props={next} />)));
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

describe("useStream (old engine) headless tools", () => {
  it("runs a pending tool from the thread state once and resumes the run", async () => {
    const client = createClient();
    serve(client, pendingTool());
    mockRun(client, []);
    const tool = weatherTool();

    await renderStream(client, { threadId: "t1", tools: [tool] });
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledWith({ city: "SF" });
    expect(client.runs.stream).toHaveBeenCalledTimes(1);
    expect(client.runs.stream).toHaveBeenCalledWith(
      "t1",
      "agent",
      expect.objectContaining({
        command: expect.objectContaining({
          resume: { "int-1": { "call-1": "sunny" } },
        }),
      })
    );
  });

  it("runs a pending tool left in the values of a finished run once", async () => {
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const tool = weatherTool();
    const view = await renderStream(client, {
      threadId: "t1",
      throttle: true,
      tools: [tool],
    });
    mockRun(client, [
      {
        event: "values",
        data: { messages: [message("h0")], __interrupt__: [weatherCall] },
      },
    ]);
    mockRun(client, []);

    await submit(view);
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(client.runs.stream).toHaveBeenCalledTimes(2);
  });

  it("runs a pending tool once when the read after its run still shows it", async () => {
    const client = createClient();
    serve(client, threadState({ messages: [message("h0")] }));
    const tool = weatherTool();
    const view = await renderStream(client, {
      threadId: "t1",
      fetchStateHistory: true,
      tools: [tool],
    });
    mockRun(client, [
      {
        event: "values",
        data: { messages: [message("h0")], __interrupt__: [weatherCall] },
      },
    ]);
    mockRun(client, []);
    serve(client, pendingTool());

    await submit(view);
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("runs a pending tool once under StrictMode", async () => {
    const client = createClient();
    mockRun(client, []);
    const tool = weatherTool();

    await renderStream(
      client,
      {
        threadId: "t1",
        thread: { ...userThread(), data: [pendingTool()] },
        tools: [tool],
      },
      (probe) => <StrictMode>{probe}</StrictMode>
    );
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(client.runs.stream).toHaveBeenCalledTimes(1);
  });

  it("runs a pending tool once after a custom transport hook is hidden and shown", async () => {
    const tool = weatherTool(vi.fn(() => new Promise(() => {})));
    const transport = {
      stream: vi.fn(async () =>
        (async function* () {
          yield {
            event: "values",
            data: { messages: [], __interrupt__: [weatherCall] },
          };
        })()
      ),
    };
    const options = { transport, tools: [tool] };
    let mode: "visible" | "hidden" = "visible";
    const view = await renderStream(createClient(), options, (probe) => (
      <Activity mode={mode}>{probe}</Activity>
    ));
    await submit(view);
    await settle();

    mode = "hidden";
    await view.rerender(options);
    mode = "visible";
    await view.rerender(options);
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("does not run the previous thread's pending tool after a thread switch", async () => {
    const client = createClient();
    serve(client, pendingTool());
    const tool = weatherTool(vi.fn(() => new Promise(() => {})));
    const view = await renderStream(client, { threadId: "t1", tools: [tool] });
    client.threads.getState.mockReturnValue(new Promise(() => {}));

    await view.rerender({ threadId: "t2", tools: [tool] });
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("does not run a pending tool from a read that resolves after a rejoined run ends", async () => {
    const client = createClient();
    const answered = threadState({
      messages: [message("h0"), message("a0", "ai")],
    });
    let serveStale!: (states: unknown) => void;
    client.threads.getHistory
      .mockReturnValueOnce(
        new Promise((resolve) => {
          serveStale = resolve;
        })
      )
      .mockResolvedValue([answered]);
    mockJoin(client, [{ event: "values", data: answered.values }]);
    window.sessionStorage.setItem("lg:stream:t1", "run-1");
    const tool = weatherTool();

    await renderStream(client, {
      threadId: "t1",
      fetchStateHistory: true,
      reconnectOnMount: true,
      tools: [tool],
    });
    await act(async () => serveStale([pendingTool()]));
    await settle();

    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("waits for a rejoined run to end before running a pending tool", async () => {
    const client = createClient();
    serve(client, pendingTool());
    let endRun!: () => void;
    client.runs.joinStream.mockImplementationOnce(() =>
      (async function* () {
        await new Promise<void>((resolve) => {
          endRun = resolve;
        });
        yield { event: "values", data: { messages: [message("h0")] } };
      })()
    );
    mockRun(client, []);
    window.sessionStorage.setItem("lg:stream:t1", "run-1");
    const tool = weatherTool();

    await renderStream(client, {
      threadId: "t1",
      reconnectOnMount: true,
      tools: [tool],
    });
    expect(client.runs.joinStream).toHaveBeenCalledTimes(1);
    expect(tool.execute).not.toHaveBeenCalled();

    await act(async () => endRun());
    await settle();

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(client.runs.stream).toHaveBeenCalledTimes(1);
  });
});
