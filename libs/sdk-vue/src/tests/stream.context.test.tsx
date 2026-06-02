import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent } from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { ContextStream } from "./components/ContextStream.js";
import { LangChainPlugin, useStream, useStreamContext } from "../index.js";
import { apiUrl } from "./test-utils.js";

it("shares a stream handle across ancestor/descendant components", async () => {
  const screen = await render(ContextStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("child-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("child-submit").click();

    await expect
      .element(screen.getByTestId("child-message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("child-message-1"))
      .toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});

it("throws a descriptive error when useStreamContext is called outside provideStream", async () => {
  const Orphan = defineComponent({
    setup() {
      try {
        useStreamContext();
        return () => <div data-testid="result">no-error</div>;
      } catch (error) {
        return () => (
          <div data-testid="result">
            {error instanceof Error ? error.message : "unknown"}
          </div>
        );
      }
    },
  });

  const screen = await render(Orphan);

  try {
    await expect
      .element(screen.getByTestId("result"))
      .toHaveTextContent(
        "useStreamContext() requires a parent component to call provideStream()",
      );
  } finally {
    await screen.unmount();
  }
});

it("uses LangChainPlugin defaults when useStream omits apiUrl", async () => {
  const PluginDefaultStream = defineComponent({
    setup() {
      const stream = useStream<{ messages: BaseMessage[] }>({
        assistantId: "agent",
      });

      return () => (
        <div>
          <div data-testid="loading">
            {stream.isLoading.value ? "Loading..." : "Not loading"}
          </div>
          <div data-testid="message-count">{stream.messages.value.length}</div>
          <button
            data-testid="submit"
            onClick={() =>
              void stream.submit({ messages: [new HumanMessage("Hello")] })
            }
          >
            Send
          </button>
        </div>
      );
    },
  });

  const screen = await render(PluginDefaultStream, {
    global: {
      plugins: [[LangChainPlugin, { apiUrl }]],
    },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});
