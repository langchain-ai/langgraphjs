import { Client, type Message } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, ref } from "vue";
import { useStream } from "../index.js";

const serverUrl = inject("serverUrl");

it("renders initial state correctly", async () => {
  const TestComponent = defineComponent({
    setup() {
      const { messages, isLoading, error, submit, stop } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          {error.value ? (
            <div data-testid="error">{String(error.value)}</div>
          ) : null}
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0"))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId("error"))
    .not.toBeInTheDocument();
});

it("handles message submission and streaming", async () => {
  const TestComponent = defineComponent({
    setup() {
      const { messages, isLoading, submit } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { isLoading, submit, stop } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("displays initial values immediately and clears them when submitting", async () => {
  const TestComponent = defineComponent({
    setup() {
      const { messages, values, submit } = useStream<{
        messages: Message[];
      }>({
        assistantId: "agent",
        apiUrl: serverUrl,
        initialValues: {
          messages: [
            { id: "cached-1", type: "human", content: "Cached user message" },
            { id: "cached-2", type: "ai", content: "Cached AI response" },
          ],
        },
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div
                key={msg.id ?? i}
                data-testid={
                  msg.id?.includes("cached")
                    ? `message-cached-${i}`
                    : `message-${i}`
                }
              >
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="values">{JSON.stringify(values.value)}</div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Submit
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { submit, stop, isLoading, messages } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({
                messages: [{ content: "Hello", type: "human" }],
              })
            }
          >
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("H");
});

it("onStop callback is called when stop is called", async () => {
  const onStopCallback = vi.fn();

  const TestComponent = defineComponent({
    setup() {
      const { submit, stop } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        onStop: onStopCallback,
      });

      return () => (
        <div>
          <button data-testid="submit" onClick={() => void submit({})}>
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .poll(() => onStopCallback.mock.calls.length)
    .toBe(1);
  expect(onStopCallback).toHaveBeenCalledWith(
    expect.objectContaining({
      mutate: expect.any(Function),
    })
  );
});

it("onStop mutate function updates stream values immediately", async () => {
  const TestComponent = defineComponent({
    setup() {
      const stopped = ref(false);
      const { submit, stop, messages, isLoading } = useStream<{
        messages: Message[];
      }>({
        assistantId: "agent",
        apiUrl: serverUrl,
        onStop: ({ mutate }: { mutate: (fn: (prev: any) => any) => void }) => {
          stopped.value = true;
          mutate((prev: Record<string, unknown>) => ({
            ...prev,
            messages: [{ type: "ai", content: "Stream stopped" }],
          }));
        },
      });

      return () => (
        <div>
          <div data-testid="stopped-status">
            {stopped.value ? "Stopped" : "Not stopped"}
          </div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({
                messages: [{ content: "Hello", type: "human" }],
              })
            }
          >
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await expect
    .element(screen.getByTestId("stopped-status"))
    .toHaveTextContent("Not stopped");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
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
  const TestComponent = defineComponent({
    setup() {
      const { submit, stop, values, isLoading } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        initialValues: {
          counter: 5,
          items: ["item1", "item2"],
        },
        onStop: ({ mutate }: any) => {
          mutate((prev: any) => ({
            ...prev,
            counter: (prev.counter || 0) + 10,
            items: [...(prev.items || []), "stopped"],
          }));
        },
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="counter">
            {(values.value as any).counter}
          </div>
          <div data-testid="items">
            {(values.value as any).items?.join(", ")}
          </div>
          <button
            data-testid="submit"
            onClick={() => void submit({} as any)}
          >
            Send
          </button>
          <button data-testid="stop" onClick={() => void stop()}>
            Stop
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await expect
    .element(screen.getByTestId("counter"))
    .toHaveTextContent("5");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("counter"))
    .toHaveTextContent("15");
  await expect
    .element(screen.getByTestId("items"))
    .toHaveTextContent("item1, item2, stopped");
});

it("onStop is not called when stream completes naturally", async () => {
  const onStopCallback = vi.fn();

  const TestComponent = defineComponent({
    setup() {
      const { submit, isLoading } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        onStop: onStopCallback,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button data-testid="submit" onClick={() => void submit({})}>
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  expect(onStopCallback).not.toHaveBeenCalled();
});

it("make sure to pass metadata to the thread", async () => {
  const threadId = crypto.randomUUID();

  const TestComponent = defineComponent({
    setup() {
      const { submit, messages } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { metadata: { random: "123" }, threadId }
              )
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  const client = new Client({ apiUrl: serverUrl });
  const thread = await client.threads.get(threadId);
  expect(thread.metadata).toMatchObject({ random: "123" });
});

it("streamSubgraphs: true", async () => {
  const onCheckpointEvent = vi.fn();
  const onTaskEvent = vi.fn();
  const onUpdateEvent = vi.fn();
  const onCustomEvent = vi.fn();

  const TestComponent = defineComponent({
    setup() {
      const { submit, messages } = useStream({
        assistantId: "parentAgent",
        apiUrl: serverUrl,
        onCheckpointEvent,
        onTaskEvent,
        onUpdateEvent,
        onCustomEvent,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { streamSubgraphs: true }
              )
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { submit, messages, getMessagesMetadata } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => {
              const metadata = getMessagesMetadata(msg, i);
              return (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  {typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)}

                  {metadata?.streamMetadata && (
                    <div data-testid="stream-metadata">
                      {metadata.streamMetadata?.langgraph_node as string}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { submit, interrupt, messages } = useStream<
        { messages: Message[] },
        { InterruptType: { nodeName: string } }
      >({
        assistantId: "interruptAgent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          {interrupt.value ? (
            <div>
              <div data-testid="interrupt">
                {interrupt.value.when ?? interrupt.value.value?.nodeName}
              </div>
              <button
                data-testid="resume"
                onClick={() =>
                  void submit(null as any, { command: { resume: "Resuming" } })
                }
              >
                Resume
              </button>
            </div>
          ) : null}
          <button
            data-testid="submit"
            onClick={() =>
              void submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { interruptBefore: ["beforeInterrupt"] }
              )
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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

  const TestComponent = defineComponent({
    setup() {
      const { submit, messages, isLoading } = useStream({
        assistantId: "removeMessageAgent",
        apiUrl: serverUrl,
        throttle: false,
      });

      return () => {
        const rawMessages = messages.value.map((msg: Message, i: number) => ({
          id: msg.id ?? i,
          content: `${msg.type}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`,
        }));

        messagesValues.add(rawMessages.map((msg) => msg.content).join("\n"));

        return (
          <div>
            <div data-testid="loading">
              {isLoading.value ? "Loading..." : "Not loading"}
            </div>
            <div data-testid="messages">
              {rawMessages.map(
                (msg: { id: string | number; content: string }, i: number) => (
                  <div key={msg.id} data-testid={`message-${i}`}>
                    <span>{msg.content}</span>
                  </div>
                )
              )}
            </div>
            <button
              data-testid="submit"
              onClick={() =>
                void submit({ messages: [{ content: "Hello", type: "human" }] })
              }
            >
              Send
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

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
    ].map((msgs: string[]) => msgs.join("\n"))
  );
});

it("enqueue multiple .submit() calls", async () => {
  const messagesValues = new Set<string>();

  const TestComponent = defineComponent({
    setup() {
      const { submit, messages, isLoading } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });

      return () => {
        const rawMessages = messages.value.map((msg: Message, i: number) => ({
          id: msg.id ?? i,
          content: `${msg.type}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`,
        }));

        messagesValues.add(rawMessages.map((msg) => msg.content).join("\n"));

        return (
          <div>
            <div data-testid="loading">
              {isLoading.value ? "Loading..." : "Not loading"}
            </div>
            <div data-testid="messages">
              {rawMessages.map(
                (msg: { id: string | number; content: string }, i: number) => (
                  <div key={msg.id} data-testid={`message-${i}`}>
                    <span>{msg.content}</span>
                  </div>
                )
              )}
            </div>
            <button
              data-testid="submit-first"
              onClick={() =>
                void submit({
                  messages: [{ content: "Hello (1)", type: "human" }],
                })
              }
            >
              Send First
            </button>
            <button
              data-testid="submit-second"
              onClick={() =>
                void submit({
                  messages: [{ content: "Hello (2)", type: "human" }],
                })
              }
            >
              Send Second
            </button>
          </div>
        );
      };
    },
  });

  const screen = render(TestComponent);

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

  const TestComponent = defineComponent({
    setup() {
      const stream = useStream<{ messages: Message[] }>({
        assistantId: "agent",
        apiUrl: serverUrl,
        threadId: null,
        onThreadId: spy,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="thread-id">Client ready</div>
          <button
            data-testid="submit"
            onClick={() =>
              void stream.submit({} as any, { threadId: predeterminedThreadId })
            }
          >
            Submit
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { submit, messages, getMessagesMetadata, setBranch } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        fetchStateHistory: true,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => {
              const metadata = getMessagesMetadata(msg, i);
              const checkpoint =
                metadata?.firstSeenState?.parent_checkpoint ?? undefined;
              const text =
                typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
              const branchOptions = metadata?.branchOptions;
              const branch = metadata?.branch;
              const branchIndex =
                branchOptions && branch
                  ? branchOptions.indexOf(branch)
                  : -1;

              return (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  <div data-testid={`content-${i}`}>{text}</div>

                  {branchOptions && branch && (
                    <div data-testid={`branch-nav-${i}`}>
                      <button
                        data-testid={`prev-${i}`}
                        onClick={() => {
                          const prevBranch = branchOptions[branchIndex - 1];
                          if (prevBranch) setBranch(prevBranch);
                        }}
                      >
                        Previous
                      </button>
                      <span data-testid={`branch-info-${i}`}>
                        {branchIndex + 1} / {branchOptions.length}
                      </span>
                      <button
                        data-testid={`next-${i}`}
                        onClick={() => {
                          const nextBranch = branchOptions[branchIndex + 1];
                          if (nextBranch) setBranch(nextBranch);
                        }}
                      >
                        Next
                      </button>
                    </div>
                  )}

                  {msg.type === "human" && (
                    <button
                      data-testid={`fork-${i}`}
                      onClick={() =>
                        void submit(
                          {
                            messages: [
                              { type: "human", content: `Fork: ${text}` },
                            ],
                          } as any,
                          { checkpoint }
                        )
                      }
                    >
                      Fork
                    </button>
                  )}

                  {msg.type === "ai" && (
                    <button
                      data-testid={`regenerate-${i}`}
                      onClick={() =>
                        void submit(undefined as any, { checkpoint })
                      }
                    >
                      Regenerate
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({
                messages: [{ content: "Hello", type: "human" }],
              } as any)
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { messages, isLoading, submit } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        fetchStateHistory: { limit: 2 },
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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

  const TestComponent = defineComponent({
    setup() {
      const { submit, messages } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        client,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void submit({ messages: [{ content: "Hello", type: "human" }] })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const { submit, interrupt, messages } = useStream<
        { messages: Message[] },
        { InterruptType: { nodeName: string } }
      >({
        assistantId: "interruptAgent",
        apiUrl: serverUrl,
        fetchStateHistory: true,
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg: Message, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          {interrupt.value ? (
            <div>
              <div data-testid="interrupt">
                {interrupt.value.when ?? interrupt.value.value?.nodeName}
              </div>
              <button
                data-testid="resume"
                onClick={() =>
                  void submit(null as any, { command: { resume: "Resuming" } })
                }
              >
                Resume
              </button>
            </div>
          ) : null}
          <button
            data-testid="submit"
            onClick={() =>
              void submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { interruptBefore: ["beforeInterrupt"] }
              )
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
