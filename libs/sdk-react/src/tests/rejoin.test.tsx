import type { Client } from "@langchain/langgraph-sdk";
import { useStream as useSdkStream } from "@langchain/langgraph-sdk/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useStream as useReactStream } from "../index.js";

const message = (id: string, type = "human") => ({ id, type, content: id });
const checkpoint = (id: string) => ({
  thread_id: "t1",
  checkpoint_id: id,
  checkpoint_ns: "",
  checkpoint_map: null,
});
const head = {
  values: { messages: [message("h0"), message("a0", "ai")] },
  checkpoint: checkpoint("cp2"),
  parent_checkpoint: checkpoint("cp1"),
  next: [],
  tasks: [],
  metadata: undefined,
  created_at: null,
};

function createClient() {
  return {
    threads: {
      getState: vi.fn().mockResolvedValue(head),
      getHistory: vi.fn().mockResolvedValue([head]),
      create: vi.fn(),
    },
    runs: {
      stream: vi.fn(),
      joinStream: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function* events(list: unknown[]) {
  yield* list;
}

type Stream = { isLoading: boolean; error: unknown };
type View = { current?: Stream };

describe.each([
  ["@langchain/react", useReactStream],
  ["@langchain/langgraph-sdk/react", useSdkStream],
])("%s rejoin on mount", (_name, hook) => {
  const useStream = hook as unknown as (
    options: Record<string, unknown>
  ) => Stream;
  function Probe({ view, ...options }: { view: View } & Record<string, unknown>) {
    view.current = useStream({
      assistantId: "agent",
      threadId: "t1",
      reconnectOnMount: true,
      ...options,
    });
    return (
      <div data-testid="loading">
        {view.current.isLoading ? "Loading..." : "Not loading"}
      </div>
    );
  }

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("stays loading while a stored run waits for the thread state", async () => {
    const client = createClient();
    let serveRead!: (value: unknown) => void;
    client.threads.getState.mockReturnValueOnce(
      new Promise((resolve) => {
        serveRead = resolve;
      })
    );
    client.runs.joinStream.mockReturnValueOnce(events([]));
    window.sessionStorage.setItem("lg:stream:t1", "run-1");

    const screen = await render(
      <Probe view={{}} client={client as unknown as Client} />
    );
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");
    expect(client.runs.joinStream).not.toHaveBeenCalled();

    serveRead(head);
    await vi.waitFor(() =>
      expect(client.runs.joinStream).toHaveBeenCalledTimes(1)
    );
    expect(client.runs.joinStream.mock.calls[0][2]).toMatchObject({
      lastEventId: "-1",
      checkpointId: "cp2",
    });
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
  });

  it("does not retry a failed rejoin when the thread state reloads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createClient();
    client.runs.joinStream.mockReturnValueOnce(
      events([{ event: "error", data: { message: "gone" } }])
    );
    window.sessionStorage.setItem("lg:stream:t1", "run-1");
    const thread = {
      data: [head],
      error: undefined,
      isLoading: true,
      mutate: vi.fn().mockResolvedValue(undefined),
    };
    const view: View = {};
    const probe = (isLoading: boolean) => (
      <Probe
        view={view}
        client={client as unknown as Client}
        thread={{ ...thread, isLoading }}
      />
    );

    const screen = await render(probe(true));
    expect(client.runs.joinStream).not.toHaveBeenCalled();

    await screen.rerender(probe(false));
    await vi.waitFor(() => expect(view.current?.error).toBeDefined());
    await screen.rerender(probe(true));
    await screen.rerender(probe(false));

    expect(client.runs.joinStream).toHaveBeenCalledTimes(1);
  });
});
