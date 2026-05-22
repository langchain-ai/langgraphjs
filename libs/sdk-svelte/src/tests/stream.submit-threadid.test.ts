import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import SubmitThreadIdOverride from "./components/SubmitThreadIdOverride.svelte";

const serverUrl = inject("serverUrl");

it(
  "honours a submit-time { threadId } override",
  { timeout: 20_000 },
  async () => {
    const overrideThreadId = crypto.randomUUID();

    const screen = render(SubmitThreadIdOverride, {
      apiUrl: serverUrl,
      submitThreadId: overrideThreadId,
    });

    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent("none");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("thread-id"))
      .toHaveTextContent(overrideThreadId);

    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("2");
  },
);
