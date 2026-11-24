import { StrictMode, Suspense, useState } from "react";
import type { Client } from "@langchain/langgraph-sdk";
import { StreamOrchestrator } from "@langchain/langgraph-sdk/ui";
import { afterEach, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { cleanup, render, renderHook } from "vitest-browser-react";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { STREAM_CONTROLLER, toolCallsOf, useStream } from "./use-stream.js";
import { useSuspenseStream } from "./suspense-stream.js";
import { useSubmissionQueue, useValues } from "./selectors.js";
import { StreamProvider, useStreamContext } from "./context.js";
import { ThreadCacheProvider } from "./thread-cache.js";
import { fakeServer, type FakeRun } from "./test-client.js";
import type { StreamSubmitOptions } from "./types.js";

afterEach(() => cleanup());

const human = (id: string, content: string) => ({ id, type: "human", content });
const ai = (id: string, content: string) => ({ id, type: "ai", content });
const asking = (id: string, callId: string, name = "search") => ({
  ...ai(id, ""),
  tool_calls: [{ id: callId, name, args: {} }],
});

/** Ends `run` paused at `interrupt` with `messages`, as a server streams and saves it. */
function pause(
  server: ReturnType<typeof fakeServer>,
  run: FakeRun,
  messages: unknown[],
  interrupt: { id: string; value: unknown }
) {
  run.send("values", { messages });
  run.send("values", { __interrupt__: [interrupt] });
  server.next.set(run.threadId, ["tools"]);
  server.tasks.set(run.threadId, [
    { id: "task-1", name: "tools", error: null, interrupts: [interrupt] },
  ]);
  run.finish({ messages });
}

it("keeps a loaded message's instance while a run streams", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "earlier")] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  const earlier = result.current.messages[0];
  expect(earlier.getType()).toBe("human");

  void result.current.submit({ messages: [human("h2", "now")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].send("messages", [ai("a1", "streaming"), {}]);

  await expect.poll(() => result.current.messages.length).toBe(3);
  expect(result.current.messages[0]).toBe(earlier);
});

it("renders a thread its ThreadCacheProvider holds on the first render, before reading it again", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "earlier")] } });
  const shown: string[] = [];
  function Thread() {
    const stream = useStream({ assistantId: "agent", client: server.client, threadId: "t1" });
    const text = stream.isThreadLoading ? "loading" : `${stream.messages.length} message`;
    shown.push(text);
    return <span>{text}</span>;
  }
  const screen = await render(
    <ThreadCacheProvider>
      <Thread key="first" />
    </ThreadCacheProvider>
  );
  await expect.poll(() => screen.container.textContent).toBe("1 message");

  shown.length = 0;
  await screen.rerender(
    <ThreadCacheProvider>
      <Thread key="again" />
    </ThreadCacheProvider>
  );

  expect(shown[0]).toBe("1 message");
  await expect
    .poll(() => server.calls.filter((call) => call === "getState t1"))
    .toHaveLength(2);
});

it("reads the thread once under StrictMode", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const { result } = await renderHook(
    () => useStream({ assistantId: "agent", client: server.client, threadId: "t1" }),
    { wrapper: StrictMode }
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.calls.filter((call) => call === "getState t1")).toHaveLength(1);
});

it("loads a new threadId prop, but not the thread its own submit created", async () => {
  const server = fakeServer({
    a: { messages: [human("x", "in a")] },
    b: { messages: [human("y", "in b")] },
  });
  const { result, rerender } = await renderHook(
    (props?: { threadId: string }) =>
      useStream({
        assistantId: "agent",
        client: server.client,
        threadId: props?.threadId,
      }),
    { initialProps: { threadId: "a" } }
  );
  await expect.poll(() => result.current.messages[0]?.content).toBe("in a");
  await rerender({ threadId: "b" });
  await expect.poll(() => result.current.messages[0]?.content).toBe("in b");

  const chat = await renderHook(() => {
    const [threadId, setThreadId] = useState<string | null>(null);
    return useStream({
      assistantId: "agent",
      client: server.client,
      threadId,
      onThreadId: setThreadId,
    });
  });
  void chat.result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => chat.result.current.threadId).toMatch(/^thread-/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.calls.filter((call) => call.startsWith("getState"))).toEqual([
    "getState a",
    "getState b",
  ]);
});

it("calls the latest render's callbacks", async () => {
  const server = fakeServer();
  const seen: string[] = [];
  const { result, rerender } = await renderHook(
    (props?: { label: string }) =>
      useStream({
        assistantId: "agent",
        client: server.client,
        onThreadId: (threadId) => seen.push(`${props?.label} ${threadId}`),
      }),
    { initialProps: { label: "first" } }
  );
  await rerender({ label: "second" });
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => seen).toEqual(["second thread-1"]);
});

