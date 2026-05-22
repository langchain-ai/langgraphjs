import { Client } from "@langchain/langgraph-sdk";
import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent } from "vue";
import { useStream } from "../index.js";

const serverUrl = inject("serverUrl");

it("stop() does not clear stream values", async () => {
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

