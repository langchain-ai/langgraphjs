import { Client, type Message } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-react";
import { useStreamContext, type UseStreamTransport } from "../index.js";
import { useStreamCustom } from "../stream.custom.js";
import { BasicStream } from "./components/BasicStream.js";
import { InitialValuesStream } from "./components/InitialValuesStream.js";
import { StopMutateStream } from "./components/StopMutateStream.js";
import { StopFunctionalStream } from "./components/StopFunctionalStream.js";
import { OnStopCallback } from "./components/OnStopCallback.js";
import { StreamMetadata } from "./components/StreamMetadata.js";
import { InterruptStream } from "./components/InterruptStream.js";
import { MessageRemoval } from "./components/MessageRemoval.js";
import { MultiSubmit } from "./components/MultiSubmit.js";
import { NewThreadId } from "./components/NewThreadId.js";
import { Branching } from "./components/Branching.js";
import { OnRequest } from "./components/OnRequest.js";
import { SwitchThread } from "./components/SwitchThread.js";
import { CustomStreamMethods } from "./components/CustomStreamMethods.js";
import { QueueStream } from "./components/QueueStream.js";
import { QueueOnCreated } from "./components/QueueOnCreated.js";
import { SubmitOnError } from "./components/SubmitOnError.js";
import { DeepAgentStream } from "./components/DeepAgentStream.js";
import { HistoryMessages } from "./components/HistoryMessages.js";
import { SuspenseBasicStream } from "./components/SuspenseBasicStream.js";
import { SuspenseErrorStream } from "./components/SuspenseErrorStream.js";
import { SuspenseWithThreadId } from "./components/SuspenseWithThreadId.js";
import { ContextProvider } from "./components/ContextProvider.js";
import { HeadlessToolStream } from "./components/HeadlessToolStream.js";

const serverUrl = inject("serverUrl");

async function expectMessageContents(
  screen: Awaited<ReturnType<typeof render>>,
  expected: string[],
) {
  await expect
    .poll(() =>
      expected.map(
        (_, index) =>
          screen.getByTestId(`message-${index}`).element().textContent?.trim() ?? "",
      ),
    )
    .toEqual(expected);
}

it("renders initial state correctly", async () => {
  const screen = await render(<BasicStream apiUrl={serverUrl} />);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
});

it("handles message submission and streaming", async () => {
  const screen = await render(<BasicStream apiUrl={serverUrl} />);

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
  const screen = await render(<BasicStream apiUrl={serverUrl} />);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("displays initial values immediately and clears them when submitting", async () => {
  const screen = await render(
    <InitialValuesStream
      options={{
        assistantId: "agent",
        apiUrl: serverUrl,
        initialValues: {
          messages: [
            { id: "cached-1", type: "human", content: "Cached user message" },
            { id: "cached-2", type: "ai", content: "Cached AI response" },
          ],
        },
      }}
    />,
  );

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
  const screen = await render(<BasicStream apiUrl={serverUrl} />);

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
  const screen = await render(<OnStopCallback apiUrl={serverUrl} />);

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
  const screen = await render(
    <StopMutateStream
      apiUrl={serverUrl}
      onStopMutate={(prev: Record<string, unknown>) => ({
        ...prev,
        messages: [{ type: "ai", content: "Stream stopped" }],
      })}
    />,
  );

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
  const screen = await render(
    <StopFunctionalStream
      apiUrl={serverUrl}
      onStopMutate={(prev) => ({
        ...prev,
        counter: prev.counter + 10,
        items: [...prev.items, "stopped"],
      })}
    />,
  );

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
  const screen = await render(<OnStopCallback apiUrl={serverUrl} />);

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
  await expect.element(screen.getByTestId("has-mutate")).toHaveTextContent("No");

  await expect
    .element(screen.getByTestId("onstop-called"))
    .toHaveTextContent("No");
});

it("make sure to pass metadata to the thread", async () => {
  const threadId = crypto.randomUUID();

  const screen = await render(
    <BasicStream
      apiUrl={serverUrl}
      submitOptions={{ metadata: { random: "123" }, threadId }}
    />,
  );

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

  const screen = await render(
    <BasicStream
      apiUrl={serverUrl}
      assistantId="parentAgent"
      onCheckpointEvent={onCheckpointEvent}
      onTaskEvent={onTaskEvent}
      onUpdateEvent={onUpdateEvent}
      onCustomEvent={onCustomEvent}
      submitOptions={{ streamSubgraphs: true }}
    />,
  );

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
  const screen = await render(<StreamMetadata apiUrl={serverUrl} />);

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
  const screen = await render(<InterruptStream apiUrl={serverUrl} />);

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

  const screen = await render(
    <MessageRemoval
      apiUrl={serverUrl}
      onRender={(msgs: string[]) => {
        messagesValues.add(msgs.join("\n"));
      }}
    />,
  );

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

  const screen = await render(
    <MultiSubmit
      apiUrl={serverUrl}
      onRender={(msgs: string[]) => {
        messagesValues.add(msgs.join("\n"));
      }}
    />,
  );

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

  const screen = await render(
    <NewThreadId
      apiUrl={serverUrl}
      onThreadId={spy}
      submitThreadId={predeterminedThreadId}
    />,
  );

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
  const screen = await render(<Branching apiUrl={serverUrl} />);

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
  const onRequestCallback = vi.fn();
  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), {
        ...init,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return init;
    },
  });

  const screen = await render(
    <OnRequest
      apiUrl={serverUrl}
      client={client}
      fetchStateHistory={{ limit: 2 }}
    />,
  );

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
        onRequestCallback.mock.calls.find(
          ([url]) => typeof url === "string" && url.includes("/history"),
        ),
      { timeout: 15_000 },
    )
    .toMatchObject([
      expect.stringMatching(/\/threads\/[^/]+\/history/),
      {
        method: "POST",
        body: {
          limit: 2,
        },
      },
    ]);
});

