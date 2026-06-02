import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { BasicStream } from "./components/BasicStream.js";
import { apiUrl } from "./test-utils.js";

it("renders initial state correctly", async () => {
  const screen = await render(BasicStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent("none");
    await expect
      .element(screen.getByTestId("error"))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("submits input, streams values, and projects messages", async () => {
  const screen = await render(BasicStream, { props: { apiUrl } });

  try {
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
  } finally {
    await screen.unmount();
  }
});

it("forwards submit options without tripping the controller", async () => {
  const screen = await render(BasicStream, {
    props: {
      apiUrl,
      submitOptions: {
        metadata: { tag: "protocol-v2", run: 42 },
        config: { configurable: { tone: "friendly" } },
      },
    },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});

it("cancels an in-flight run via stop()", async () => {
  const screen = await render(BasicStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();
    await screen.getByTestId("stop").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
  } finally {
    await screen.unmount();
  }
});

it("applies RemoveMessage deltas to the projected messages array", async () => {
  const screen = await render(BasicStream, {
    props: { apiUrl, assistantId: "removeMessageAgent" },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // The graph removes every AIMessage in step2 and replaces it with
    // "Step 2: To Keep", then adds "Step 3: To Keep" in step3. The
    // "Step 1: To Remove" AI message must not survive in the final
    // client-side projection.
    const finalTexts = Array.from(
      screen
        .getByTestId("messages")
        .element()
        .querySelectorAll('[data-testid^="message-"]'),
    ).map((n) => n.textContent?.trim() ?? "");

    expect(finalTexts.some((t) => t.includes("Step 1: To Remove"))).toBe(false);
    expect(finalTexts.some((t) => t.includes("Step 2: To Keep"))).toBe(true);
    expect(finalTexts.some((t) => t.includes("Step 3: To Keep"))).toBe(true);
  } finally {
    await screen.unmount();
  }
});
