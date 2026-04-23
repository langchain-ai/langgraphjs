import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessageMetadataStream } from "./components/MessageMetadataStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

// TODO(A0.2): the v2 protocol server does not yet surface
// `parent_checkpoint` on values snapshots, so the
// `useMessageMetadata` store stays empty and this test cannot pass
// against the embedded mock server. Unskip once the protocol-v2
// implementation mirrors the legacy stream behaviour.
it.skip("records parentCheckpointId metadata for checkpointed messages", async () => {
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
        { timeout: 15_000 },
      )
      .not.toBe("none");
  } finally {
    cleanupRender(screen);
  }
});