it("onRequest gets called when a request is made", async () => {
  const onRequestCallback = vi.fn();

  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url, init) => {
      onRequestCallback(url.toString(), {
        ...init,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return init;
    },
  });

  const screen = await render(<OnRequest apiUrl={serverUrl} client={client} />);

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
  const screen = await render(
    <InterruptStream apiUrl={serverUrl} fetchStateHistory={true} />,
  );

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

it("switchThread clears messages and starts fresh", async () => {
  const screen = await render(<SwitchThread />);

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
  const screen = await render(<SwitchThread />);

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
  const screen = await render(<CustomStreamMethods />);

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

it("useStreamCustom calls onFinish with a synthetic thread state", async () => {
  const onFinish = vi.fn();
  type StreamState = { messages: Message[] };
  const transport: UseStreamTransport<StreamState> = {
    async stream(payload) {
      const threadId = payload.config?.configurable?.thread_id ?? "unknown";

      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "values",
          data: {
            messages: [
              {
                id: `${threadId}-human`,
                type: "human",
                content: "Hello from custom transport",
              },
              {
                id: `${threadId}-ai`,
                type: "ai",
                content: "Finished",
              },
            ],
          },
        };
      }

      return generate();
    },
  };

  function OnFinishCustomStream() {
    const thread = useStreamCustom<StreamState>({
      transport,
      threadId: null,
      onThreadId: () => {},
      onFinish,
    });

    return (
      <div>
        <div data-testid="loading">
          {thread.isLoading ? "Loading..." : "Not loading"}
        </div>
        <button
          data-testid="submit"
          onClick={() => {
            const input = {
              messages: [{ type: "human", content: "Hi" }],
            } satisfies StreamState;

            void thread.submit(input);
          }}
        >
          Submit
        </button>
      </div>
    );
  }

  const screen = await render(<OnFinishCustomStream />);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  expect(onFinish).toHaveBeenCalledTimes(1);
  expect(onFinish).toHaveBeenCalledWith(
    expect.objectContaining({
      values: expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: "Hello from custom transport",
            type: "human",
          }),
          expect.objectContaining({
            content: "Finished",
            type: "ai",
          }),
        ]),
      }),
      next: [],
      tasks: [],
      created_at: null,
      parent_checkpoint: null,
      checkpoint: expect.objectContaining({
        thread_id: expect.any(String),
        checkpoint_id: null,
        checkpoint_ns: "",
        checkpoint_map: null,
      }),
    }),
    undefined,
  );
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

  function CustomTransportStreamSubgraphs() {
    const thread = useStreamCustom<StreamState>({
      transport: { stream: streamTransport },
      threadId: null,
      onThreadId: () => {},
    });

    return (
      <button
        data-testid="submit-custom-subgraphs"
        onClick={() =>
          void thread.submit(
            {
              messages: [{ type: "human", content: "Hi" } as Message],
            },
            { streamSubgraphs: true },
          )
        }
      >
        Submit
      </button>
    );
  }

  const screen = await render(<CustomTransportStreamSubgraphs />);
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

it("server-side queue: submitting three times rapidly queues the latter two", async () => {
  const screen = await render(<QueueStream apiUrl={serverUrl} />);

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
  await expectMessageContents(screen, [
    "Hi",
    "Hey",
    "Msg1",
    "Hey",
    "Msg2",
    "Hey",
    "Msg3",
    "Hey",
  ]);
});

it("server-side queue: queued inputs are displayed in queue.entries", async () => {
  const screen = await render(<QueueStream apiUrl={serverUrl} />);

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
  await expect.element(entriesEl).toHaveTextContent("Msg2,Msg3");
});

it("server-side queue: cancel removes a queued entry", async () => {
  const screen = await render(<QueueStream apiUrl={serverUrl} />);

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
  await expectMessageContents(screen, ["Hi", "Hey", "Msg1", "Hey", "Msg3", "Hey"]);
});

it("server-side queue: clear empties the queue", async () => {
  const screen = await render(<QueueStream apiUrl={serverUrl} />);

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
  await expectMessageContents(screen, ["Hi", "Hey", "Msg1", "Hey"]);
});

