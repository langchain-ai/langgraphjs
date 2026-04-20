import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("streams successfully over the websocket transport", async () => {
  const screen = await render(
    <BasicStream apiUrl={apiUrl} transport="websocket" />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 15_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
  } finally {
    cleanupRender(screen);
  }
});