it("keeps its client when an inline fetch changes, and calls the latest fetch", async () => {
  const fetched: string[] = [];
  const fetchAs =
    (name: string) =>
    async (..._args: Parameters<typeof fetch>) => {
      fetched.push(name);
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    };
  const { result, rerender } = await renderHook(
    (props?: { name: string }) =>
      useStream({
        assistantId: "agent",
        apiUrl: "http://localhost:9",
        fetch: fetchAs(props?.name ?? ""),
      }),
    { initialProps: { name: "first" } }
  );
  const { client } = result.current;
  await rerender({ name: "second" });
  expect(result.current.client).toBe(client);

  await client.threads.search();
  expect(fetched.at(-1)).toBe("second");
});

it("warns once when both client and fetch are passed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const server = fakeServer();
  const options = {
    assistantId: "agent",
    client: server.client,
    fetch: async () => new Response(),
  };
  await renderHook(() => useStream(options));
  await renderHook(() => useStream(options));
  expect(
    warn.mock.calls.filter(([message]) =>
      String(message).includes("`fetch` is ignored")
    )
  ).toHaveLength(1);
  warn.mockRestore();
});

it("sends forkFrom as the run's checkpoint, with no checkpoint_map, and its command", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  void result.current.submit(null, {
    forkFrom: "cp-1",
    command: { resume: "yes" },
  });
  await expect.poll(() => server.runs.length).toBe(1);
  expect(server.runs[0].payload).toMatchObject({ command: { resume: "yes" } });
  expect(server.runs[0].payload.checkpoint).toEqual({
    checkpoint_id: "cp-1",
    checkpoint_ns: "",
  });
});

it("shows a tool call with no result as running only while a run streams", async () => {
  const asked = asking("a1", "call-1");
  const server = fakeServer({
    t1: { messages: [human("h1", "find it"), asked] },
  });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect
    .poll(() => result.current.toolCalls[0]?.status)
    .toBe("incomplete");

  void result.current.submit(null, { command: { resume: "approved" } });
  await expect.poll(() => result.current.toolCalls[0]?.status).toBe("running");

  server.runs[0].finish({
    messages: [
      human("h1", "find it"),
      asked,
      { id: "tm1", type: "tool", tool_call_id: "call-1", content: "found" },
    ],
  });
  await expect
    .poll(() => result.current.toolCalls[0])
    .toMatchObject({ status: "finished", output: "found" });
  await expect.poll(() => result.current.isLoading).toBe(false);

  const answered = result.current.toolCalls;
  void result.current.submit(null, { command: { resume: "again" } });
  await expect.poll(() => result.current.isLoading).toBe(true);
  expect(result.current.toolCalls).toBe(answered);
});

it.each(["stopped", "failed"] as const)(
  "shows a tool call with no result as incomplete once its run is %s",
  async (ending) => {
    const server = fakeServer({
      t1: { messages: [human("h1", "find it"), asking("a1", "call-1")] },
    });
    const { result } = await renderHook(() =>
      useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
    );
    await expect
      .poll(() => result.current.toolCalls[0]?.status)
      .toBe("incomplete");
    void result.current.submit(null, { command: { resume: "approved" } });
    await expect
      .poll(() => result.current.toolCalls[0]?.status)
      .toBe("running");

    if (ending === "stopped") await result.current.stop();
    else server.runs[0].send("error", { error: "Boom", message: "boom" });

    await expect.poll(() => result.current.isLoading).toBe(false);
    expect(result.current.toolCalls[0]?.status).toBe("incomplete");
  }
);

it("shows a tool call its run stopped at for an approval as incomplete, and running once answered", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "find it")] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  void result.current.submit({ messages: [human("h2", "go on")] });
  await expect.poll(() => server.runs.length).toBe(1);
  pause(
    server,
    server.runs[0],
    [human("h1", "find it"), human("h2", "go on"), asking("a1", "call-1")],
    { id: "int-1", value: "search?" }
  );

  await expect.poll(() => result.current.isLoading).toBe(false);
  await expect
    .poll(() => result.current.interrupts.map(({ id }) => id))
    .toEqual(["int-1"]);
  expect(result.current.toolCalls[0]?.status).toBe("incomplete");
  void result.current.respond("yes");
  await expect.poll(() => result.current.toolCalls[0]?.status).toBe("running");
});

