import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import { defineComponent, h, Suspense } from "vue";
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
  async setup(props) {
    const stream = useStream<{ messages: BaseMessage[] }>({
      assistantId: "agent",
      apiUrl: props.apiUrl,
      threadId: props.threadId,
    });

    await Promise.all([
      stream.hydrationPromise.value,
      new Promise((resolve) => setTimeout(resolve, props.delayMs)),
    ]);

    return () => (
      <div>
        <div data-testid="hydrated">ready</div>
        <div data-testid="message-count">{stream.messages.value.length}</div>
        {stream.messages.value.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>
    );
  },
});

const SuspenseHarness = defineComponent({
  name: "SuspenseHarness",
  props: {
    apiUrl: { type: String, required: true },
    threadId: { type: String, required: true },
    delayMs: { type: Number, default: 0 },
  },
  setup(props) {
    return () =>
      h(
        Suspense,
        {},
        {
          default: () =>
            h(HydratedStream, {
              apiUrl: props.apiUrl,
              threadId: props.threadId,
              delayMs: props.delayMs,
            }),
          fallback: () =>
            h("div", { "data-testid": "suspense-fallback" }, "Hydrating"),
        },
      );
  },
});

it("uses Vue Suspense with async setup and hydrationPromise", async () => {
  const seed = await render(BasicStream, { props: { apiUrl } });
  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"), { timeout: 15_000 })
    .toHaveTextContent("Not loading");
  const threadId = seed.getByTestId("thread-id").element().textContent?.trim();
  await seed.unmount();

  expect(threadId).toMatch(/.+/);

  const screen = await render(SuspenseHarness, {
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
      .element(screen.getByTestId("hydrated"), { timeout: 15_000 })
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
