import { Client, type Message } from "@langchain/langgraph-sdk";
import { it, expect, vi, inject } from "vitest";
import { render } from "vitest-browser-vue";
import { computed, defineComponent, ref, watchEffect } from "vue";
import {
  useStream,
  provideStream,
  useStreamContext,
  type UseStreamTransport,
} from "../index.js";
import { useStreamCustom } from "../stream.custom.js";
import {
  type DeepAgentGraph,
  getLocationTool,
} from "./fixtures/browser-fixtures.js";

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
            {messages.value.map((msg, i) => (
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
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
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
            {messages.value.map((msg, i: number) => (
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
            {messages.value.map((msg, i: number) => (
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
            {messages.value.map((msg, i: number) => (
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
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");

  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("H");
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

  await expect.poll(() => onStopCallback.mock.calls.length).toBe(1);
  expect(onStopCallback).toHaveBeenCalledWith(
    expect.objectContaining({
      mutate: expect.any(Function),
    }),
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
            {messages.value.map((msg, i: number) => (
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
          <div data-testid="counter">{(values.value as any).counter}</div>
          <div data-testid="items">
            {(values.value as any).items?.join(", ")}
          </div>
          <button data-testid="submit" onClick={() => void submit({} as any)}>
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
            {messages.value.map((msg, i: number) => (
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
                { metadata: { random: "123" }, threadId },
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
            {messages.value.map((msg, i: number) => (
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
                { streamSubgraphs: true },
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
            {messages.value.map((msg, i: number) => {
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
            {messages.value.map((msg, i: number) => (
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
                {interrupt.value?.when ?? interrupt.value?.value?.nodeName}
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
                { interruptBefore: ["beforeInterrupt"] },
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
        const rawMessages = messages.value.map((msg, i: number) => ({
          id: msg.id ?? i,
          content: `${msg.type}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`,
        }));

        messagesValues.add(
          rawMessages.map((msg: { content: string }) => msg.content).join("\n"),
        );

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
                ),
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
    ].map((msgs: string[]) => msgs.join("\n")),
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
        const rawMessages = messages.value.map((msg, i: number) => ({
          id: msg.id ?? i,
          content: `${msg.type}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`,
        }));

        messagesValues.add(
          rawMessages.map((msg: { content: string }) => msg.content).join("\n"),
        );

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
                ),
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
  await expect
    .poll(async () => {
      const thread = await client.threads.get(predeterminedThreadId);
      return thread.metadata;
    })
    .toMatchObject({
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
            {messages.value.map((msg, i: number) => {
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
                branchOptions && branch ? branchOptions.indexOf(branch) : -1;

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
                          { checkpoint },
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
  const onRequestCallback = vi.fn();
  const client = new Client({
    apiUrl: serverUrl,
    onRequest: (url: URL, init: RequestInit) => {
      onRequestCallback(url.toString(), {
        ...init,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return init;
    },
  });

  const TestComponent = defineComponent({
    setup() {
      const { messages, isLoading, submit } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        client,
        fetchStateHistory: { limit: 2 },
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="messages">
            {messages.value.map((msg, i: number) => (
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
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .poll(
      () =>
        onRequestCallback.mock.calls.find(
          ([url]) => typeof url === "string" && url.includes("/history"),
        ),
      { timeout: 10000 },
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
            {messages.value.map((msg, i: number) => (
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
            {messages.value.map((msg, i: number) => (
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
                {interrupt.value?.when ?? interrupt.value?.value?.nodeName}
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
                { interruptBefore: ["beforeInterrupt"] },
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

it("exposes toolCalls property", async () => {
  const TestComponent = defineComponent({
    setup() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = useStream({
        assistantId: "headlessToolAgent",
        apiUrl: serverUrl,
      }) as any;

      return () => (
        <div>
          <div data-testid="tool-calls-count">
            {stream.toolCalls.value.length}
          </div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void stream.submit({
                messages: [{ content: "Where am I?", type: "human" }],
              })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const TestComponent = defineComponent({
    setup() {
      const stream = useStream<
        { messages: Message[] },
        { InterruptType: { nodeName: string } }
      >({
        assistantId: "interruptAgent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="interrupts-count">
            {stream.interrupts.value.length}
          </div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void stream.submit(
                { messages: [{ content: "Hello", type: "human" }] },
                { interruptBefore: ["beforeInterrupt"] },
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

  await expect
    .element(screen.getByTestId("interrupts-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("interrupts-count"))
    .toHaveTextContent("1");
});

it("switchThread clears messages and starts fresh", async () => {
  const transport = {
    async stream(payload: any) {
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
                content: `Hello from ${threadId.slice(0, 8)}`,
              },
              {
                id: `${threadId}-ai`,
                type: "ai",
                content: `Reply on ${threadId.slice(0, 8)}`,
              },
            ],
          },
        };
      }
      return generate();
    },
  };

  const TestComponent = defineComponent({
    setup() {
      const thread = useStreamCustom<{ messages: Message[] }>({
        transport: transport as any,
        threadId: null,
        onThreadId: () => {},
      });

      return () => (
        <div>
          <div data-testid="messages">
            {thread.messages.map((msg, i: number) => (
              <div key={(msg as any).id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="loading">
            {thread.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="message-count">{thread.messages.length}</div>
          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [{ type: "human", content: "Hi" }],
              } as any)
            }
          >
            Submit
          </button>
          <button
            data-testid="switch-thread"
            onClick={() => thread.switchThread(crypto.randomUUID())}
          >
            Switch Thread
          </button>
          <button
            data-testid="switch-thread-null"
            onClick={() => thread.switchThread(null)}
          >
            Switch to Null Thread
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const transport = {
    async stream(payload: any) {
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
                content: `Hello from ${threadId.slice(0, 8)}`,
              },
              {
                id: `${threadId}-ai`,
                type: "ai",
                content: `Reply on ${threadId.slice(0, 8)}`,
              },
            ],
          },
        };
      }
      return generate();
    },
  };

  const TestComponent = defineComponent({
    setup() {
      const thread = useStreamCustom<{ messages: Message[] }>({
        transport: transport as any,
        threadId: null,
        onThreadId: () => {},
      });

      return () => (
        <div>
          <div data-testid="message-count">{thread.messages.length}</div>
          <div data-testid="loading">
            {thread.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [{ type: "human", content: "Hi" }],
              } as any)
            }
          >
            Submit
          </button>
          <button
            data-testid="switch-thread-null"
            onClick={() => thread.switchThread(null)}
          >
            Switch to Null Thread
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const transport = {
    async stream() {
      async function* generate(): AsyncGenerator<{
        event: string;
        data: unknown;
      }> {
        yield {
          event: "messages/metadata",
          data: { langgraph_node: "agent" },
        };
        yield {
          event: "messages/partial",
          data: [
            {
              id: "ai-1",
              type: "ai",
              content: "Hello!",
            },
          ],
        };
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
  };

  const TestComponent = defineComponent({
    setup() {
      const thread = useStreamCustom<{ messages: Message[] }>({
        transport: transport as any,
        threadId: null,
        onThreadId: () => {},
      });

      return () => (
        <div>
          <div data-testid="messages">
            {thread.messages.map((msg, i: number) => {
              const metadata = thread.getMessagesMetadata(msg as any, i);
              return (
                <div key={(msg as any).id ?? i} data-testid={`message-${i}`}>
                  {typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)}
                  {metadata?.streamMetadata && (
                    <span data-testid={`metadata-${i}`}>
                      {(metadata.streamMetadata as any).langgraph_node}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div data-testid="branch">{thread.branch.value}</div>
          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [{ type: "human", content: "Hi" }],
              })
            }
          >
            Submit
          </button>
          <button
            data-testid="set-branch"
            onClick={() => thread.setBranch("test-branch")}
          >
            Set Branch
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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
  const transport = {
    async stream(payload: {
      config?: { configurable?: { thread_id?: string } };
    }) {
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

  const TestComponent = defineComponent({
    setup() {
      const thread = useStreamCustom<{ messages: Message[] }>({
        transport: transport as any,
        threadId: null,
        onThreadId: () => {},
        onFinish,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {thread.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit({
                messages: [{ type: "human", content: "Hi" }],
              } as any)
            }
          >
            Submit
          </button>
        </div>
      );
    },
  });

  const screen = render(TestComponent);

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

  const TestComponent = defineComponent({
    setup() {
      const thread = useStreamCustom<StreamState>({
        transport: { stream: streamTransport },
        threadId: null,
        onThreadId: () => {},
      });

      return () => (
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
    },
  });

  const screen = render(TestComponent);
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
const VueQueueStreamComponent = defineComponent({
  setup() {
    const stream = useStream({
      assistantId: "agent",
      apiUrl: serverUrl,
      fetchStateHistory: false,
    });
    return () => (
      <div>
        <div data-testid="messages">
          {stream.messages.value.map((msg, i) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
            </div>
          ))}
        </div>
        <div data-testid="loading">
          {stream.isLoading.value ? "Loading..." : "Not loading"}
        </div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        <div data-testid="queue-size">{(stream as any).queue?.size ?? 0}</div>
        <div data-testid="queue-entries">
          {((stream as any).queue?.entries ?? [])
            .map((e: { values?: { messages?: { content?: string }[] } }) => {
              const msgs = e.values?.messages;
              return msgs?.[0]?.content ?? "?";
            })
            .join(",")}
        </div>
        <button
          data-testid="submit"
          onClick={() =>
            void stream.submit({ messages: [{ content: "Hi", type: "human" }] })
          }
        >
          Submit
        </button>
        <button
          data-testid="submit-three"
          onClick={() => {
            void stream.submit({
              messages: [{ content: "Msg1", type: "human" }],
            });
            void stream.submit({
              messages: [{ content: "Msg2", type: "human" }],
            });
            void stream.submit({
              messages: [{ content: "Msg3", type: "human" }],
            });
          }}
        >
          Submit Three
        </button>
        <button
          data-testid="cancel-first"
          onClick={() => {
            const q = (stream as any).queue;
            const first = q?.entries?.[0];
            if (first && q) void q.cancel(first.id);
          }}
        >
          Cancel First
        </button>
        <button
          data-testid="clear-queue"
          onClick={() => void (stream as any).queue?.clear()}
        >
          Clear Queue
        </button>
        <button
          data-testid="switch-thread"
          onClick={() => stream.switchThread(crypto.randomUUID())}
        >
          Switch Thread
        </button>
      </div>
    );
  },
});

it("server-side queue: submitting three times rapidly queues the latter two", async () => {
  const screen = render(VueQueueStreamComponent);

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
  const screen = render(VueQueueStreamComponent);

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
  const screen = render(VueQueueStreamComponent);

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
  const screen = render(VueQueueStreamComponent);

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
  const screen = render(VueQueueStreamComponent);

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
  const VueQueueOnCreatedComponent = defineComponent({
    setup() {
      const PRESETS = ["Msg1", "Msg2", "Msg3"];
      const pendingRef = ref<string[]>([]);
      const submitRef = ref<ReturnType<typeof useStream>["submit"]>();

      const stream = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        fetchStateHistory: false,
        onCreated: () => {
          if (pendingRef.value.length > 0) {
            const followUps = pendingRef.value;
            pendingRef.value = [];
            for (const text of followUps) {
              void submitRef.value?.({
                messages: [{ content: text, type: "human" }],
              } as any);
            }
          }
        },
      });

      submitRef.value = stream.submit;

      return () => (
        <div>
          <div data-testid="messages">
            {stream.messages.value.map((msg, i) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
          </div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="message-count">{stream.messages.value.length}</div>
          <div data-testid="queue-size">
            {(stream as any).queue?.size?.value ?? 0}
          </div>
          <button
            data-testid="submit-presets"
            onClick={() => {
              pendingRef.value = PRESETS.slice(1);
              void stream.submit({
                messages: [{ content: PRESETS[0], type: "human" }],
              } as any);
            }}
          >
            Submit Presets
          </button>
        </div>
      );
    },
  });

  const screen = render(VueQueueOnCreatedComponent);

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

  const count = parseInt(
    screen.getByTestId("message-count").element().textContent ?? "0",
    10,
  );
  expect(count).toBeGreaterThanOrEqual(6);
});

it("calls per-submit onError when stream fails", async () => {
  const SubmitOnErrorComponent = defineComponent({
    setup() {
      const submitError = ref<string | null>(null);

      const { isLoading, error, submit } = useStream({
        assistantId: "errorAgent",
        apiUrl: serverUrl,
      });

      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          {error.value ? (
            <div data-testid="error">{String(error.value)}</div>
          ) : null}
          {submitError.value ? (
            <div data-testid="submit-error">{submitError.value}</div>
          ) : null}
          <button
            data-testid="submit"
            onClick={() =>
              void submit(
                { messages: [{ content: "Hello", type: "human" }] },
                {
                  onError: (err: unknown) => {
                    submitError.value =
                      err instanceof Error ? err.message : String(err);
                  },
                },
              )
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = render(SubmitOnErrorComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("submit-error")).toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("deep agent: subagents call tools and render args/results", async () => {
  function formatMessage(msg: Record<string, any>): string {
    if (
      msg.type === "ai" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      return msg.tool_calls
        .map(
          (tc: { name: string; args: Record<string, unknown> }) =>
            `tool_call:${tc.name}:${JSON.stringify(tc.args)}`,
        )
        .join(",");
    }

    if (msg.type === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `tool_result:${content}`;
    }

    return typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
  }

  const toolCallStates = new Set<string>();

  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
        filterSubagentMessages: true,
      });

      return () => {
        const subagents = [...thread.subagents.values()].sort(
          (a: any, b: any) =>
            (a.toolCall?.args?.subagent_type ?? "").localeCompare(
              b.toolCall?.args?.subagent_type ?? "",
            ),
        );

        for (const sub of subagents) {
          const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
          for (const tc of sub.toolCalls) {
            toolCallStates.add(`${subType}:${tc.call.name}:${tc.state}`);
          }
        }

        return (
          <div
            data-testid="deep-agent-root"
            style={{ fontFamily: "monospace", fontSize: "13px" }}
          >
            <div data-testid="loading">
              <b>Status:</b>{" "}
              {thread.isLoading.value ? "Loading..." : "Not loading"}
            </div>
            {thread.error.value ? (
              <div data-testid="error">{String(thread.error.value)}</div>
            ) : null}
            <hr />
            <div>
              <b>Messages ({thread.messages.value.length})</b>
            </div>
            <div data-testid="messages">
              {thread.messages.value.map((msg, i) => (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  [{msg.type}] {formatMessage(msg)}
                </div>
              ))}
            </div>
            <hr />
            <div>
              <b>Subagents</b> (
              <span data-testid="subagent-count">{subagents.length}</span>)
            </div>
            {subagents.map((sub: any) => {
              const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
              return (
                <div
                  key={sub.id}
                  data-testid={`subagent-${subType}`}
                  style={{
                    margin: "8px 0",
                    paddingLeft: "12px",
                    borderLeft: "2px solid #999",
                  }}
                >
                  <div data-testid={`subagent-${subType}-status`}>
                    SubAgent ({subType}) status: {sub.status}
                  </div>
                  <div data-testid={`subagent-${subType}-task-description`}>
                    Task: {sub.toolCall?.args?.description ?? ""}
                  </div>
                  <div data-testid={`subagent-${subType}-result`}>
                    Result: {sub.result ?? ""}
                  </div>
                  <div data-testid={`subagent-${subType}-messages-count`}>
                    {sub.messages.length}
                  </div>
                  <div data-testid={`subagent-${subType}-toolcalls-count`}>
                    {sub.toolCalls.length}
                  </div>
                  <div data-testid={`subagent-${subType}-toolcall-names`}>
                    {sub.toolCalls.map((tc: any) => tc.call.name).join(",")}
                  </div>
                </div>
              );
            })}
            <div data-testid="observed-toolcall-states">
              {[...toolCallStates].sort().join(",")}
            </div>
            <hr />
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit(
                  { messages: [{ content: "Run analysis", type: "human" }] },
                  { streamSubgraphs: true },
                )
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

it("deep agent: getSubagentsByMessage renders subagents while they are still running", async () => {
  const observedGroupedStates = new Set<string>();

  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
        filterSubagentMessages: true,
      });

      return () => {
        const groupedTurns = thread.messages.value.flatMap((msg, index, messages) => {
          if (msg.type !== "human") return [];

          const next = messages[index + 1];
          if (!next || next.type !== "ai" || !next.id) return [];

          const subagents = thread
            .getSubagentsByMessage(next.id)
            .slice()
            .sort((a: any, b: any) =>
              (a.toolCall?.args?.subagent_type ?? "").localeCompare(
                b.toolCall?.args?.subagent_type ?? "",
              ),
            );

          if (subagents.length === 0) return [];

          return [
            {
              humanId: msg.id ?? `human-${index}`,
              parentAiMessageId: next.id,
              subagents,
            },
          ];
        });

        if (thread.isLoading.value && groupedTurns.length > 0) {
          observedGroupedStates.add("rendered-while-loading");
        }

        for (const turn of groupedTurns) {
          for (const sub of turn.subagents) {
            const subType = sub.toolCall?.args?.subagent_type ?? "unknown";
            const toolStates =
              sub.toolCalls
                .map((tc: any) => tc.state)
                .sort()
                .join("+") || "no-tool-calls";
            observedGroupedStates.add(
              `${subType}:${sub.status}:${toolStates}:${
                sub.result ? "has-result" : "no-result"
              }:${thread.isLoading.value ? "loading" : "idle"}`,
            );
          }
        }

        return (
          <div data-testid="deep-agent-by-message-root">
            <div data-testid="loading">
              {thread.isLoading.value ? "Loading..." : "Not loading"}
            </div>
            <div data-testid="messages">
              {thread.messages.value.map((msg, i) => (
                <div key={msg.id ?? i} data-testid={`message-${i}`}>
                  {msg.type}:{typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content)}
                </div>
              ))}
            </div>
            {groupedTurns.map((turn, index) => (
              <div key={turn.parentAiMessageId} data-testid={`turn-${index}`}>
                <div data-testid={`turn-${index}-subagent-count`}>
                  {turn.subagents.length}
                </div>
                <div data-testid={`turn-${index}-subagent-statuses`}>
                  {turn.subagents
                    .map(
                      (sub: any) =>
                        `${sub.toolCall?.args?.subagent_type}:${sub.status}`,
                    )
                    .join(",")}
                </div>
                <div data-testid={`turn-${index}-tool-states`}>
                  {turn.subagents
                    .flatMap((sub: any) =>
                      sub.toolCalls.map(
                        (tc: any) =>
                          `${sub.toolCall?.args?.subagent_type}:${tc.call.name}:${tc.state}`,
                      ),
                    )
                    .join(",")}
                </div>
              </div>
            ))}
            <div data-testid="observed-grouped-states">
              {[...observedGroupedStates].sort().join(",")}
            </div>
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit(
                  { messages: [{ content: "Run analysis", type: "human" }] },
                  { streamSubgraphs: true },
                )
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

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("turn-0-subagent-count"), { timeout: 30_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("turn-0-subagent-statuses"))
    .toHaveTextContent(/data-analyst:complete/);
  await expect
    .element(screen.getByTestId("turn-0-subagent-statuses"))
    .toHaveTextContent(/researcher:complete/);

  await expect
    .element(screen.getByTestId("turn-0-tool-states"))
    .toHaveTextContent(/data-analyst:query_database:completed/);
  await expect
    .element(screen.getByTestId("turn-0-tool-states"))
    .toHaveTextContent(/researcher:search_web:completed/);

  const observedStates = screen.getByTestId("observed-grouped-states");
  await expect.element(observedStates).toHaveTextContent(/rendered-while-loading/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/data-analyst:running:pending:no-result:loading/);
  await expect
    .element(observedStates)
    .toHaveTextContent(/researcher:running:pending:no-result:loading/);
});

it("deep agent: retained subagent references stay reactive", async () => {
  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
        filterSubagentMessages: true,
      });
      const retainedSubagent = ref<any>();

      watchEffect(() => {
        const researcher = thread.getSubagentsByType("researcher")[0];
        if (researcher && !retainedSubagent.value) {
          retainedSubagent.value = researcher;
        }
      });

      return () => {
        const subagent = retainedSubagent.value;
        const status = subagent?.status ?? "missing";
        const toolCallCount = subagent?.toolCalls.length ?? -1;

        return (
          <div data-testid="retained-subagent-root">
            <div data-testid="retained-subagent-status">{status}</div>
            <div data-testid="retained-subagent-toolcalls">{toolCallCount}</div>
            <button
              data-testid="submit"
              onClick={() =>
                void thread.submit(
                  { messages: [{ content: "Run analysis", type: "human" }] },
                  { streamSubgraphs: true },
                )
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
  const TestComponent = defineComponent({
    setup() {
      const thread = useStream<DeepAgentGraph>({
        assistantId: "deepAgent",
        apiUrl: serverUrl,
        filterSubagentMessages: true,
      });

      const summary = computed(() => {
        const subagent = [...thread.subagents.values()].find(
          (candidate) =>
            candidate.toolCall?.args?.subagent_type === "researcher",
        );
        const latestToolCall = subagent?.toolCalls.at(-1);

        return {
          task: subagent?.toolCall?.args?.description ?? "",
          latestToolName: latestToolCall?.call?.name ?? "",
          latestToolArgs: JSON.stringify(latestToolCall?.call?.args ?? {}),
        };
      });

      return () => (
        <div data-testid="retained-subagent-summary-root">
          <div data-testid="retained-subagent-summary-task">
            {summary.value.task || "missing"}
          </div>
          <div data-testid="retained-subagent-summary-tool">
            {summary.value.latestToolName || "missing"}
          </div>
          <div data-testid="retained-subagent-summary-args">
            {summary.value.latestToolArgs}
          </div>
          <button
            data-testid="submit"
            onClick={() =>
              void thread.submit(
                { messages: [{ content: "Run analysis", type: "human" }] },
                { streamSubgraphs: true },
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

  await expect
    .element(screen.getByTestId("retained-subagent-summary-tool"))
    .toHaveTextContent("missing");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("retained-subagent-summary-task"), {
      timeout: 30_000,
    })
    .toHaveTextContent("Search the web for test research query");
  await expect
    .element(screen.getByTestId("retained-subagent-summary-tool"))
    .toHaveTextContent("search_web");
  await expect
    .element(screen.getByTestId("retained-subagent-summary-args"))
    .toHaveTextContent('"query":"test research query"');
});

it("stream.history returns BaseMessage instances", async () => {
  const TestComponent = defineComponent({
    setup() {
      const { history, isLoading, submit } = useStream({
        assistantId: "agent",
        apiUrl: serverUrl,
        fetchStateHistory: true,
      });

      const historyMessages = computed(() =>
        history.value.flatMap(
          (state: any) =>
            (state.values.messages ?? []) as Record<string, unknown>[],
        ),
      );

      const allAreBaseMessage = computed(() => {
        const msgs = historyMessages.value;
        return String(
          msgs.length > 0 &&
            msgs.every((msg: any) => typeof msg.getType === "function"),
        );
      });

      const messageTypes = computed(() =>
        historyMessages.value
          .map((msg: any) =>
            typeof msg.getType === "function" ? msg.getType() : "plain",
          )
          .join(","),
      );

      return () => (
        <div>
          <div data-testid="history-count">{history.value.length}</div>
          <div data-testid="history-all-base-message">
            {allAreBaseMessage.value}
          </div>
          <div data-testid="history-message-types">{messageTypes.value}</div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
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

it("provideStream shares stream state across child components", async () => {
  const MessageList = defineComponent({
    setup() {
      const { messages } = useStreamContext();
      return () => (
        <div data-testid="messages">
          {messages.value.map((msg: any, i: number) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
            </div>
          ))}
        </div>
      );
    },
  });

  const StatusBar = defineComponent({
    setup() {
      const { isLoading, error } = useStreamContext();
      return () => (
        <div>
          <div data-testid="loading">
            {isLoading.value ? "Loading..." : "Not loading"}
          </div>
          {error.value ? (
            <div data-testid="error">{String(error.value)}</div>
          ) : null}
        </div>
      );
    },
  });

  const SubmitButton = defineComponent({
    setup() {
      const { submit, stop } = useStreamContext();
      return () => (
        <div>
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

  const Parent = defineComponent({
    setup() {
      provideStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });
      return () => (
        <div>
          <MessageList />
          <StatusBar />
          <SubmitButton />
        </div>
      );
    },
  });

  const screen = render(Parent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("message-0")).not.toBeInTheDocument();
});

it("provideStream children can submit and receive messages", async () => {
  const MessageList = defineComponent({
    setup() {
      const { messages } = useStreamContext();
      return () => (
        <div data-testid="messages">
          {messages.value.map((msg: any, i: number) => (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              {typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content)}
            </div>
          ))}
        </div>
      );
    },
  });

  const Controls = defineComponent({
    setup() {
      const { submit, stop, isLoading } = useStreamContext();
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

  const Parent = defineComponent({
    setup() {
      provideStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });
      return () => (
        <div>
          <MessageList />
          <Controls />
        </div>
      );
    },
  });

  const screen = render(Parent);

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
  const Controls = defineComponent({
    setup() {
      const { submit, stop, isLoading } = useStreamContext();
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

  const Parent = defineComponent({
    setup() {
      provideStream({
        assistantId: "agent",
        apiUrl: serverUrl,
      });
      return () => <Controls />;
    },
  });

  const screen = render(Parent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("useStreamContext throws when used outside provideStream", async () => {
  const Orphan = defineComponent({
    setup() {
      try {
        useStreamContext();
        return () => <div data-testid="result">no-error</div>;
      } catch (e: any) {
        return () => (
          <div data-testid="result">
            {e instanceof Error ? e.message : "unknown"}
          </div>
        );
      }
    },
  });

  const screen = render(Orphan);
  await expect
    .element(screen.getByTestId("result"))
    .toHaveTextContent(
      "useStreamContext() requires a parent component to call provideStream()",
    );
});

function makeHeadlessToolComponent(
  execute?: (args: unknown) => Promise<unknown>,
) {
  return defineComponent({
    setup() {
      const toolEvents = ref<{ phase: string; name: string; error?: Error }[]>(
        [],
      );

      const tool = getLocationTool.implement(
        execute ??
          (async () => ({
            latitude: 37.7749,
            longitude: -122.4194,
          })),
      );

      const { messages, isLoading, submit } = useStream({
        assistantId: "headlessToolAgent",
        apiUrl: serverUrl,
        tools: [tool],
        onTool: (event) => {
          toolEvents.value = [...toolEvents.value, event];
        },
      });

      return () => (
        <div>
          <div data-testid="messages">
            {messages.value.map((msg, i: number) => (
              <div key={msg.id ?? i} data-testid={`message-${i}`}>
                {typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content)}
              </div>
            ))}
            {messages.value.length > 0 && (
              <div data-testid="message-last">
                {(() => {
                  const last = messages.value[messages.value.length - 1];
                  return typeof last.content === "string"
                    ? last.content
                    : JSON.stringify(last.content);
                })()}
              </div>
            )}
          </div>

          <div data-testid="loading">
            {isLoading.value ? "loading" : "idle"}
          </div>

          <div data-testid="tool-events">
            {toolEvents.value.map((event, i) => (
              <div key={i} data-testid={`tool-event-${i}`}>
                {`${event.phase}:${event.name}`}
                {event.phase === "error" && event.error
                  ? `:${event.error.message}`
                  : ""}
              </div>
            ))}
          </div>

          <button
            data-testid="submit"
            onClick={() =>
              void submit({
                messages: [{ type: "human", content: "Where am I?" }],
              })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });
}

it("headless tools - executes in browser and resumes agent automatically", async () => {
  const screen = render(makeHeadlessToolComponent());

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
  const screen = render(makeHeadlessToolComponent());

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

  const screen = render(makeHeadlessToolComponent(failingExecute));

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("loading")).toHaveTextContent("idle");

  await expect
    .element(screen.getByTestId("tool-event-1"))
    .toHaveTextContent("error:get_location:GPS unavailable");

  await expect
    .element(screen.getByTestId("message-last"))
    .toHaveTextContent("Location received!");
});
