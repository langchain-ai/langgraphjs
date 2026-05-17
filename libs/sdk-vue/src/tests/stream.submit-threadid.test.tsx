import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { SubmitThreadIdOverride } from "./components/SubmitThreadIdOverride.js";
import { apiUrl } from "./test-utils.js";

it(
  "honours a submit-time { threadId } override",
  { timeout: 10_000 },
  async () => {
    const overrideThreadId = crypto.randomUUID();

    const screen = await render(SubmitThreadIdOverride, {
      props: { apiUrl, submitThreadId: overrideThreadId },
    });

    try {
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
    } finally {
      await screen.unmount();
    }
  },
);
