import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import NestedInterruptStream from "./components/NestedInterruptStream.svelte";

const serverUrl = inject("serverUrl");

const nestedSubmitInput = { request: "ship nested change" };
const deepAgentSubmitInput = {
  messages: [{ role: "user", content: "Please get approval" }],
};

it(
  "surfaces a nested StateGraph interrupt live on useStream().interrupts",
  { timeout: 20_000 },
  async () => {
    const screen = await render(NestedInterruptStream, {
      apiUrl: serverUrl,
      assistantId: "nested_interrupt_graph",
      submitInput: nestedSubmitInput,
    });

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 15_000 })
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("interrupt-prompt"))
        .toHaveTextContent("Approve nested subgraph action?");
      await expect
        .element(screen.getByTestId("interrupt-id"))
        .not.toHaveTextContent("");

      const namespaceText =
        screen.getByTestId("interrupt-namespace").element().textContent ?? "[]";
      const namespace = JSON.parse(namespaceText) as string[];
      expect(namespace.length).toBeGreaterThan(0);

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 15_000 })
        .toHaveTextContent("0");
      await expect
        .element(screen.getByTestId("completed"), { timeout: 15_000 })
        .toHaveTextContent("true");
    } finally {
      await screen.unmount();
    }
  }
);

it(
  "surfaces a createDeepAgent subagent interrupt live on useStream().interrupts",
  { timeout: 30_000 },
  async () => {
    const screen = await render(NestedInterruptStream, {
      apiUrl: serverUrl,
      assistantId: "deep_agent_interrupt",
      submitInput: deepAgentSubmitInput,
    });

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("interrupt-prompt"))
        .toHaveTextContent("Approve subagent tool action?");
      await expect
        .element(screen.getByTestId("interrupt-id"))
        .not.toHaveTextContent("");

      const namespaceText =
        screen.getByTestId("interrupt-namespace").element().textContent ?? "[]";
      const namespace = JSON.parse(namespaceText) as string[];
      expect(namespace.length).toBeGreaterThan(0);

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
        .toHaveTextContent("0");
      await expect
        .element(screen.getByTestId("loading"), { timeout: 20_000 })
        .toHaveTextContent("Not loading");
    } finally {
      await screen.unmount();
    }
  }
);

it(
  "hydrates a nested StateGraph interrupt after remount",
  { timeout: 30_000 },
  async () => {
    let capturedThreadId: string | undefined;

    const seed = await render(NestedInterruptStream, {
      apiUrl: serverUrl,
      assistantId: "nested_interrupt_graph",
      submitInput: nestedSubmitInput,
      onThreadId: (id: string) => {
        capturedThreadId = id;
      },
    });
    try {
      await seed.getByTestId("submit").click();
      await expect
        .element(seed.getByTestId("interrupt-count"), { timeout: 15_000 })
        .toHaveTextContent("1");
    } finally {
      await seed.unmount();
    }
    expect(capturedThreadId).toMatch(/.+/);

    const screen = await render(NestedInterruptStream, {
      apiUrl: serverUrl,
      assistantId: "nested_interrupt_graph",
      threadId: capturedThreadId,
      submitInput: nestedSubmitInput,
    });
    try {
      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 15_000 })
        .toHaveTextContent("1");

      const namespaceText =
        screen.getByTestId("interrupt-namespace").element().textContent ?? "[]";
      const namespace = JSON.parse(namespaceText) as string[];
      expect(namespace.length).toBeGreaterThan(0);

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 15_000 })
        .toHaveTextContent("0");
      await expect
        .element(screen.getByTestId("completed"), { timeout: 15_000 })
        .toHaveTextContent("true");
    } finally {
      await screen.unmount();
    }
  }
);
