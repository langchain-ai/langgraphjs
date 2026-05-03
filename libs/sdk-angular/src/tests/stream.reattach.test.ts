import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { ReattachStreamComponent } from "./components/ReattachStream.js";

it("secondary stream attaches to an in-flight run on the same thread", async () => {
  const screen = await render(ReattachStreamComponent);

  await expect
    .element(screen.getByTestId("primary-loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("primary-submit").click();

  await expect
    .element(screen.getByTestId("primary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Loading...");
  await expect.poll(() =>
    screen.getByTestId("primary-thread-id").element().textContent?.trim()
  ).not.toBe("none");

  await screen.getByTestId("secondary-mount").click();

  await expect
    .element(screen.getByTestId("secondary-mounted"))
    .toHaveTextContent("yes");
  await expect
    .element(screen.getByTestId("secondary-loading"), { timeout: 10_000 })
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("primary-loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("secondary-loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("secondary-message-count"))
    .not.toHaveTextContent("0");

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
    .element(screen.getByTestId("primary-loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("secondary-loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("primary-message-count"))
    .toHaveTextContent("4");
  await expect
    .element(screen.getByTestId("secondary-message-count"))
    .toHaveTextContent("4");
});
