import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { MessageMetadataStream } from "./components/MessageMetadataStream.js";
import { apiUrl } from "./test-utils.js";

it("records parentCheckpointId metadata for checkpointed messages", async () => {
  const screen = await render(MessageMetadataStream, { props: { apiUrl } });

  try {
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
        { timeout: 15_000 },
      )
      .not.toBe("none");
  } finally {
    await screen.unmount();
  }
});