it("shows a tool call the page answers with a headless tool as running until the run resumes with its result", async () => {
  let answer!: (location: string) => void;
  const tools = [
    {
      tool: { name: "get_location" },
      execute: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    },
  ];
  const asked = asking("a1", "call-1", "get_location");
  const server = fakeServer({ t1: { messages: [human("h1", "where am i")] } });
  const { result } = await renderHook(() =>
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      tools,
    })
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  void result.current.submit({ messages: [human("h2", "where?")] });
  await expect.poll(() => server.runs.length).toBe(1);
  pause(
    server,
    server.runs[0],
    [human("h1", "where am i"), human("h2", "where?"), asked],
    {
      id: "int-1",
      value: {
        type: "tool",
        toolCall: { id: "call-1", name: "get_location", args: {} },
      },
    }
  );

  await expect.poll(() => answer).toBeDefined();
  await expect.poll(() => result.current.isLoading).toBe(false);
  expect(result.current.toolCalls[0]?.status).toBe("running");
  answer("SF");
  await expect.poll(() => server.runs.length).toBe(2);
  server.next.delete("t1");
  server.tasks.delete("t1");
  server.runs[1].finish({
    messages: [
      human("h1", "where am i"),
      human("h2", "where?"),
      asked,
      { id: "tm1", type: "tool", tool_call_id: "call-1", content: "SF" },
    ],
  });
  await expect
    .poll(() => result.current.toolCalls[0])
    .toMatchObject({ status: "finished", output: "SF" });
});

it("shows a reopened thread's tool call waiting on an approval as running until its load finds no run going", async () => {
  const server = fakeServer({
    t1: { messages: [human("h1", "find it"), asking("a1", "call-1")] },
  });
  server.next.set("t1", ["tools"]);
  server.tasks.set("t1", [
    {
      id: "task-1",
      name: "tools",
      error: null,
      interrupts: [{ id: "int-1", value: "search?" }],
    },
  ]);
  const statuses: Array<string | undefined> = [];
  function Thread() {
    const stream = useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
    });
    statuses.push(stream.toolCalls[0]?.status);
    return <span>{stream.interrupts.length} waiting</span>;
  }
  const screen = await render(
    <ThreadCacheProvider>
      <Thread key="first" />
    </ThreadCacheProvider>
  );
  await expect.poll(() => screen.container.textContent).toBe("1 waiting");

  statuses.length = 0;
  const release = server.holdLookups();
  await screen.rerender(
    <ThreadCacheProvider>
      <Thread key="again" />
    </ThreadCacheProvider>
  );
  expect(statuses[0], "from the cache, at first paint").toBe("running");
  await expect
    .poll(() => server.calls.filter((call) => call === "getState t1"))
    .toHaveLength(2);
  expect(statuses.at(-1), "read again, its run lookup pending").toBe("running");
  release();

  await expect.poll(() => screen.container.textContent).toBe("1 waiting");
  expect(statuses.at(-1)).toBe("incomplete");
});

it("keeps a tool call from an earlier turn incomplete while a new run streams", async () => {
  const server = fakeServer({
    t1: { messages: [human("h1", "find it"), asking("a1", "call-1")] },
  });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect
    .poll(() => result.current.toolCalls[0]?.status)
    .toBe("incomplete");

  void result.current.submit({ messages: [human("h2", "never mind")] });
  await expect.poll(() => result.current.isLoading).toBe(true);
  expect(result.current.toolCalls[0]?.status).toBe("incomplete");
});

it("with stateKeys: [] and optimistic: false, keeps an earlier turn's call incomplete while a new run streams without its input", async () => {
  const server = fakeServer({
    t1: { messages: [human("h1", "find it"), asking("a1", "call-1")] },
  });
  const { result } = await renderHook(() =>
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      stateKeys: [],
      optimistic: false,
    })
  );
  await expect
    .poll(() => result.current.toolCalls[0]?.status)
    .toBe("incomplete");

  void result.current.submit({ messages: [human("h2", "never mind")] });
  await expect.poll(() => result.current.isLoading).toBe(true);
  await expect.poll(() => server.runs.length).toBe(1);
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.toolCalls[0]?.status).toBe("incomplete");
  server.runs[0].send("messages", [asking("a2", "call-2"), {}]);
  await expect
    .poll(() => result.current.toolCalls.map(({ status }) => status))
    .toEqual(["incomplete", "running"]);
});

it("with stateKeys: [], keeps an earlier turn's call incomplete while a run queued on the server streams", async () => {
  const server = fakeServer({
    t1: { messages: [human("h1", "find it"), asking("a1", "call-1")] },
  });
  const { result } = await renderHook(() =>
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      stateKeys: [],
    })
  );
  await expect
    .poll(() => result.current.toolCalls[0]?.status)
    .toBe("incomplete");
  void result.current.submit(null, { command: { resume: "approved" } });
  await expect.poll(() => result.current.toolCalls[0]?.status).toBe("running");
  void result.current.submit({ messages: [human("h2", "and then?")] });
  await expect.poll(() => server.calls).toContain("create run t1");

  server.runs[0].send("error", { error: "Boom", message: "boom" });
  await expect.poll(() => server.runs.length).toBe(2);
  await expect.poll(() => result.current.isLoading).toBe(true);
  expect(result.current.messages).toHaveLength(2);
  expect(result.current.toolCalls[0]?.status).toBe("incomplete");
});

