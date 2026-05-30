import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import BasicStream from "./components/BasicStream.svelte";
import HydratedStream from "./components/HydratedStream.svelte";

const serverUrl = inject("serverUrl");

it("uses hydrationPromise to gate hydrated render", async () => {
  const seed = render(BasicStream, {
    apiUrl: serverUrl,
    assistantId: "stategraph_text",
  });

  await seed.getByTestId("submit").click();
  await expect
    .element(seed.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  const threadId = seed.getByTestId("thread-id").element().textContent?.trim();
  seed.unmount();

  expect(threadId).toMatch(/.+/);

  const screen = render(HydratedStream, {
    apiUrl: serverUrl,
    threadId: threadId!,
    delayMs: 50,
  });

  await expect
    .element(screen.getByTestId("hydration-fallback"))
    .toHaveTextContent("Hydrating");
  await expect
    .element(screen.getByTestId("hydrated"), { timeout: 5_000 })
    .toHaveTextContent("ready");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Plan accepted.");
});
