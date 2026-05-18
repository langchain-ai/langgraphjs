import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";
import {
  computed,
  defineComponent,
  onScopeDispose,
  ref,
  type PropType,
} from "vue";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { DeepAgentSubscriptionStream } from "./components/DeepAgentSubscriptionStream.js";
import {
  STREAM_CONTROLLER,
  useMessages,
  useStream,
  type SubagentDiscoverySnapshot,
} from "../index.js";
import { apiUrl } from "./test-utils.js";

it("does not open any scoped subscriptions for a bare useStream mount", async () => {
  const screen = await render(DeepAgentSubscriptionStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    await expect.element(screen.getByTestId("registry-size")).toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("root useMessages(stream) is served by the always-on projection", async () => {
  const screen = await render(DeepAgentSubscriptionStream, { props: { apiUrl } });

  try {
    await expect.element(screen.getByTestId("registry-size")).toHaveTextContent("0");

    await screen.getByTestId("toggle-root-messages").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");

    await screen.getByTestId("toggle-root-messages").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("opens exactly one scoped subscription per selector namespace", async () => {
  const screen = await render(DeepAgentSubscriptionStream, {
    props: {
      apiUrl,
      initialMounts: { researcherMessagesA: true },
    },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("obs-researcher-a-namespace"))
      .toHaveTextContent(/^tools:/);
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"))
      .not.toHaveTextContent("0");

    await screen.getByTestId("toggle-researcher-messages-a").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("dedupes registry entries for multiple consumers of one selector namespace", async () => {
  const screen = await render(DeepAgentSubscriptionStream, {
    props: {
      apiUrl,
      initialMounts: {
        researcherMessagesA: true,
        researcherMessagesB: true,
      },
    },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // Wait for the scoped projection to drain before sampling counts
    // synchronously. The terminal lifecycle event can flip `isLoading`
    // before per-namespace replay lands in the projection store, which
    // would let a bare read observe `0/0` (consistent but pre-data).
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"), {
        timeout: 5_000,
      })
      .not.toHaveTextContent("0");

    const a = Number(
      screen.getByTestId("obs-researcher-a-count").element().textContent,
    );
    const b = Number(
      screen.getByTestId("obs-researcher-b-count").element().textContent,
    );
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);

    await screen.getByTestId("toggle-researcher-messages-a").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("obs-researcher-b-count"))
      .toHaveTextContent(String(b));

    await screen.getByTestId("toggle-researcher-messages-b").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("keeps subagent message streams isolated across namespaces", async () => {
  const screen = await render(DeepAgentSubscriptionStream, {
    props: {
      apiUrl,
      initialMounts: {
        analystMessages: true,
        researcherMessagesA: true,
      },
    },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    const researcherNs = screen
      .getByTestId("obs-researcher-a-namespace")
      .element().textContent;
    const analystNs = screen
      .getByTestId("obs-analyst-namespace")
      .element().textContent;
    expect(researcherNs).toBeTruthy();
    expect(analystNs).toBeTruthy();
    expect(researcherNs).not.toBe(analystNs);

    // Both projections drain asynchronously after the terminal
    // lifecycle event; poll each before sampling so we never read a
    // pre-data `0` from a healthy projection.
    await expect
      .element(screen.getByTestId("obs-researcher-a-count"), {
        timeout: 5_000,
      })
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("obs-analyst-count"), { timeout: 5_000 })
      .not.toHaveTextContent("0");

    const researcherCount = Number(
      screen.getByTestId("obs-researcher-a-count").element().textContent,
    );
    const analystCount = Number(
      screen.getByTestId("obs-analyst-count").element().textContent,
    );
    expect(researcherCount).toBeGreaterThan(0);
    expect(analystCount).toBeGreaterThan(0);

    await screen.getByTestId("toggle-researcher-messages-a").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("toggle-analyst-messages").click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("opens subagent subscriptions lazily as observers mount", async () => {
  const screen = await render(DeepAgentSubscriptionStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    const steps: Array<{ click: string; expected: number }> = [
      { click: "toggle-researcher-messages-a", expected: 1 },
      { click: "toggle-researcher-messages-b", expected: 1 },
      { click: "toggle-analyst-messages", expected: 2 },
      { click: "toggle-researcher-toolcalls", expected: 3 },
    ];

    for (const step of steps) {
      await screen.getByTestId(step.click).click();
      await expect
        .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
        .toHaveTextContent(String(step.expected));
    }

    const teardown: Array<{ click: string; expected: number }> = [
      { click: "toggle-researcher-toolcalls", expected: 2 },
      { click: "toggle-analyst-messages", expected: 1 },
      { click: "toggle-researcher-messages-b", expected: 1 },
      { click: "toggle-researcher-messages-a", expected: 0 },
    ];

    for (const step of teardown) {
      await screen.getByTestId(step.click).click();
      await expect
        .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
        .toHaveTextContent(String(step.expected));
    }
  } finally {
    await screen.unmount();
  }
});

it("rebinds a scoped selector when its reactive target changes", async () => {
  const ReactiveTargetObserver = defineComponent({
    props: {
      stream: { type: Object as PropType<any>, required: true },
      target: {
        type: Object as PropType<SubagentDiscoverySnapshot>,
        required: true,
      },
    },
    setup(props) {
      const messages = useMessages(props.stream, () => props.target);
      return () => (
        <>
          <div data-testid="selected-namespace">
            {props.target.namespace.join("/")}
          </div>
          <div data-testid="selected-message-count">{messages.value.length}</div>
        </>
      );
    },
  });

  const ReactiveTargetStream = defineComponent({
    setup() {
      const stream = useStream<{ messages: BaseMessage[] }>({
        assistantId: "deepAgent",
        apiUrl,
      });
      const selected = ref<"researcher" | "data-analyst">("researcher");
      const target = computed(() =>
        [...stream.subagents.value.values()].find(
          (subagent) => subagent.name === selected.value,
        ),
      );
      const tick = ref(0);
      const interval = setInterval(() => {
        tick.value += 1;
      }, 25);
      onScopeDispose(() => clearInterval(interval));

      return () => {
        void tick.value;
        return (
          <div>
            <div data-testid="loading">
              {stream.isLoading.value ? "Loading..." : "Not loading"}
            </div>
            <div data-testid="subagent-count">{stream.subagents.value.size}</div>
            <div data-testid="registry-size">
              {stream[STREAM_CONTROLLER].registry.size}
            </div>
            <div data-testid="selected-target">{selected.value}</div>
            {target.value ? (
              <ReactiveTargetObserver stream={stream} target={target.value} />
            ) : (
              <>
                <div data-testid="selected-namespace">missing</div>
                <div data-testid="selected-message-count">0</div>
              </>
            )}
            <button
              data-testid="submit"
              onClick={() =>
                void stream.submit({
                  messages: [new HumanMessage("Run analysis")],
                })
              }
            >
              Run
            </button>
            <button
              data-testid="select-analyst"
              onClick={() => {
                selected.value = "data-analyst";
              }}
            >
              Select analyst
            </button>
          </div>
        );
      };
    },
  });

  const screen = await render(ReactiveTargetStream);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("selected-target"))
      .toHaveTextContent("researcher");
    const researcherNamespace = screen
      .getByTestId("selected-namespace")
      .element()
      .textContent?.trim();
    expect(researcherNamespace).toMatch(/^tools:/);

    await screen.getByTestId("select-analyst").click();

    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("selected-target"))
      .toHaveTextContent("data-analyst");
    const analystNamespace = screen
      .getByTestId("selected-namespace")
      .element()
      .textContent?.trim();
    expect(analystNamespace).toMatch(/^tools:/);
    expect(analystNamespace).not.toBe(researcherNamespace);
  } finally {
    await screen.unmount();
  }
});
