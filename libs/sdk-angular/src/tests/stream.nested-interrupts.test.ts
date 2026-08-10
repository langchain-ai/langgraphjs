import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  DeepAgentInterruptStreamComponent,
  NestedInterruptGraphStreamComponent,
} from "./components/NestedInterruptStream.js";

it(
  "surfaces a nested StateGraph interrupt live on injectStream().interrupts",
  { timeout: 20_000 },
  async () => {
    const screen = await render(NestedInterruptGraphStreamComponent);

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
  }
);

it(
  "surfaces a createDeepAgent subagent interrupt live on injectStream().interrupts",
  { timeout: 30_000 },
  async () => {
    const screen = await render(DeepAgentInterruptStreamComponent);

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
  }
);

// Split across two `it`s: Angular's TestBed cannot reconfigure within a
// single test after the first `render()` (same pattern as stream.client.test.ts).
let nestedHydrateThreadId: string | undefined;

it(
  "seeds a nested StateGraph interrupt for the hydrate assertion",
  { timeout: 20_000 },
  async () => {
    const screen = await render(NestedInterruptGraphStreamComponent, {
      inputs: {
        onThreadIdCallback: (id: string) => {
          nestedHydrateThreadId = id;
        },
      },
    });

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 15_000 })
      .toHaveTextContent("1");
    expect(nestedHydrateThreadId).toMatch(/.+/);
  }
);

it(
  "hydrates a nested StateGraph interrupt after remount",
  { timeout: 30_000 },
  async () => {
    expect(nestedHydrateThreadId).toMatch(/.+/);

    const screen = await render(NestedInterruptGraphStreamComponent, {
      inputs: {
        threadId: nestedHydrateThreadId,
      },
    });

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
  }
);
