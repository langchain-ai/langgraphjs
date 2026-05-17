import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import BasicStream from "./components/BasicStream.svelte";
import SwitchThreadStream from "./components/SwitchThreadStream.svelte";

const serverUrl = inject("serverUrl");

it("switches to a new threadId without bleeding prior messages", async () => {
  const screen = render(SwitchThreadStream, { apiUrl: serverUrl });

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
});

it("clears state when the threadId becomes null", async () => {
  const screen = render(SwitchThreadStream, { apiUrl: serverUrl });

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
});

it("hydrates pre-existing thread state on mount", async () => {
  const seedScreen = render(BasicStream, { apiUrl: serverUrl });
  await seedScreen.getByTestId("submit").click();
  await expect
    .element(seedScreen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  const threadId = seedScreen
    .getByTestId("thread-id")
    .element()
    .textContent?.trim();

  expect(threadId).toMatch(/.+/);

  // Unmount the seed render so the second render's locators don't
  // trip the `vitest-browser-svelte` strict-mode duplicate-match
  // guard (both renders share the same document body otherwise).
  seedScreen.unmount();

  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    threadId: threadId!,
  });

  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
});
