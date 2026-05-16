import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("renders initial state correctly", async () => {
  const screen = await render(<BasicStream apiUrl={apiUrl} />);

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
    await cleanupRender(screen);
  }
});

it("submits input, streams values, and projects messages", async () => {
  const screen = await render(<BasicStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");

    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
  } finally {
    await cleanupRender(screen);
  }
});

it("assigns a thread id on first submit and surfaces it via onThreadId", async () => {
  const onThreadId = vi.fn<(threadId: string) => void>();
  const onCreated =
    vi.fn<(meta: { run_id: string; thread_id: string }) => void>();

  const screen = await render(
    <BasicStream
      apiUrl={apiUrl}
      onThreadId={onThreadId}
      onCreated={onCreated}
    />,
  );

  try {
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent("none");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .poll(() => onThreadId.mock.calls.length)
      .toBeGreaterThanOrEqual(1);
    const threadId = onThreadId.mock.calls[0][0];
    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);

    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent(threadId);

    await expect
      .poll(() => onCreated.mock.calls.length)
      .toBeGreaterThanOrEqual(1);
    const created = onCreated.mock.calls[0][0];
    expect(typeof created.run_id).toBe("string");
    expect(created.thread_id).toBe(threadId);
  } finally {
    await cleanupRender(screen);
  }
});

it("honours an externally-supplied thread id", async () => {
  const predeterminedThreadId = crypto.randomUUID();

  const screen = await render(
    <BasicStream apiUrl={apiUrl} threadId={predeterminedThreadId} />,
  );

  try {
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent(predeterminedThreadId);

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent(predeterminedThreadId);
  } finally {
    await cleanupRender(screen);
  }
});

it("forwards submit options without tripping the controller", async () => {
  const screen = await render(
    <BasicStream
      apiUrl={apiUrl}
      submitOptions={{
        metadata: { tag: "protocol-v2", run: 42 },
        config: { configurable: { tone: "friendly" } },
      }}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
  } finally {
    await cleanupRender(screen);
  }
});

it("cancels an in-flight run via stop()", async () => {
  const screen = await render(<BasicStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();
    await screen.getByTestId("stop").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
  } finally {
    await cleanupRender(screen);
  }
});

it("recovers to idle when the underlying graph errors", async () => {
  const screen = await render(
    <BasicStream apiUrl={apiUrl} assistantId="error_graph" />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
  } finally {
    await cleanupRender(screen);
  }
});

it("applies RemoveMessage deltas to the projected messages array", async () => {
  const screen = await render(
    <BasicStream apiUrl={apiUrl} assistantId="remove_message_graph" />,
  );

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

    expect(
      finalTexts.some((t) => t.includes("Step 1: To Remove")),
    ).toBe(false);
    expect(
      finalTexts.some((t) => t.includes("Step 2: To Keep")),
    ).toBe(true);
    expect(
      finalTexts.some((t) => t.includes("Step 3: To Keep")),
    ).toBe(true);
  } finally {
    await cleanupRender(screen);
  }
});
