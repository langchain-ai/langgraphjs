import { Suspense, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "vitest-browser-react";
import { STREAM_CONTROLLER, useStream } from "./use-stream.js";
import {
  useChannel,
  useChannelEffect,
  useMessageMetadata,
  useMessages,
  useSubmissionQueue,
} from "./selectors.js";
import { engineOf, subscribeScope } from "./use-scoped.js";
import { useSuspenseStream } from "./suspense-stream.js";
import { fakeServer } from "./test-client.js";

afterEach(() => cleanup());

const human = (id: string, content: string) => ({ id, type: "human", content });
const ai = (id: string, content: string) => ({ id, type: "ai", content });
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** A thread whose `task` call ran a researcher subagent at `tools:abc`. */
function subagentThread() {
  const server = fakeServer({
    t1: {
      messages: [
        human("h1", "research tires"),
        {
          ...ai("a1", ""),
          tool_calls: [
            {
              id: "call-1",
              name: "task",
              args: { subagent_type: "researcher", description: "look" },
            },
          ],
        },
        {
          id: "tm1",
          type: "tool",
          name: "task",
          tool_call_id: "call-1",
          content: "done",
          artifact: { checkpoint_ns: "tools:abc" },
        },
      ],
    },
  });
  server.history.set("tools:abc", {
    messages: [human("s1", "look"), ai("s2", "found it")],
  });
  return server;
}

it("reads a reloaded subagent's messages once, from the namespace its tool message records", async () => {
  const server = subagentThread();
  const { result } = await renderHook(() => {
    const stream = useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
    });
    const subagent = stream.subagents.get("call-1");
    return { subagent, messages: useMessages(stream, subagent) };
  });

  await expect
    .poll(() => result.current.messages.map((message) => message.content))
    .toEqual(["look", "found it"]);
  expect(result.current.subagent).toMatchObject({
    name: "researcher",
    taskInput: "look",
    status: "complete",
    namespace: ["tools:abc"],
  });
  await tick();
  expect(
    server.calls.filter((call) => call === "getHistory t1 tools:abc")
  ).toHaveLength(1);
});

it("releases every scope a subagent panel held once it unmounts", async () => {
  const server = subagentThread();
  const stream = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => stream.result.current.subagents.size).toBe(1);
  const { scopes } = stream.result.current[STREAM_CONTROLLER];
  const acquire = scopes.acquire.bind(scopes);
  let held = 0;
  vi.spyOn(scopes, "acquire").mockImplementation((namespace) => {
    held += 1;
    const scope = acquire(namespace);
    return {
      ...scope,
      release: () => {
        held -= 1;
        scope.release();
      },
    };
  });

  const panel = await renderHook(() =>
    useMessages(
      stream.result.current,
      stream.result.current.subagents.get("call-1")
    )
  );
  await expect.poll(() => panel.result.current.length).toBe(2);
  expect(held).toBeGreaterThan(0);
  await panel.unmount();
  await tick();
  expect(held).toBe(0);
});

it("acquires nothing for a scope released before its namespace resolves", async () => {
  const server = subagentThread();
  const { result } = await renderHook(() =>
    useStream({ assistantId: "agent", client: server.client, threadId: "t1" })
  );
  await expect.poll(() => result.current.subagents.size).toBe(1);
  const handle = subscribeScope(
    result.current,
    result.current.subagents.get("call-1")
  );
  handle.release();
  await tick();
  expect(server.calls).not.toContain("getHistory t1 tools:abc");
  expect(handle.getSnapshot().messages).toEqual([]);
});

