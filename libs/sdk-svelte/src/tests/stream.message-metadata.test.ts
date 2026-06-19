import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import MessageMetadataStream from "./components/MessageMetadataStream.svelte";

const serverUrl = inject("serverUrl");

it("records parentCheckpointId metadata for checkpointed messages", async () => {
  const screen = render(MessageMetadataStream, { apiUrl: serverUrl });

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
});
