import { Client, type Message } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-svelte";
import BasicStream from "./components/BasicStream.svelte";
import HeadlessToolStream from "./components/HeadlessToolStream.svelte";
import InitialValuesStream from "./components/InitialValuesStream.svelte";
import StopMutateStream from "./components/StopMutateStream.svelte";
import StopFunctionalStream from "./components/StopFunctionalStream.svelte";
import OnStopCallback from "./components/OnStopCallback.svelte";
import StreamMetadataComponent from "./components/StreamMetadata.svelte";
import InterruptStream from "./components/InterruptStream.svelte";
import MessageRemoval from "./components/MessageRemoval.svelte";
import MultiSubmit from "./components/MultiSubmit.svelte";
import NewThreadId from "./components/NewThreadId.svelte";
import Branching from "./components/Branching.svelte";
import OnRequestComponent from "./components/OnRequest.svelte";
import SubgraphStream from "./components/SubgraphStream.svelte";
import ToolCallsStream from "./components/ToolCallsStream.svelte";
import InterruptsArray from "./components/InterruptsArray.svelte";
import SwitchThread from "./components/SwitchThread.svelte";
import QueueStream from "./components/QueueStream.svelte";
import QueueOnCreated from "./components/QueueOnCreated.svelte";
import SubmitOnError from "./components/SubmitOnError.svelte";
import DeepAgentStream from "./components/DeepAgentStream.svelte";
import RetainedSubagentStream from "./components/RetainedSubagentStream.svelte";
import CustomStreamMethods from "./components/CustomStreamMethods.svelte";
import CustomTransportStreamSubgraphs from "./components/CustomTransportStreamSubgraphs.svelte";
import HistoryMessages from "./components/HistoryMessages.svelte";
import StreamContextParent from "./components/StreamContextParent.svelte";
import StreamContextOrphan from "./components/StreamContextOrphan.svelte";
import ContextProvider from "./components/ContextProvider.svelte";
import { getStream, type UseStreamTransport } from "../index.js";

const serverUrl = inject("serverUrl");

it("renders initial state correctly", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
});

