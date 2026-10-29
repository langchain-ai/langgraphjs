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

describe("useStream (old engine) implicit checkpoint", () => {
  const checkpoint = (checkpoint_id: string) => ({
    thread_id: "t1",
    checkpoint_id,
    checkpoint_ns: "",
    checkpoint_map: null,
  });
  const state = (id: string, parent?: string) =>
    threadState(
      { messages: [] },
      {
        checkpoint: checkpoint(id),
        parent_checkpoint: parent ? checkpoint(parent) : null,
      }
    );

  async function sentCheckpoint(history: unknown[], branch = "") {
    const client = createClient();
    client.threads.getHistory.mockResolvedValue(history);
    const view = await renderStream(client, {
      threadId: "t1",
      fetchStateHistory: true,
    });
    await act(async () => view.current.setBranch(branch));

    mockRun(client, []);
    await submit(view);

    return client.runs.stream.mock.calls[0][2].checkpoint;
  }

  it("does not pin the cached head when the latest branch is shown", async () => {
    const history = [state("cp-b", "cp-a"), state("cp-a")];
    expect(await sentCheckpoint(history)).toBeUndefined();
  });

  it("does not pin the head when a second submit is queued behind the first", async () => {
    const client = createClient();
    client.threads.getHistory.mockResolvedValue([state("cp-1")]);
    const view = await renderStream(client, {
      threadId: "t1",
      fetchStateHistory: true,
    });
    client.threads.getHistory.mockResolvedValue([
      state("cp-2", "cp-1"),
      state("cp-1"),
    ]);

    mockRun(client, []);
    mockRun(client, []);
    await act(async () => {
      await Promise.all([
        view.current.submit({ messages: [] }),
        view.current.submit({ messages: [] }),
      ]);
    });

    expect(client.runs.stream.mock.calls[1][2].checkpoint).toBeUndefined();
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