it("keeps an earlier turn's tool calls as they were when a run starts", async () => {
  const server = fakeServer({
    t1: {
      messages: [
        human("h1", "find it"),
        {
          ...ai("a1", ""),
          tool_calls: [
            { id: "call-1", name: "get_weather", args: {} },
            { id: "call-2", name: "search", args: {} },
          ],
        },
        { id: "tm1", type: "tool", tool_call_id: "call-1", content: '{"city":"SF"}' },
        human("h2", "never mind"),
        ai("a2", "ok"),
      ],
    },
  });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect
    .poll(() => result.current.toolCalls.map(({ status }) => status))
    .toEqual(["finished", "incomplete"]);
  expect(result.current.toolCalls[0]?.output).toEqual({ city: "SF" });
  const shown = result.current.toolCalls;

  void result.current.submit({ messages: [human("h3", "thanks")] });
  await expect.poll(() => result.current.isLoading).toBe(true);
  await expect.poll(() => result.current.messages).toHaveLength(6);

  expect(result.current.toolCalls).toBe(shown);
});

it("keeps an earlier turn's call incomplete while a load hasn't ruled out a run going", async () => {
  const server = fakeServer({
    t1: {
      messages: [
        human("h1", "find it"),
        asking("a1", "call-1"),
        human("h2", "never mind"),
      ],
    },
  });
  const release = server.holdLookups();
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages).toHaveLength(3);

  expect(result.current[STREAM_CONTROLLER].headUnconfirmed).toBe(true);
  expect(result.current.toolCalls[0]?.status).toBe("incomplete");
  release();
});

it("builds tool calls again when only the message a new turn starts after changes", () => {
  const messages = [
    new HumanMessage({ id: "h1", content: "find it" }),
    new AIMessage({
      id: "a1",
      content: "",
      tool_calls: [{ id: "call-1", name: "search", args: {} }],
    }),
  ];
  const before = toolCallsOf(messages, [], true, undefined);
  expect(before.toolCalls[0]?.status).toBe("running");

  const after = toolCallsOf(messages, [], true, "a1", before);

  expect(after.toolCalls[0]?.status).toBe("incomplete");
  expect(
    toolCallsOf(
      [...messages, new AIMessage({ id: "a2", content: "it failed" })],
      [],
      true,
      "a2"
    ).toolCalls[0]?.status,
    "a new turn after a reply with no tool calls"
  ).toBe("incomplete");
});

it("keeps an empty toolCalls when a values event brings messages without tool calls", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages).toHaveLength(1);
  const shown = result.current.toolCalls;

  void result.current.submit({ messages: [human("h2", "again")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].send("values", {
    messages: [human("h1", "hi"), human("h2", "again"), ai("a1", "hello")],
  });
  await expect.poll(() => result.current.messages).toHaveLength(3);

  expect(result.current.toolCalls).toBe(shown);
});

it("throws on a reject submit during a run", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => result.current.isLoading).toBe(true);
  await expect(
    result.current.submit({ messages: [] }, { multitaskStrategy: "reject" })
  ).rejects.toThrow("multitaskStrategy is 'reject'");
});

it("shows interrupts with a namespace, also through getThread()", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].send("values", {
    messages: [],
    __interrupt__: [{ id: "i1", value: "approve?" }],
  });

  await expect.poll(() => result.current.interrupt?.id).toBe("i1");
  expect(result.current.interrupts[0].namespace).toEqual([]);
  expect(result.current.getThread()?.interrupts).toEqual([
    { interruptId: "i1", namespace: [], payload: "approve?" },
  ]);
});

it("answers the interrupt `interrupt` shows when respond() names none", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].finish({
    messages: [],
    __interrupt__: [
      { id: "a", value: "first?" },
      { id: "b", value: "second?" },
    ],
  });
  await expect.poll(() => result.current.interrupt?.id).toBe("a");

  void result.current.respond("yes");

  await expect.poll(() => server.runs.length).toBe(2);
  expect(server.runs[1].payload.command).toMatchObject({ resume: { a: "yes" } });
});

it("shows no interrupt for a head with pending nodes and none to answer", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  server.next.set("t1", ["agent"]);
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(result.current.interrupts).toEqual([]);
  expect(result.current.interrupt).toBeUndefined();
});

it("reads the thread once while inline defaultHeaders and callerOptions keep their entries", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const reads = () =>
    server.calls.filter((call) => call === "getState t1").length;
  const { result, rerender } = await renderHook(
    (props?: { team: string }) =>
      useStream({
        assistantId: "agent",
        client: server.client,
        threadId: "t1",
        defaultHeaders: { "x-team": props?.team ?? "a" },
        callerOptions: { maxRetries: 2 },
      }),
    { initialProps: { team: "a" } }
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  await rerender({ team: "a" });
  await rerender({ team: "a" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reads()).toBe(1);

  await rerender({ team: "b" });
  await expect.poll(reads).toBe(2);
});

it("keeps values and messages when a reload changes neither", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.messages.length).toBe(1);
  const { values, messages } = result.current;

  await result.current.hydrate();
  await expect
    .poll(() => server.calls.filter((call) => call === "getState t1"))
    .toHaveLength(2);

  expect(result.current.values).toBe(values);
  expect(result.current.messages).toBe(messages);
});