it("handles message submission and streaming", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("handles stop functionality", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("displays initial values immediately and clears them when submitting", async () => {
  const screen = render(InitialValuesStream, {
    options: {
      assistantId: "agent",
      apiUrl: serverUrl,
      initialValues: {
        messages: [
          { id: "cached-1", type: "human", content: "Cached user message" },
          { id: "cached-2", type: "ai", content: "Cached AI response" },
        ],
      },
    },
  });

  await expect
    .element(screen.getByTestId("message-cached-0"))
    .toHaveTextContent("Cached user message");
  await expect
    .element(screen.getByTestId("message-cached-1"))
    .toHaveTextContent("Cached AI response");

  await expect
    .element(screen.getByTestId("values"))
    .toHaveTextContent("Cached user message");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("onStop does not clear stream values", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");
});

it("onStop callback is called when stop is called", async () => {
  const screen = render(OnStopCallback, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("Yes");
  await expect
    .element(screen.getByTestId("has-mutate"))
    .toHaveTextContent("Yes");
});

it("onStop mutate function updates stream values immediately", async () => {
  const screen = render(StopMutateStream, {
    apiUrl: serverUrl,
    onStopMutate: (prev: Record<string, unknown>) => ({
      ...prev,
      messages: [{ type: "ai", content: "Stream stopped" }],
    }),
  });

  await expect
    .element(screen.getByTestId("stopped-status"))
    .toHaveTextContent("Not stopped");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("stopped-status"))
    .toHaveTextContent("Stopped");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Stream stopped");
});

it("onStop handles functional updates correctly", async () => {
  const screen = render(StopFunctionalStream, {
    apiUrl: serverUrl,
    onStopMutate: (prev: any) => ({
      ...prev,
      counter: (prev.counter || 0) + 10,
      items: [...(prev.items || []), "stopped"],
    }),
  });

  await expect.element(screen.getByTestId("counter")).toHaveTextContent("5");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("stop").click();

  await expect.element(screen.getByTestId("counter")).toHaveTextContent("15");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2, stopped");
});

it("onStop is not called when stream completes naturally", async () => {
  const screen = render(OnStopCallback, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("has-mutate"))
    .toHaveTextContent("No");
  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");
});

it("make sure to pass metadata to the thread", async () => {
  const threadId = crypto.randomUUID();

  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    submitOptions: { metadata: { random: "123" }, threadId },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  const client = new Client({ apiUrl: serverUrl });
  await expect
    .poll(async () => {
      const thread = await client.threads.get(threadId);
      return thread.metadata;
    })
    .toMatchObject({ random: "123" });
});

it("streamSubgraphs: true", async () => {
  const onCheckpointEvent = vi.fn();
  const onTaskEvent = vi.fn();
  const onUpdateEvent = vi.fn();
  const onCustomEvent = vi.fn();

  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    assistantId: "parentAgent",
    onCheckpointEvent,
    onTaskEvent,
    onUpdateEvent,
    onCustomEvent,
    submitOptions: { streamSubgraphs: true },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .poll(() => onCheckpointEvent.mock.calls.length)
    .toBeGreaterThanOrEqual(6);

  expect(onCheckpointEvent.mock.calls).toMatchObject([
    [{ metadata: { source: "input", step: -1 } }, { namespace: undefined }],
    [{ metadata: { source: "loop", step: 0 } }, { namespace: undefined }],
    [
      { metadata: { source: "input", step: -1 } },
      { namespace: [expect.any(String)] },
    ],
    [
      { metadata: { source: "loop", step: 0 } },
      { namespace: [expect.any(String)] },
    ],
    [
      { metadata: { source: "loop", step: 1 } },
      { namespace: [expect.any(String)] },
    ],
    [{ metadata: { source: "loop", step: 1 } }, { namespace: undefined }],
  ]);

  expect(onTaskEvent.mock.calls).toMatchObject([
    [{ name: "child", input: expect.anything() }, { namespace: undefined }],
    [
      { name: "agent", input: expect.anything() },
      { namespace: [expect.any(String)] },
    ],
    [
      { name: "agent", result: expect.anything() },
      { namespace: [expect.any(String)] },
    ],
    [{ name: "child", result: expect.anything() }, { namespace: undefined }],
  ]);

  expect(onUpdateEvent.mock.calls).toMatchObject([
    [
      { agent: { messages: expect.anything() } },
      { namespace: [expect.any(String)] },
    ],
    [{ child: { messages: expect.anything() } }, { namespace: undefined }],
  ]);

  expect(onCustomEvent.mock.calls).toMatchObject([
    ["Custom events", { namespace: [expect.any(String)] }],
  ]);
});

it("streamMetadata", async () => {
  const screen = render(StreamMetadataComponent, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("stream-metadata"))
    .toHaveTextContent("agent");
});

it("interrupts (fetchStateHistory: false)", async () => {
  const screen = render(InterruptStream, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("breakpoint");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("agent");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hey: Resuming");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("After interrupt");
});

it("handle message removal", async () => {
  const messagesValues = new Set<string>();

  const screen = render(MessageRemoval, {
    apiUrl: serverUrl,
    onRender: (msgs: string[]) => {
      messagesValues.add(msgs.join("\n"));
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("human: Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("ai: Step 2: To Keep");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("ai: Step 3: To Keep");

  expect([...messagesValues.values()]).toMatchObject(
    [
      [],
      ["human: Hello"],
      ["human: Hello", "ai: Step 1: To Remove"],
      ["human: Hello", "ai: Step 2: To Keep"],
      ["human: Hello", "ai: Step 2: To Keep", "ai: Step 3: To Keep"],
    ].map((msgs: string[]) => msgs.join("\n")),
  );
});

it("enqueue multiple .submit() calls", async () => {
  const messagesValues = new Set<string>();

  const screen = render(MultiSubmit, {
    apiUrl: serverUrl,
    onRender: (msgs: string[]) => {
      messagesValues.add(msgs.join("\n"));
    },
  });

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello (1)");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await screen.getByTestId("submit-second").click();

  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hello (2)");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("Hey");
});

it("accepts newThreadId option without errors", async () => {
  const spy = vi.fn();
  const predeterminedThreadId = crypto.randomUUID();

  const screen = render(NewThreadId, {
    apiUrl: serverUrl,
    onThreadId: spy,
    submitThreadId: predeterminedThreadId,
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent("Client ready");

  await screen.getByTestId("submit").click();

  await expect.poll(() => spy).toHaveBeenCalledWith(predeterminedThreadId);

  const client = new Client({ apiUrl: serverUrl });
  const thread = await client.threads.get(predeterminedThreadId);
  expect(thread.metadata).toMatchObject({
    graph_id: "agent",
    assistant_id: "agent",
  });
});

it("branching", async () => {
  const screen = render(Branching, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-0"))
    .not.toBeInTheDocument();

  await screen.getByTestId("regenerate-1").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");

  await screen.getByTestId("fork-0").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Fork: Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("2 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-nav-1"))
    .not.toBeInTheDocument();

  await screen.getByTestId("prev-0").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("1 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("2 / 2");

  await screen.getByTestId("prev-1").click();

  await expect
    .element(screen.getByTestId("content-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("branch-info-0"))
    .toHaveTextContent("1 / 2");
  await expect
    .element(screen.getByTestId("content-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("branch-info-1"))
    .toHaveTextContent("1 / 2");
});

it("fetchStateHistory: { limit: 2 }", async () => {
  const onRequestCalls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url, init) => {
      onRequestCalls.push({
        url: url.toString(),
        body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      });
      return init;
    },
  });

  const screen = render(OnRequestComponent, {
    apiUrl: serverUrl,
    client,
    fetchStateHistory: { limit: 2 },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .poll(
      () =>
        onRequestCalls.find((call) => call.url.includes("/history"))?.body?.limit,
      { timeout: 10000 },
    )
    .toBe(2);
});

it("onRequest gets called when a request is made", async () => {
  const onRequestCallback = vi.fn();

  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url: any, init: any) => {
      onRequestCallback(url.toString(), {
        ...init,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return init;
    },
  });

  const screen = render(OnRequestComponent, {
    apiUrl: serverUrl,
    client,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  expect(onRequestCallback.mock.calls).toMatchObject([
    [expect.stringContaining("/threads"), { method: "POST" }],
    [
      expect.stringContaining("/runs/stream"),
      {
        method: "POST",
        body: {
          input: { messages: [{ content: "Hello", type: "human" }] },
          assistant_id: "agent",
        },
      },
    ],
  ]);
});

it("interrupts (fetchStateHistory: true)", async () => {
  const screen = render(InterruptStream, {
    apiUrl: serverUrl,
    fetchStateHistory: true,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("breakpoint");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("interrupt"))
    .toHaveTextContent("agent");

  await screen.getByTestId("resume").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Before interrupt");
  await expect
    .element(screen.getByTestId("message-2"))
    .toHaveTextContent("Hey: Resuming");
  await expect
    .element(screen.getByTestId("message-3"))
    .toHaveTextContent("After interrupt");
});

it("handles subgraph streaming with event callbacks", async () => {
  const onCheckpointEvent = vi.fn();
  const onUpdateEvent = vi.fn();
  const onCustomEvent = vi.fn();

  const screen = render(SubgraphStream, {
    apiUrl: serverUrl,
    onCheckpointEvent,
    onUpdateEvent,
    onCustomEvent,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .poll(() => onCheckpointEvent.mock.calls.length)
    .toBeGreaterThanOrEqual(6);

  expect(
    onCheckpointEvent.mock.calls.some(
      (call: any[]) => call[1]?.namespace !== undefined,
    ),
  ).toBe(true);

  expect(onUpdateEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(onCustomEvent.mock.calls.length).toBeGreaterThanOrEqual(1);
});

it("exposes toolCalls property", async () => {
  const screen = render(ToolCallsStream, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("tool-calls-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("tool-calls-count"))
    .toHaveTextContent("1");
});

it("exposes interrupts array", async () => {
  const screen = render(InterruptsArray, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("interrupts-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .poll(() => screen.getByTestId("interrupts-count").element().textContent)
    .toBe("1");
});

it("switchThread clears messages and starts fresh", async () => {
  const screen = render(SwitchThread, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello from");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Reply on");

  const firstMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  const secondMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();
  expect(secondMessage).not.toBe(firstMessage);
});

it("switchThread to null clears messages", async () => {
  const screen = render(SwitchThread, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  await screen.getByTestId("switch-thread-null").click();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");
});

it("useStreamCustom exposes getMessagesMetadata, branch, setBranch", async () => {
  const screen = render(CustomStreamMethods, {
    apiUrl: serverUrl,
  });

  await expect.element(screen.getByTestId("branch")).toHaveTextContent("");

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("message-0")).toHaveTextContent("Hi");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hello!");

  await screen.getByTestId("set-branch").click();

  await expect
    .element(screen.getByTestId("branch"))
    .toHaveTextContent("test-branch");
});

it("useStreamCustom forwards streamSubgraphs to custom transport", async () => {
  type StreamState = { messages: Message[] };
  const streamTransport = vi.fn<UseStreamTransport<StreamState>["stream"]>(
    async () => {
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "values",
          data: {
            messages: [
              { id: "human-1", type: "human", content: "Hi" },
              { id: "ai-1", type: "ai", content: "Hello!" },
            ],
          },
        };
      }

      return generate();
    },
  );

  const screen = render(CustomTransportStreamSubgraphs, {
    streamTransport,
  });

  await screen.getByTestId("submit-custom-subgraphs").click();

  await expect.poll(() => streamTransport.mock.calls.length).toBe(1);
  expect(streamTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      input: {
        messages: [{ type: "human", content: "Hi" }],
      },
      streamSubgraphs: true,
      config: expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: expect.any(String),
        }),
      }),
    }),
  );
});

// Server-side queue e2e tests
it("server-side queue: submitting three times rapidly queues the latter two", async () => {
  const screen = render(QueueStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 10000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await expect
    .poll(() =>
      Array.from({ length: 8 }, (_, index) =>
        screen.getByTestId(`message-${index}`).element().textContent?.trim(),
      ),
    )
    .toEqual(["Hi", "Hey", "Msg1", "Hey", "Msg2", "Hey", "Msg3", "Hey"]);
});

it("server-side queue: queued inputs are displayed in queue.entries", async () => {
  const screen = render(QueueStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  const entriesEl = screen.getByTestId("queue-entries");
  await expect
    .element(entriesEl, { timeout: 5000 })
    .toHaveTextContent("Msg2,Msg3");
});

it("server-side queue: cancel removes a queued entry", async () => {
  const screen = render(QueueStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("queue-entries"))
    .toHaveTextContent("Msg2,Msg3");

  await screen.getByTestId("cancel-first").click();

  await expect
    .element(screen.getByTestId("queue-entries"), { timeout: 5000 })
    .toHaveTextContent("Msg3");
  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 10000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");
  await expect
    .poll(() =>
      Array.from({ length: 6 }, (_, index) =>
        screen.getByTestId(`message-${index}`).element().textContent?.trim(),
      ),
    )
    .toEqual(["Hi", "Hey", "Msg1", "Hey", "Msg3", "Hey"]);
});

it("server-side queue: clear empties the queue", async () => {
  const screen = render(QueueStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await screen.getByTestId("clear-queue").click();

  await expect
    .element(screen.getByTestId("queue-entries"), { timeout: 5000 })
    .toHaveTextContent("");
  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");
  await expect
    .poll(() =>
      Array.from({ length: 4 }, (_, index) =>
        screen.getByTestId(`message-${index}`).element().textContent?.trim(),
      ),
    )
    .toEqual(["Hi", "Hey", "Msg1", "Hey"]);
});

it("server-side queue: switchThread clears the queue", async () => {
  const screen = render(QueueStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("2");

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5000 })
    .toHaveTextContent("0");
});

it("server-side queue: follow-ups submitted from onCreated are drained", async () => {
  const screen = render(QueueOnCreated, { apiUrl: serverUrl });

  await screen.getByTestId("submit-presets").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5000 })
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 15000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5000 })
    .toHaveTextContent("0");

  await expect
    .poll(() =>
      Array.from({ length: 6 }, (_, index) =>
        screen.getByTestId(`message-${index}`).element().textContent?.trim(),
      ),
    )
    .toEqual(["Msg1", "Hey", "Msg2", "Hey", "Msg3", "Hey"]);
});

it("calls per-submit onError when stream fails", async () => {
  const screen = render(SubmitOnError, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("submit-error")).toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("deep agent: subagents call tools and render args/results", async () => {
  const screen = render(DeepAgentStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("subagent-researcher-status"))
    .toHaveTextContent("complete");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-status"))
    .toHaveTextContent("complete");

  await expect
    .element(screen.getByTestId("subagent-researcher-task-description"))
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-task-description"))
    .toHaveTextContent("Query the database for test data");

  await expect
    .element(screen.getByTestId("subagent-researcher-result"))
    .toHaveTextContent(/Result for: test research query/);
  await expect
    .element(screen.getByTestId("subagent-data-analyst-result"))
    .toHaveTextContent(/Record A/);
  await expect
    .element(screen.getByTestId("subagent-data-analyst-result"))
    .toHaveTextContent(/Record B/);

  // Verify subagent internal messages are populated (requires streamSubgraphs + filterSubagentMessages)
  await expect
    .element(screen.getByTestId("subagent-researcher-messages-count"), {
      timeout: 5_000,
    })
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-messages-count"))
    .not.toHaveTextContent("0");

  // Verify subagent tool calls are captured
  await expect
    .element(screen.getByTestId("subagent-researcher-toolcalls-count"))
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcalls-count"))
    .toHaveTextContent("1");

  // Verify the correct tools were called within each subagent
  await expect
    .element(screen.getByTestId("subagent-researcher-toolcall-names"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
    .toHaveTextContent("query_database");

  // Verify tool call state transitions (pending → completed)
  const observedStates = screen.getByTestId("observed-toolcall-states");
  const observedSubagentStatuses = screen.getByTestId("observed-subagent-statuses");
  await expect
    .element(observedSubagentStatuses)
    .toHaveTextContent(/data-analyst:(pending|running|complete)/);
  await expect
    .element(observedSubagentStatuses)
    .toHaveTextContent(/researcher:(pending|running|complete)/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:query_database:pending/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:search_web:pending/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:query_database:completed/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:search_web:completed/);

  const messages = screen.getByTestId("messages");
  await expect.element(messages).toHaveTextContent(/Run analysis/);
  await expect.element(messages).toHaveTextContent(/tool_call:task/);
  await expect.element(messages).toHaveTextContent(/researcher/);
  await expect.element(messages).toHaveTextContent(/data-analyst/);
  await expect.element(messages).toHaveTextContent(/tool_result:/);
  await expect
    .element(messages)
    .toHaveTextContent(/Both agents completed their tasks/);
});

it("deep agent: retained subagent references stay reactive", async () => {
  const screen = render(RetainedSubagentStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-toolcalls"), {
      timeout: 30_000,
    })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("retained-subagent-status"))
    .toHaveTextContent("complete");
});

it("deep agent: retained subagent summaries react to latest tool calls", async () => {
  const screen = render(RetainedSubagentStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-task"), {
      timeout: 30_000,
    })
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("retained-subagent-latest-tool-args"))
    .toHaveTextContent('"query":"test research query"');
});

it("stream.history returns BaseMessage instances", async () => {
  const screen = render(HistoryMessages, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("history-count"))
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("history-all-base-message"))
    .toHaveTextContent("true");
  await expect
    .element(screen.getByTestId("history-message-types"))
    .toHaveTextContent(/human/);
  await expect
    .element(screen.getByTestId("history-message-types"))
    .toHaveTextContent(/ai/);
});

// Stream context tests (main branch)
it("setStreamContext / getStreamContext shares stream with child components", async () => {
  const screen = render(StreamContextParent, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("parent-submit").click();

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("parent-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("parent-message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("child-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("child-message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");
});

it("getStreamContext throws when no parent has set context", async () => {
  const screen = render(StreamContextOrphan);

  await expect
    .element(screen.getByTestId("orphan-error"))
    .toHaveTextContent(
      "getStreamContext must be used within a component that has called setStreamContext",
    );
});

// provideStream / getStream context tests
it("provideStream shares stream state across child components", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
});

it("provideStream children can submit and receive messages", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("provideStream children can stop the stream", async () => {
  const screen = render(ContextProvider, {
    apiUrl: serverUrl,
  });

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("getStream throws when used outside a component", () => {
  expect(() => {
    getStream();
  }).toThrow();
});

it("headless tools - executes in browser and resumes agent automatically", async () => {
  const screen = render(HeadlessToolStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Where am I?");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});

it("headless tools - onTool callback fires start and success events", async () => {
  const screen = render(HeadlessToolStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-0"))
    .toHaveTextContent("start:get_location");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("success:get_location");
});

it("headless tools - propagates execute error back to agent as error payload", async () => {
  const failingExecute = async () => {
    throw new Error("GPS unavailable");
  };

  const screen = render(HeadlessToolStream, {
    apiUrl: serverUrl,
    execute: failingExecute,
  });

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("error:get_location:GPS unavailable");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});
