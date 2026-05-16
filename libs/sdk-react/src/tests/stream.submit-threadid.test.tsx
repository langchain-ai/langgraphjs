import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SubmitThreadIdOverride } from "./components/SubmitThreadIdOverride.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it(
  "honours a submit-time { threadId } override",
  { timeout: 20_000 },
  async () => {
    const overrideThreadId = crypto.randomUUID();

    const screen = await render(
      <SubmitThreadIdOverride
        apiUrl={apiUrl}
        submitThreadId={overrideThreadId}
      />,
    );

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
      await cleanupRender(screen);
    }
  },
);