it("disposes the engine of a suspended render whose tree unmounts", async () => {
  const dispose = vi.spyOn(StreamOrchestrator.prototype, "dispose");
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const getState = server.client.threads.getState.bind(server.client.threads);
  let answer!: () => void;
  server.client.threads.getState = ((threadId: string) =>
    new Promise<void>((resolve) => {
      answer = resolve;
    }).then(() => getState(threadId))) as typeof getState;
  function Chat() {
    useSuspenseStream({ assistantId: "agent", client: server.client, threadId: "t1" });
    return <span>chat</span>;
  }
  const screen = await render(
    <Suspense fallback={<span>loading</span>}>
      <Chat />
    </Suspense>
  );
  await expect.element(screen.getByText("loading")).toBeVisible();

  screen.unmount();
  answer();

  await expect.poll(() => dispose.mock.calls.length, { timeout: 3_000 }).toBe(1);
  dispose.mockRestore();
});

it("joins a thread's running run once when a sibling suspends on first mount", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  server.running.set("t1", "run-9");
  const onCompleted = vi.fn();
  let mounted = false;
  let mount!: () => void;
  const sibling = new Promise<void>((resolve) => {
    mount = () => {
      mounted = true;
      resolve();
    };
  });
  function Sibling() {
    if (!mounted) throw sibling;
    return null;
  }
  function Chat() {
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      onCompleted,
    });
    return <span>chat</span>;
  }
  const screen = await render(
    <Suspense fallback={<span>loading</span>}>
      <Chat />
      <Sibling />
    </Suspense>
  );
  await expect.element(screen.getByText("loading")).toBeVisible();
  mount();
  await expect.element(screen.getByText("chat")).toBeVisible();
  await expect.poll(() => onCompleted.mock.calls.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(server.calls.filter((call) => call.startsWith("joinStream"))).toEqual([
    "joinStream t1 run-9",
  ]);
  expect(onCompleted).toHaveBeenCalledOnce();
});

it("calls an onConnected first passed on a later render", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const onConnected = vi.fn();
  const { result, rerender } = await renderHook(
    (props?: { onConnected?: () => void }) =>
      useStream({
        assistantId: "agent",
        client: server.client,
        threadId: "t1",
        onConnected: props?.onConnected,
      }),
    { initialProps: {} }
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  await rerender({ onConnected });

  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  const connected = server.runs[0].payload.onConnected as (info: unknown) => void;
  connected({ kind: "initial", attempt: 0 });

  expect(onConnected).toHaveBeenCalledOnce();
});

it("follows a loaded thread over a thread stream, unless watchThread is false", async () => {
  const server = fakeServer({ t1: { messages: [] }, t2: { messages: [] } });
  const followed: string[] = [];
  const client = {
    ...server.client,
    threads: {
      ...server.client.threads,
      joinStream: (threadId: string, { signal }: { signal: AbortSignal }) => {
        followed.push(threadId);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve({ done: true }))
              ),
          }),
        };
      },
    },
  } as unknown as Client;

  await renderHook(() => useStream({ assistantId: "agent", client, threadId: "t1" }));
  const quiet = await renderHook(() =>
    useStream({ assistantId: "agent", client, threadId: "t2", watchThread: false })
  );
  await expect.poll(() => quiet.result.current.isThreadLoading).toBe(false);
  await expect.poll(() => followed).toEqual(["t1"]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(followed).toEqual(["t1"]);
});

it("ends a loaded subagent, and lists a new one, once hydrate() reads what another tab's runs saved", async () => {
  const task = (id: string) => ({
    id: `ai-${id}`,
    type: "ai",
    content: "",
    tool_calls: [{ id, name: "task", args: { subagent_type: "researcher", description: "look" } }],
  });
  const result1 = { id: "tool-call1", type: "tool", name: "task", tool_call_id: "call1", content: "found" };
  const thread: { messages: unknown[] } = { messages: [human("h1", "hi"), task("call1")] };
  const server = fakeServer({ t1: thread });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect
    .poll(() => result.current.subagents.get("call1"))
    .toMatchObject({ output: undefined, completedAt: null });

  thread.messages = [...thread.messages, result1];
  await result.current.hydrate();
  await expect
    .poll(() => result.current.subagents.get("call1"))
    .toMatchObject({ status: "complete", output: "found", completedAt: expect.any(Date) });

  thread.messages = [...thread.messages, human("h2", "more"), task("call2")];
  await result.current.hydrate();
  await expect.poll(() => result.current.subagents.has("call2")).toBe(true);
});

