import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { SwitchThreadStream } from "./components/SwitchThreadStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("switches to a new threadId without bleeding prior messages", async () => {
  const screen = await render(<SwitchThreadStream apiUrl={apiUrl} />);

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
    await cleanupRender(screen);
  }
});

it("clears state when the threadId becomes null", async () => {
  const screen = await render(<SwitchThreadStream apiUrl={apiUrl} />);

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
    await cleanupRender(screen);
  }
});

it("hydrates pre-existing thread state on mount", async () => {
  const seedScreen = await render(<BasicStream apiUrl={apiUrl} />);
  await seedScreen.getByTestId("submit").click();
  await expect
    .element(seedScreen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const threadId = seedScreen
    .getByTestId("thread-id")
    .element()
    .textContent?.trim();
  await cleanupRender(seedScreen);

  expect(threadId).toMatch(/.+/);

  const screen = await render(
    <BasicStream apiUrl={apiUrl} threadId={threadId!} />,
  );

  try {
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
  } finally {
    await cleanupRender(screen);
  }
});
