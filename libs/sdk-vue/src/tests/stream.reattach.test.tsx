import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ReattachStream } from "./components/ReattachStream.js";
import { apiUrl } from "./test-utils.js";

it("secondary composable attaches to an in-flight run on the same thread", async () => {
  const screen = await render(ReattachStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("primary-submit").click();

    await expect
      .element(screen.getByTestId("primary-loading"))
      .toHaveTextContent("Loading...");

    await expect
      .poll(() =>
        screen.getByTestId("primary-thread-id").element().textContent?.trim(),
      )
      .not.toBe("none");
    const threadId = screen
      .getByTestId("primary-thread-id")
      .element()
      .textContent?.trim();

    await screen.getByTestId("secondary-mount").click();

    await expect
      .element(screen.getByTestId("secondary-mounted"))
      .toHaveTextContent("yes");
    await expect
      .element(screen.getByTestId("secondary-loading"))
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("secondary-thread-id"))
      .toHaveTextContent(threadId!);

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
      .element(screen.getByTestId("secondary-thread-id"))
      .toHaveTextContent(threadId!);

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
    await screen.unmount();
  }
});
