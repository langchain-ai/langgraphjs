import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { SwitchThreadStreamComponent } from "./components/SwitchThreadStream.js";

it("switches to a new threadId without bleeding prior messages", async () => {
  const screen = await render(SwitchThreadStreamComponent);

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5_000 })
    .toHaveTextContent("2");

  const firstMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5_000 })
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5_000 })
    .toHaveTextContent("2");

  const secondMessage = screen
    .getByTestId("message-0")
    .element()
    .textContent?.trim();
  expect(secondMessage).toBe(firstMessage);
});

it("clears state when the threadId becomes null", async () => {
  const screen = await render(SwitchThreadStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");

  await screen.getByTestId("switch-thread-null").click();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent("none");
});

it("honours an externally-supplied thread id", async () => {
  const predeterminedThreadId = crypto.randomUUID();

  const screen = await render(SwitchThreadStreamComponent, {
    inputs: { initialThreadId: predeterminedThreadId },
  });

  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent(predeterminedThreadId);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent(predeterminedThreadId);
});

// The `hydrates pre-existing thread state on mount` case is split into
// two sequential tests because Angular's TestBed cannot reconfigure
// itself twice within a single test without tearing down the
// environment globally. The first test seeds a thread, the second
// remounts on that id and asserts the hydrated snapshot.
let hydratedThreadId: string | undefined;

it("seeds a thread for the hydrate assertion", async () => {
  const screen = await render(SwitchThreadStreamComponent);
  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  hydratedThreadId = screen
    .getByTestId("thread-id")
    .element()
    .textContent?.trim();
  expect(hydratedThreadId).toMatch(/.+/);
});

it("hydrates pre-existing thread state on mount", async () => {
  expect(hydratedThreadId).toMatch(/.+/);

  const screen = await render(SwitchThreadStreamComponent, {
    inputs: { initialThreadId: hydratedThreadId! },
  });

  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
});
