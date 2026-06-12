import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { SubmitThreadIdOverrideComponent } from "./components/SubmitThreadIdOverride.js";

it(
  "honours a submit-time { threadId } override",
  { timeout: 20_000 },
  async () => {
    const overrideThreadId = crypto.randomUUID();

    const screen = await render(SubmitThreadIdOverrideComponent, {
      inputs: { submitThreadId: overrideThreadId },
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
