import { StrictMode, Suspense, useState } from "react";
import { StreamOrchestrator } from "@langchain/langgraph-sdk/ui";
import { afterEach, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { cleanup, render, renderHook } from "vitest-browser-react";
import { STREAM_CONTROLLER, useStream } from "./use-stream.js";
import { useSuspenseStream } from "./suspense-stream.js";
import { useSubmissionQueue } from "./selectors.js";
import { StreamProvider, useStreamContext } from "./context.js";
import { fakeServer } from "./test-client.js";
import type { StreamSubmitOptions } from "./types.js";

afterEach(() => cleanup());

const human = (id: string, content: string) => ({ id, type: "human", content });
const ai = (id: string, content: string) => ({ id, type: "ai", content });

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

it("sends forkFrom as the run's checkpoint, with its command", async () => {
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
  expect(server.runs[0].payload).toMatchObject({
    checkpoint: { checkpoint_id: "cp-1" },
    command: { resume: "yes" },
  });
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
