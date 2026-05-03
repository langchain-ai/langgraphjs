import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ReattachStream } from "./components/ReattachStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

/**
 * R2.7 re-attach harness automation. Boots a slow graph (see
 * `fixtures/slow-graph.ts`) and mounts a second `useStream`
 * hook on the same `threadId` mid-run, asserting that the second hook
 * observes the in-flight run via `isLoading: true` and ends up with
 * the same terminal state as the primary hook.
 */
it("secondary hook attaches to an in-flight run on the same thread", async () => {
  const screen = await render(<ReattachStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("primary-submit").click();

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .poll(() =>
        screen.getByTestId("primary-thread-id").element().textContent?.trim()
      )
      .not.toBe("none");

    await screen.getByTestId("secondary-mount").click();

    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");

    // Re-attach acceptance: the secondary hook should pick up the
    // in-flight run's lifecycle through the shared subscription (the
    // persistent root lifecycle listener registered in S1.1).
    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Loading...");

    // Both hooks terminate on the same thread's final state.
    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("primary-message-count"))
      .toHaveTextContent("2");

    await expect
      .element(screen.getByTestId("secondary-message-count"))
      .toHaveTextContent("2");

    await screen.getByTestId("secondary-unmount").click();
    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("no");

    await screen.getByTestId("primary-submit").click();
    await screen.getByTestId("secondary-mount").click();
    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");
    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("primary-message-count"))
      .toHaveTextContent("4");
    await expect
      .element(screen.getByTestId("secondary-message-count"))
      .toHaveTextContent("4");
  } finally {
    await cleanupRender(screen);
  }
});
