import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessageMetadataStream } from "./components/MessageMetadataStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("records parentCheckpointId metadata for checkpointed messages", async () => {
  const screen = await render(<MessageMetadataStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("message-0-content"))
      .toHaveTextContent("Hello");

    // `parent_checkpoint` is populated once the first values snapshot
    // hits the client; the controller then backfills
    // `useMessageMetadata(stream, msg.id).parentCheckpointId`. Poll
    // because the metadata update can trail the run-complete signal
    // by a microtask.
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
  } finally {
    await cleanupRender(screen);
  }
});