it("shows the result of a subagent whose run failed here and was finished from another tab", async () => {
  const task = {
    id: "ai-call1",
    type: "ai",
    content: "",
    tool_calls: [{ id: "call1", name: "task", args: { subagent_type: "researcher", description: "look" } }],
  };
  const thread: { messages: unknown[] } = { messages: [] };
  const server = fakeServer({ t1: thread });
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].send("updates", { agent: { messages: [task] } });
  await expect.poll(() => result.current.subagents.get("call1")?.status).toBe("running");
  server.runs[0].send("error", { error: "Boom", message: "boom" });
  await expect.poll(() => result.current.subagents.get("call1")?.status).toBe("error");

  thread.messages = [
    human("h1", "hi"),
    task,
    { id: "tool-call1", type: "tool", name: "task", tool_call_id: "call1", content: "found" },
  ];
  await result.current.hydrate();

  await expect
    .poll(() => result.current.subagents.get("call1"))
    .toMatchObject({ status: "complete", output: "found", error: undefined });
});

it("renders on the server without reading the thread, which shows loading", () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  function Chat() {
    const stream = useStream({ assistantId: "agent", client: server.client, threadId: "t1" });
    return <span>{stream.isThreadLoading ? `loading ${stream.threadId}` : "shown"}</span>;
  }

  expect(renderToString(<Chat />)).toContain("loading t1");
  expect(server.calls).toEqual([]);
});

it("streams useSuspenseStream's fallback from the server without reading the thread", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  function Chat() {
    useSuspenseStream({ assistantId: "agent", client: server.client, threadId: "t1" });
    return <span>chat</span>;
  }

  const errors: unknown[] = [];
  const html = await renderToReadableStream(
    <Suspense fallback={<span>fallback</span>}>
      <Chat />
    </Suspense>,
    { onError: (error) => void errors.push(error) }
  );
  await html.allReady;

  expect(await new Response(html).text()).toContain("fallback");
  expect(server.calls).toEqual([]);
  expect(errors).toEqual([
    expect.objectContaining({ digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" }),
  ]);
});

it("hydrates the server's HTML as it is, then reads the thread in the browser", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  function Chat() {
    const stream = useStream({ assistantId: "agent", client: server.client, threadId: "t1" });
    return <span>{stream.isThreadLoading ? "loading" : `${stream.messages.length} message`}</span>;
  }
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Chat />);
  document.body.append(container);
  const recoverable = vi.fn();

  const root = hydrateRoot(container, <Chat />, { onRecoverableError: recoverable });
  await expect.poll(() => container.textContent).toBe("1 message");

  expect(recoverable).not.toHaveBeenCalled();
  expect(server.calls).toEqual(["getState t1"]);
  root.unmount();
  container.remove();
});

it("streams a custom transport's run and answers its interrupt through it, with no Agent Server", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() =>
    useStream({ transport: server.transport })
  );
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  expect(result.current.messages.map((message) => message.content)).toEqual([
    "hi",
  ]);

  server.runs[0].send("values", { messages: [human("h1", "hi")], step: 1 });
  await expect.poll(() => result.current.values.step).toBe(1);
  const shown = result.current.messages[0];
  server.runs[0].send("messages", [ai("a1", "stream"), {}]);
  await expect.poll(() => result.current.messages.length).toBe(2);
  expect(result.current.messages[0]).toBe(shown);
  server.runs[0].finish({
    messages: [human("h1", "hi"), ai("a1", "approve?")],
    __interrupt__: [{ id: "i1", value: "approve?" }],
  });
  await expect.poll(() => result.current.interrupt?.id).toBe("i1");
  const { threadId } = result.current;
  expect(threadId).toEqual(expect.any(String));
  expect(result.current.assistantId).toBe("");

  void result.current.respond("yes");

  await expect.poll(() => server.runs.length).toBe(2);
  expect(server.runs[1].payload).toMatchObject({
    input: null,
    command: { resume: { i1: "yes" } },
    config: { configurable: { thread_id: threadId } },
  });
  expect(server.calls).toEqual([
    `transport ${threadId}`,
    `transport ${threadId}`,
  ]);
});

it("keeps the engine when an inline transport changes, and sends each run through the latest", async () => {
  const server = fakeServer();
  const sentBy: string[] = [];
  const transportNamed = (name: string) => ({
    stream: (payload: Parameters<typeof server.transport.stream>[0]) => {
      sentBy.push(name);
      return server.transport.stream(payload);
    },
  });
  const { result, rerender } = await renderHook(
    (props?: { name: string }) =>
      useStream({ transport: transportNamed(props?.name ?? "") }),
    { initialProps: { name: "first" } }
  );
  const engine = result.current[STREAM_CONTROLLER];
  await rerender({ name: "second" });
  expect(result.current[STREAM_CONTROLLER]).toBe(engine);

  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => sentBy).toEqual(["second"]);
});

