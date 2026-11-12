import { StrictMode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "vitest-browser-react";
import { useStream } from "./use-stream.js";
import { fakeServer } from "./test-client.js";

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
