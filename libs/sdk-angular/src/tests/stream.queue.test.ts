import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { QueueStreamComponent } from "./components/QueueStream.js";

/**
 * Runtime coverage for `injectSubmissionQueue` — Angular mirror of
 * the client-side submission queue. Mirrors React's `stream.queue`
 * suite 1:1.
 */

it("records rapid submits in the submission queue", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Loading...");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("3");
});

it("exposes queued submission payloads via entries", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Loading...");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("3");

  await expect
    .element(screen.getByTestId("queue-entries"))
    .toHaveTextContent("Msg2,Msg3,Msg4");
});

it("drains the queue sequentially once the active run terminates", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();
  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  // Each run adds a single AI reply ("Done.") so 4 human + 4 AI = 8.
  await expect
    .element(screen.getByTestId("message-count"), { timeout: 5_000 })
    .toHaveTextContent("8");
});

it("removes a queued entry via cancel()", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Loading...");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("3");
  await expect
    .element(screen.getByTestId("queue-entries"))
    .toHaveTextContent("Msg2,Msg3,Msg4");

  await screen.getByTestId("cancel-first").click();

  await expect
    .element(screen.getByTestId("queue-entries"), { timeout: 5_000 })
    .toHaveTextContent("Msg3,Msg4");
});

it("empties the queue via clear()", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Loading...");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("3");

  await screen.getByTestId("clear-queue").click();

  await expect
    .element(screen.getByTestId("queue-entries"), { timeout: 5_000 })
    .toHaveTextContent("");
  await expect
    .element(screen.getByTestId("queue-size"))
    .toHaveTextContent("0");
});

it("clears the queue when the controller switches thread", async () => {
  const screen = await render(QueueStreamComponent);

  await screen.getByTestId("submit-first").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Loading...");

  await screen.getByTestId("submit-three").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("3");

  await screen.getByTestId("switch-thread").click();

  await expect
    .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
    .toHaveTextContent("0");
});