it("calls onCreated with a custom transport's run id, and onCompleted with how each run ended", async () => {
  const server = fakeServer();
  const created: string[] = [];
  const completed: unknown[] = [];
  const { result } = await renderHook(() =>
    useStream({
      transport: server.transport,
      onCreated: ({ runId }) => created.push(runId),
      onCompleted: (info) => completed.push(info),
    })
  );
  const submit = () => void result.current.submit({ messages: [] });

  const first = result.current.submit({ messages: [] });
  await expect.poll(() => created).toHaveLength(1);
  server.runs[0].finish({
    messages: [],
    __interrupt__: [{ id: "i1", value: "approve?" }],
  });
  await first;
  submit();
  await expect.poll(() => created).toHaveLength(2);
  server.runs[1].send("error", { error: "Boom", message: "boom" });
  await expect.poll(() => completed).toHaveLength(2);
  submit();
  await expect.poll(() => created).toHaveLength(3);
  await result.current.stop();
  await expect.poll(() => completed).toHaveLength(3);
  submit();
  await expect.poll(() => created).toHaveLength(4);
  server.runs[3].finish({ messages: [] });
  await expect.poll(() => completed).toHaveLength(4);

  expect(completed).toEqual([
    { runId: created[0], reason: "interrupt" },
    { runId: created[1], reason: "error" },
    { runId: created[2], reason: "stopped" },
    { runId: created[3], reason: "success" },
  ]);
});

it("calls onThreadId for each thread a custom transport's stream moves to", async () => {
  const server = fakeServer();
  const seen: string[] = [];
  const { result, rerender } = await renderHook(
    (props?: { threadId?: string }) =>
      useStream({
        transport: server.transport,
        threadId: props?.threadId,
        onThreadId: (threadId) => seen.push(threadId),
      }),
    { initialProps: {} }
  );
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => result.current.threadId).toEqual(expect.any(String));
  expect(seen).toEqual([result.current.threadId]);

  await rerender({ threadId: "t2" });
  await expect.poll(() => seen.at(-1)).toBe("t2");
  await result.current.hydrate("t3");
  await result.current.hydrate("t3");
  expect(seen.slice(1)).toEqual(["t2", "t3"]);
});

it("rejects a custom transport's submit options that need an Agent Server, and stops the run for interrupt", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() =>
    useStream({ transport: server.transport })
  );
  // Each option a custom transport can't send, and the name its error gives.
  const agentServerOnly: [StreamSubmitOptions, string][] = [
    [{ forkFrom: "cp-1" }, "forkFrom"],
    [{ interruptBefore: ["agent"] }, "interruptBefore"],
    [{ interruptAfter: "*" }, "interruptAfter"],
    [{ multitaskStrategy: "rollback" }, 'multitaskStrategy: "rollback"'],
  ];
  for (const [options, name] of agentServerOnly) {
    await expect(result.current.submit(null, options)).rejects.toThrow(
      `\`${name}\` needs an Agent Server`
    );
  }
  expect(server.runs).toHaveLength(0);

  const interrupt = { multitaskStrategy: "interrupt" } as const;
  void result.current.submit({ messages: [human("h1", "hi")] }, interrupt);
  await expect.poll(() => server.runs.length).toBe(1);
  void result.current.submit({ messages: [human("h2", "now")] }, interrupt);

  await expect.poll(() => server.runs.length).toBe(2);
  expect((server.runs[0].payload.signal as AbortSignal).aborted).toBe(true);
});

it("keeps a subagent's messages out of a custom transport's main conversation", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() =>
    useStream({ transport: server.transport })
  );
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);

  server.runs[0].send("messages|tools:call1", [ai("s1", "in the subagent"), {}]);
  server.runs[0].send("messages", [ai("a1", "in the main"), {}]);

  await expect
    .poll(() => result.current.messages.map((message) => message.content))
    .toEqual(["hi", "in the main"]);
});

it("ends a subagent left open when a custom transport's run stops or fails", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() =>
    useStream({ transport: server.transport })
  );
  const startSubagent = async (count: number, id: string) => {
    void result.current.submit({ messages: [] });
    await expect.poll(() => server.runs.length).toBe(count);
    server.runs[count - 1].send("updates", {
      agent: {
        messages: [
          {
            id: `ai-${id}`,
            type: "ai",
            content: "",
            tool_calls: [
              {
                id,
                name: "task",
                args: { subagent_type: "researcher", description: "look" },
              },
            ],
          },
        ],
      },
    });
    await expect
      .poll(() => result.current.subagents.get(id)?.status)
      .toBe("running");
  };

  await startSubagent(1, "call1");
  await result.current.stop();
  await expect
    .poll(() => result.current.subagents.get("call1"))
    .toMatchObject({ status: "error", error: "The run ended: stopped" });

  await startSubagent(2, "call2");
  server.runs[1].send("error", { error: "Boom", message: "boom" });
  await expect
    .poll(() => result.current.subagents.get("call2"))
    .toMatchObject({ status: "error", error: "The run ended: error" });

  await startSubagent(3, "call3");
  void result.current.submit(
    { messages: [] },
    { multitaskStrategy: "interrupt" }
  );
  await expect
    .poll(() => result.current.subagents.get("call3"))
    .toMatchObject({ status: "error", error: "The run ended: stopped" });
});

