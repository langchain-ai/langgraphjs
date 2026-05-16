import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import { BasicStream } from "./components/BasicStream.js";
import { SwitchThreadStream } from "./components/SwitchThreadStream.js";
import { apiUrl } from "./test-utils.js";

it("assigns a thread id on first submit and surfaces it via onThreadId", async () => {
  const onThreadId = vi.fn<(threadId: string) => void>();
  const onCreated =
    vi.fn<(meta: { run_id: string; thread_id: string }) => void>();

  const screen = await render(BasicStream, {
    props: { apiUrl, onThreadId, onCreated },
  });

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
    await screen.unmount();
  }
});

it("honours an externally-supplied thread id", async () => {
  const predeterminedThreadId = crypto.randomUUID();

  const screen = await render(BasicStream, {
    props: { apiUrl, threadId: predeterminedThreadId },
  });

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
      .toHaveTextContent("Hey");
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent(predeterminedThreadId);
  } finally {
    await screen.unmount();
  }
});

it("switches to a new threadId without bleeding prior messages", async () => {
  const screen = await render(SwitchThreadStream, { props: { apiUrl } });

  try {
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

    const firstMessage = screen
      .getByTestId("message-0")
      .element()
      .textContent?.trim();

    await screen.getByTestId("switch-thread").click();

    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 5_000 })
      .toHaveTextContent("Ready");
    await expect
      .element(screen.getByTestId("observed-thread-loading"))
      .toHaveTextContent("yes");
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
    expect(secondMessage).toBe(firstMessage);
  } finally {
    await screen.unmount();
  }
});

it("clears state when the threadId becomes null", async () => {
  const screen = await render(SwitchThreadStream, { props: { apiUrl } });

  try {
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
    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent("none");
  } finally {
    await screen.unmount();
  }
});

it("hydrates pre-existing thread state on mount", async () => {
  const seedScreen = await render(BasicStream, { props: { apiUrl } });
  await seedScreen.getByTestId("submit").click();
  await expect
    .element(seedScreen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const threadId = seedScreen
    .getByTestId("thread-id")
    .element()
    .textContent?.trim();
  await seedScreen.unmount();

  expect(threadId).toMatch(/.+/);

  const screen = await render(BasicStream, {
    props: { apiUrl, threadId: threadId! },
  });

  try {
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Hey");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});
