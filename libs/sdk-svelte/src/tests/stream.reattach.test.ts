import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import ReattachStream from "./components/ReattachStream.svelte";

const serverUrl = inject("serverUrl");

it("secondary composable attaches to an in-flight run on the same thread", async () => {
  const screen = render(ReattachStream, { apiUrl: serverUrl });

  await screen.getByTestId("primary-submit").click();

  await expect
    .element(screen.getByTestId("primary-loading"))
    .toHaveTextContent("Loading...");

  await expect
    .poll(() =>
      screen.getByTestId("primary-thread-id").element().textContent?.trim(),
    )
    .not.toBe("none");

  await screen.getByTestId("secondary-mount").click();

  await expect
    .element(screen.getByTestId("secondary-mounted"))
    .toHaveTextContent("yes");
  await expect
    .element(screen.getByTestId("secondary-loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("primary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("secondary-loading"), { timeout: 10_000 })
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
    .element(screen.getByTestId("primary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("primary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("secondary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("primary-message-count"))
    .toHaveTextContent("4");
  await expect
    .element(screen.getByTestId("secondary-message-count"))
    .toHaveTextContent("4");
});