it("keeps the last bufferSize channel events and clears them on a thread switch", async () => {
  const server = fakeServer({ a: { messages: [] }, b: { messages: [] } });
  const { result, rerender } = await renderHook(
    (props?: { threadId: string }) => {
      const stream = useStream({
        assistantId: "agent",
        client: server.client,
        threadId: props?.threadId,
      });
      return {
        stream,
        events: useChannel(stream, ["custom"], undefined, { bufferSize: 2 }),
      };
    },
    { initialProps: { threadId: "a" } }
  );
  await expect.poll(() => result.current.stream.isThreadLoading).toBe(false);
  void result.current.stream.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  for (const n of [1, 2, 3]) server.runs[0].send("custom", { n });
  server.runs[0].send("updates", { agent: {} });

  await expect
    .poll(() =>
      result.current.events.map(
        (event) => (event.params.data as { payload: { n: number } }).payload.n
      )
    )
    .toEqual([2, 3]);
  await rerender({ threadId: "b" });
  await expect.poll(() => result.current.events).toEqual([]);

  await expect.poll(() => result.current.stream.isLoading).toBe(false);
  void result.current.stream.submit({ messages: [human("h2", "hi")] });
  await expect.poll(() => server.runs.length).toBe(2);
  server.runs[1].send("custom", { n: 4 });
  await expect
    .poll(() =>
      result.current.events.map(
        (event) => (event.params.data as { payload: { n: number } }).payload.n
      )
    )
    .toEqual([4]);
});

it("stops calling onEvent once disabled", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const onEvent = vi.fn();
  const { result, rerender } = await renderHook(
    (props?: { enabled: boolean }) => {
      const stream = useStream({
        assistantId: "agent",
        client: server.client,
        threadId: "t1",
      });
      useChannelEffect(stream, ["custom"], {
        enabled: props?.enabled,
        onEvent,
      });
      return stream;
    },
    { initialProps: { enabled: true } }
  );
  await expect.poll(() => result.current.isThreadLoading).toBe(false);
  void result.current.submit({ messages: [human("h1", "hi")] });
  await expect.poll(() => server.runs.length).toBe(1);
  server.runs[0].send("custom", { n: 1 });
  await expect.poll(() => onEvent.mock.calls.length).toBe(1);

  await rerender({ enabled: false });
  server.runs[0].send("custom", { n: 2 });
  await tick();
  expect(onEvent).toHaveBeenCalledTimes(1);
});

it("reads fork points only while useMessageMetadata is mounted", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  const readsHistory = () => server.calls.includes("getHistory t1");
  function Message({ stream }: { stream: ReturnType<typeof useStream> }) {
    useMessageMetadata(stream, "h1");
    return null;
  }
  function Chat() {
    const [tracked, setTracked] = useState(false);
    const stream = useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
    });
    return (
      <>
        <button onClick={() => setTracked(true)}>track</button>
        {tracked && <Message stream={stream} />}
        <span>{stream.messages.length}</span>
      </>
    );
  }
  const screen = await render(<Chat />);
  await expect.element(screen.getByText("1")).toBeVisible();
  await tick();
  expect(readsHistory()).toBe(false);

  await screen.getByRole("button").click();
  await expect.poll(readsHistory).toBe(true);
});

it("lists a submit queued during a run and cancels it", async () => {
  const server = fakeServer({ t1: { messages: [] } });
  const { result } = await renderHook(() => {
    const stream = useStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
    });
    return { stream, queue: useSubmissionQueue(stream) };
  });
  await expect.poll(() => result.current.stream.isThreadLoading).toBe(false);
  void result.current.stream.submit({ messages: [human("h1", "first")] });
  await expect.poll(() => result.current.stream.isLoading).toBe(true);
  void result.current.stream.submit({ messages: [human("h2", "second")] });

  await expect.poll(() => result.current.queue.size).toBe(1);
  const [entry] = result.current.queue.entries;
  expect(entry.runId).toBe(entry.id);
  await result.current.queue.cancel(entry.id);
  await expect.poll(() => result.current.queue.size).toBe(0);
  expect(server.calls).toContain(`cancel ${entry.id}`);
});

it("suspends until the first load, reading the thread once, and works with the selector hooks", async () => {
  const server = fakeServer({ t1: { messages: [human("h1", "hi")] } });
  function Chat() {
    const stream = useSuspenseStream({
      assistantId: "agent",
      client: server.client,
      threadId: "t1",
    });
    return <span>{useMessages(stream).length} message</span>;
  }
  const screen = await render(
    <Suspense fallback={<span>loading</span>}>
      <Chat />
    </Suspense>
  );
  await expect.element(screen.getByText("1 message")).toBeVisible();
  expect(server.calls.filter((call) => call === "getState t1")).toHaveLength(1);
});

it("says what to pass when a selector hook gets something that isn't a stream", () => {
  expect(() => engineOf({} as never)).toThrow(
    "pass the selector hooks the result of useStream or useSuspenseStream"
  );
});
