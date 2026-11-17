import { expect, inject, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Client } from "../../client.js";
import { Branching, DeepAgentStream, Stream } from "./components.js";

type Screen = Awaited<ReturnType<typeof render>>;

const apiUrl = inject("serverUrl");
const client = new Client({ apiUrl });

const messages = (screen: Screen) =>
  Array.from(
    screen.getByTestId("messages").element().children,
    (element) => element.textContent
  );

it("streams a reply", async () => {
  const screen = await render(<Stream />);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("stop mid-stream cancels the run and shows what the server kept", async () => {
  let threadId = "";
  const screen = await render(
    <Stream
      options={{
        onThreadId: (id) => {
          threadId = id;
        },
      }}
    />
  );

  await screen.getByTestId("submit").click();
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");
  await screen.getByTestId("stop").click();

  await expect.poll(() => messages(screen)).toEqual(["Hello"]);
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const [run] = await client.runs.list(threadId);
  await expect
    .poll(async () => (await client.runs.get(threadId, run.run_id)).status)
    .toBe("interrupted");
});

it("a submit with a new threadId creates that thread with the submit metadata", async () => {
  const threadId = crypto.randomUUID();
  const onThreadId = vi.fn();
  const screen = await render(
    <Stream
      options={{ onThreadId }}
      submitOptions={{ threadId, metadata: { random: "123" } }}
    />
  );

  await screen.getByTestId("submit").click();

  await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
  expect(onThreadId).toHaveBeenCalledWith(threadId);
  expect((await client.threads.get(threadId)).metadata).toMatchObject({
    random: "123",
    graph_id: "agent",
  });
});

it("streamSubgraphs: true delivers subgraph events with their namespace", async () => {
  const onCheckpointEvent = vi.fn();
  const onTaskEvent = vi.fn();
  const onUpdateEvent = vi.fn();
  const onCustomEvent = vi.fn();
  const screen = await render(
    <Stream
      options={{
        assistantId: "parentAgent",
        onCheckpointEvent,
        onTaskEvent,
        onUpdateEvent,
        onCustomEvent,
      }}
      submitOptions={{ streamSubgraphs: true }}
    />
  );

  await screen.getByTestId("submit").click();

  await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const child = { namespace: [expect.stringMatching(/^child:/)] };
  const root = { namespace: undefined };
  expect(onCheckpointEvent.mock.calls).toMatchObject([
    [{ metadata: { source: "input", step: -1 } }, root],
    [{ metadata: { source: "loop", step: 0 } }, root],
    [{ metadata: { source: "input", step: -1 } }, child],
    [{ metadata: { source: "loop", step: 0 } }, child],
    [{ metadata: { source: "loop", step: 1 } }, child],
    [{ metadata: { source: "loop", step: 1 } }, root],
  ]);
  expect(onTaskEvent.mock.calls).toMatchObject([
    [{ name: "child", input: expect.anything() }, root],
    [{ name: "agent", input: expect.anything() }, child],
    [{ name: "agent", result: expect.anything() }, child],
    [{ name: "child", result: expect.anything() }, root],
  ]);
  expect(onUpdateEvent.mock.calls).toMatchObject([
    [{ agent: { messages: expect.anything() } }, child],
    [{ child: { messages: expect.anything() } }, root],
  ]);
  expect(onCustomEvent.mock.calls).toMatchObject([["Custom events", child]]);
});

it("each streamed message carries the node that produced it", async () => {
  const screen = await render(<Stream />);

  await screen.getByTestId("submit").click();

  await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveAttribute("data-node", "agent");
});

it("resumes a breakpoint, then an interrupt", async () => {
  const screen = await render(
    <Stream
      options={{ assistantId: "interruptAgent", fetchStateHistory: true }}
      submitOptions={{ interruptBefore: ["beforeInterrupt"] }}
    />
  );

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("breakpoint");

  await screen.getByTestId("resume").click();
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent('{"nodeName":"agent"}');
  await expect
    .poll(() => messages(screen))
    .toEqual(["Hello", "Before interrupt"]);

  await screen.getByTestId("resume").click();
  await expect
    .poll(() => messages(screen))
    .toEqual(["Hello", "Before interrupt", "Hey: Resuming", "After interrupt"]);
  await expect.element(screen.getByTestId("interrupt")).not.toBeInTheDocument();
});

it("shows and resumes an interrupt without fetching history", async () => {
  const screen = await render(
    <Stream options={{ assistantId: "interruptAgent" }} />
  );

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent('{"nodeName":"agent"}');

  await screen.getByTestId("resume").click();
  await expect
    .poll(() => messages(screen))
    .toEqual(["Hello", "Before interrupt", "Hey: Resuming", "After interrupt"]);
  await expect.element(screen.getByTestId("interrupt")).not.toBeInTheDocument();
});

it("a removed message disappears while the run streams", async () => {
  const renders = new Set<string>();
  const screen = await render(
    <Stream
      options={{ assistantId: "removeMessageAgent", throttle: false }}
      onRender={(list) =>
        renders.add(list.map((m) => `${m.type}: ${m.content}`).join("\n"))
      }
    />
  );

  await screen.getByTestId("submit").click();

  await expect
    .poll(() => messages(screen))
    .toEqual(["Hello", "Step 2: To Keep", "Step 3: To Keep"]);
  expect([...renders]).toEqual([
    "",
    "human: Hello",
    "human: Hello\nai: Step 1: To Remove",
    "human: Hello\nai: Step 2: To Keep",
    "human: Hello\nai: Step 2: To Keep\nai: Step 3: To Keep",
  ]);
});

it("a second submit continues the same thread", async () => {
  const screen = await render(<Stream />);

  await screen.getByTestId("submit").click();
  await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await screen.getByTestId("submit").click();

  await expect
    .poll(() => messages(screen))
    .toEqual(["Hello", "Hey", "Hello", "Hey"]);
});

it("regenerating and forking create branches the user can switch between", async () => {
  const screen = await render(<Branching />);

  await screen.getByTestId("submit").click();
  await expect.element(screen.getByTestId("content-1")).toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-0"))
    .not.toBeInTheDocument();

  await screen.getByTestId("regenerate-1").click();
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");
  await expect.element(screen.getByTestId("content-1")).toHaveTextContent("Hey");

  await screen.getByTestId("fork-0").click();
  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Fork: Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("2 / 2");
  await expect.element(screen.getByTestId("content-1")).toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-1"))
    .not.toBeInTheDocument();

  await screen.getByTestId("prev-0").click();
  await expect.element(screen.getByTestId("content-0")).toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("1 / 2");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");

  await screen.getByTestId("prev-1").click();
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("1 / 2");
  await expect.element(screen.getByTestId("content-1")).toHaveTextContent("Hey");
});

it("a rejoin on mount sends the loaded head's checkpoint and shows each message once", async () => {
  const requests: string[] = [];
  const recording = new Client({
    apiUrl,
    onRequest: (url, init) => {
      requests.push(url.toString());
      return init;
    },
  });
  const thread = await recording.threads.create();
  let runId = "";
  for await (const part of recording.runs.stream(thread.thread_id, "agent", {
    input: { messages: [{ type: "human", content: "Hello" }] },
    streamResumable: true,
  })) {
    if (part.event === "metadata") runId = part.data.run_id;
  }
  const head = await recording.threads.getState(thread.thread_id);
  window.sessionStorage.setItem(`lg:stream:${thread.thread_id}`, runId);
  requests.length = 0;

  try {
    const screen = await render(
      <Stream
        options={{
          client: recording,
          threadId: thread.thread_id,
          reconnectOnMount: true,
        }}
      />
    );

    await expect.poll(() => messages(screen)).toEqual(["Hello", "Hey"]);
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    expect(messages(screen)).toEqual(["Hello", "Hey"]);
    const join = requests.find((url) => url.includes(`/runs/${runId}/stream`));
    expect(join && new URL(join).searchParams.get("checkpoint_id")).toBe(
      head.checkpoint.checkpoint_id
    );
  } finally {
    window.sessionStorage.removeItem(`lg:stream:${thread.thread_id}`);
  }
});

it("a failed run reaches onError and the error state", async () => {
  const onError = vi.fn();
  const screen = await render(
    <Stream options={{ assistantId: "errorAgent", onError }} />
  );

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("error"))
    .toHaveTextContent("Intentional error for testing");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  expect(onError).toHaveBeenCalledOnce();
});

it("a deep agent's subagents show their task, tool calls and result", async () => {
  const screen = await render(<DeepAgentStream />);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const subagents = [
    {
      type: "researcher",
      task: "Search the web for test research query",
      toolCalls: /^search_web:completed$/,
      result: /Result for: test research query/,
    },
    {
      type: "data-analyst",
      task: "Query the database for test data",
      toolCalls: /^query_database:completed$/,
      result: /Record A.*Record B/,
    },
  ];
  for (const { type, task, toolCalls, result } of subagents) {
    const field = (name: string) =>
      expect.element(screen.getByTestId(`subagent-${type}-${name}`));
    await field("status").toHaveTextContent("complete");
    await field("task-description").toHaveTextContent(task);
    await field("tool-calls").toHaveTextContent(toolCalls);
    await field("result").toHaveTextContent(result);
    await field("messages-count").not.toHaveTextContent(/^0$/);
  }
  const shown = screen.getByTestId("messages");
  await expect.element(shown).toHaveTextContent("Run analysis");
  await expect.element(shown).toHaveTextContent("tool_call:task");
  await expect.element(shown).toHaveTextContent("tool_result:");
  await expect
    .element(shown)
    .toHaveTextContent("Both agents completed their tasks successfully.");
});
