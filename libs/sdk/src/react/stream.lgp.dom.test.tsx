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

const threadState = (values: State) => ({
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
