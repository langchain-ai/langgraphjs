import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, h, ref } from "vue";
import { type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../index.js";
import { BasicStream } from "./components/BasicStream.js";
import { formatMessage } from "./components/format.js";
import { apiUrl } from "./test-utils.js";

const HydratedStream = defineComponent({
  name: "HydratedStream",
  props: {
    apiUrl: { type: String, required: true },
    threadId: { type: String, required: true },
    delayMs: { type: Number, default: 0 },
  },
  setup(props) {
    const stream = useStream<{ messages: BaseMessage[] }>({
      assistantId: "agent",
      apiUrl: props.apiUrl,
      threadId: props.threadId,
    });
    const hydrated = ref(false);

    void Promise.all([
      stream.hydrationPromise.value,
      new Promise((resolve) => setTimeout(resolve, props.delayMs)),
    ]).then(() => {
      hydrated.value = true;
    });

    return () => {
      if (!hydrated.value) {
        return h("div", { "data-testid": "suspense-fallback" }, "Hydrating");
      }
      const messages = stream.messages.value;
      return h("div", {}, [
        h("div", { "data-testid": "hydrated" }, "ready"),
        h("div", { "data-testid": "message-count" }, String(messages.length)),
        ...messages.map((msg, i) =>
          h(
            "div",
            { key: msg.id ?? i, "data-testid": `message-${i}` },
            formatMessage(msg),
          ),
        ),
      ]);
    };
  },
});

it("uses hydrationPromise to gate hydrated render", async () => {
  const seed = await render(BasicStream, { props: { apiUrl } });
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  const threadId = seed.getByTestId("thread-id").element().textContent?.trim();
  await seed.unmount();

  expect(threadId).toMatch(/.+/);

  const screen = await render(HydratedStream, {
    props: {
      apiUrl,
      threadId: threadId!,
      delayMs: 50,
    },
  });

  try {
    await expect
      .element(screen.getByTestId("suspense-fallback"))
      .toHaveTextContent("Hydrating");

    await expect
      .element(screen.getByTestId("hydrated"), { timeout: 5_000 })
      .toHaveTextContent("ready");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});