it("lists a submit waiting behind a custom transport's run, with no run id", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() => {
    const stream = useStream({ transport: server.transport });
    return { stream, queue: useSubmissionQueue(stream) };
  });
  void result.current.stream.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  void result.current.stream.submit({ messages: [human("h2", "next")] });

  await expect.poll(() => result.current.queue.size).toBe(1);
  expect(result.current.queue.entries[0].runId).toBeUndefined();
});

it("gives StreamProvider's children a stream over its custom transport", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() => useStreamContext(), {
    wrapper: ({ children }) => (
      <StreamProvider transport={server.transport}>{children}</StreamProvider>
    ),
  });
  void result.current.submit({ messages: [human("h1", "hi")] });

  await expect.poll(() => server.runs.length).toBe(1);
  expect(server.calls).toEqual([`transport ${result.current.threadId}`]);
});

it("throws when a custom transport is given the server's queue", async () => {
  const server = fakeServer();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    renderHook(() =>
      useStream({ transport: server.transport, queue: "server" as "local" })
    )
  ).rejects.toThrow('`queue: "server"` needs an Agent Server');
  error.mockRestore();
});

it("renders a custom transport's thread on the server, since there is nothing to read", () => {
  const server = fakeServer();
  function Chat() {
    const stream = useStream({ transport: server.transport, threadId: "t1" });
    return <span>{stream.isThreadLoading ? "loading" : "shown"}</span>;
  }
  function SuspenseChat() {
    useSuspenseStream({ transport: server.transport, threadId: "t1" });
    return <span>chat</span>;
  }

  expect(renderToString(<Chat />)).toContain("shown");
  expect(
    renderToString(
      <Suspense fallback={<span>fallback</span>}>
        <SuspenseChat />
      </Suspense>
    )
  ).toContain("chat");
});

it("shows only stateKeys and the messages key from a server that ignores select, reading the thread once", async () => {
  const server = fakeServer({
    t1: { messages: [human("h1", "hi")], todos: ["a"], files: ["x.txt"] },
  });
  const { result, rerender } = await renderHook(() => {
    // A new array on every render, as an inline literal is.
    const stream = useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      stateKeys: ["todos"],
    });
    return { stream, values: useValues(stream) };
  });
  await expect.poll(() => result.current.stream.messages.length).toBe(1);
  await rerender();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(Object.keys(result.current.stream.values).sort()).toEqual([
    "messages",
    "todos",
  ]);
  expect(result.current.values).toBe(result.current.stream.values);
  expect(server.calls.filter((call) => call.startsWith("getState"))).toEqual([
    "getState t1",
  ]);
});

it("keeps stateKeys' shape while a run streams, sends unlisted input, and shows its interrupts", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() =>
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      stateKeys: [],
    })
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);

  void result.current.submit({ messages: [human("h1", "hi")], files: ["x"] });
  await expect.poll(() => server.runs.length).toBe(1);
  expect(server.runs[0].payload.input).toMatchObject({ files: ["x"] });
  expect(Object.keys(result.current.values)).toEqual(["messages"]);

  server.runs[0].send("values", { messages: [human("h1", "hi")], step: 1 });
  server.runs[0].send("values", {
    __interrupt__: [{ id: "i1", value: "approve?" }],
  });
  await expect.poll(() => result.current.interrupt?.id).toBe("i1");
  expect(result.current.values).not.toHaveProperty("step");
  expect(result.current.values).not.toHaveProperty("files");
});

it("joins a thread's running run from a load narrowed by stateKeys", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  server.running.set("t1", "run-9");
  const { result } = await renderHook(() =>
    useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
      stateKeys: [],
    })
  );

  await expect
    .poll(() => server.calls.filter((call) => call.startsWith("joinStream")))
    .toEqual(["joinStream t1 run-9"]);
  expect(result.current.messages.map((message) => message.content)).toEqual([
    "hi",
  ]);
});

it("narrows a custom transport's streamed values to stateKeys", async () => {
  const server = fakeServer();
  const { result } = await renderHook(() =>
    useStream({ transport: server.transport, stateKeys: ["todos"] })
  );
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);

  server.runs[0].finish({ messages: [human("h1", "hi")], todos: [], step: 1 });

  await expect.poll(() => result.current.isLoading).toBe(false);
  expect(Object.keys(result.current.values).sort()).toEqual([
    "messages",
    "todos",
  ]);
});