it("server-side queue: switchThread clears the queue", async () => {
  const screen = await render(<QueueStream apiUrl={serverUrl} />);

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
  const screen = await render(<QueueOnCreated apiUrl={serverUrl} />);

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
  await expectMessageContents(screen, [
    "Msg1",
    "Hey",
    "Msg2",
    "Hey",
    "Msg3",
    "Hey",
  ]);
});

it("calls per-submit onError when stream fails", async () => {
  const screen = await render(<SubmitOnError apiUrl={serverUrl} />);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("submit-error")).toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("deep agent: subagents call tools and render args/results", async () => {
  const screen = await render(<DeepAgentStream apiUrl={serverUrl} />);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  // Wait for the deep agent to complete
  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("subagent-data-analyst"))
    .toBeInTheDocument();
  await expect
    .element(screen.getByTestId("subagent-researcher"))
    .toBeInTheDocument();

  // Verify subagent statuses
  await expect
    .element(screen.getByTestId("subagent-researcher-status"))
    .toHaveTextContent("complete");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-status"))
    .toHaveTextContent("complete");

  // Verify task tool call args (description sent to each subagent)
  await expect
    .element(screen.getByTestId("subagent-researcher-task-description"))
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("subagent-data-analyst-task-description"))
    .toHaveTextContent("Query the database for test data");

  // Verify subagent results contain the actual tool return values
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
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:query_database:completed/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:search_web:completed/);

  // Verify main messages include the orchestrator's task tool calls and results
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

it("stream.history returns BaseMessage instances", async () => {
  const screen = await render(<HistoryMessages apiUrl={serverUrl} />);

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

// =====================================================================
// useSuspenseStream tests
// =====================================================================

it("useSuspenseStream: renders without suspense when no threadId", async () => {
  const screen = await render(<SuspenseBasicStream apiUrl={serverUrl} />);

  // Without a threadId, there is nothing to load; the component
  // should render immediately (no suspense fallback).
  await expect
    .element(screen.getByTestId("streaming"))
    .toHaveTextContent("Not streaming");
  await expect
    .element(screen.getByTestId("suspense-fallback"))
    .not.toBeInTheDocument();
});

it("useSuspenseStream: handles submit and streaming", async () => {
  const screen = await render(<SuspenseBasicStream apiUrl={serverUrl} />);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("streaming"))
    .toHaveTextContent("Not streaming");
});

it("useSuspenseStream: throws to error boundary on stream error", async () => {
  const screen = await render(<SuspenseErrorStream apiUrl={serverUrl} />);

  // Submit triggers the errorAgent which throws
  await screen.getByTestId("submit").click();

  // The error should propagate to the ErrorBoundary
  await expect.element(screen.getByTestId("error-boundary")).toBeVisible();
});

it("useSuspenseStream: suspends when loading existing thread", async () => {
  const screen = await render(<SuspenseWithThreadId apiUrl={serverUrl} />);

  // Create a thread first
  await screen.getByTestId("create-thread").click();

  // Wait for the thread ID to appear
  await expect
    .element(screen.getByTestId("thread-id"))
    .not.toHaveTextContent("none");

  // Submit a message to populate the thread
  await screen.getByTestId("submit").click();

  // Wait for streaming to complete
  await expect
    .element(screen.getByTestId("streaming"))
    .toHaveTextContent("Not streaming");

  // Verify messages appeared
  await expect
    .element(screen.getByTestId("message-count"))
    .not.toHaveTextContent("0");
});

// =====================================================================
// StreamProvider / useStreamContext tests
// =====================================================================

it("StreamProvider shares stream state across child components", async () => {
  const screen = await render(<ContextProvider apiUrl={serverUrl} />);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
});

it("StreamProvider children can submit and receive messages", async () => {
  const screen = await render(<ContextProvider apiUrl={serverUrl} />);

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

it("StreamProvider children can stop the stream", async () => {
  const screen = await render(<ContextProvider apiUrl={serverUrl} />);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("useStreamContext throws when used outside StreamProvider", async () => {
  function Orphan() {
    try {
      useStreamContext();
      return <div data-testid="result">no-error</div>;
    } catch (e: unknown) {
      const msg =
        e != null && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "unknown";
      return <div data-testid="result">{msg}</div>;
    }
  }

  const screen = await render(<Orphan />);
  await expect
    .element(screen.getByTestId("result"))
    .toHaveTextContent(
      "useStreamContext must be used within a <StreamProvider>",
    );
});

it("headless tools - executes in browser and resumes agent automatically", async () => {
  const screen = await render(<HeadlessToolStream apiUrl={serverUrl} />);

  await screen.getByTestId("submit").click();

  // useStream handles the browser_tool interrupt automatically — no user
  // action required. Wait for the full agent cycle to complete.
  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Where am I?");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});

it("headless tools - onTool callback fires start and success events", async () => {
  const screen = await render(<HeadlessToolStream apiUrl={serverUrl} />);

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

  const screen = await render(
    <HeadlessToolStream apiUrl={serverUrl} execute={failingExecute} />,
  );

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("error:get_location:GPS unavailable");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});
