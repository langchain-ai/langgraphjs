import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { MessageMetadataStreamComponent } from "./components/MessageMetadataStream.js";

it("records parentCheckpointId metadata for checkpointed messages", async () => {
  const screen = await render(MessageMetadataStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("message-0-content"))
    .toHaveTextContent("Hello");

  await expect
    .poll(
      () =>
        screen
          .getByTestId("message-0-parent")
          .element()
          .textContent?.trim() ?? "",
      { timeout: 5_000 },
    )
    .not.toBe("none");

  await expect
    .element(screen.getByTestId("selected-parent"))
    .toHaveTextContent("none");

  await screen.getByTestId("select-first").click();

  await expect
    .poll(
      () =>
        screen
          .getByTestId("selected-parent")
          .element()
          .textContent?.trim() ?? "",
      { timeout: 5_000 },
    )
    .not.toBe("none");
});
