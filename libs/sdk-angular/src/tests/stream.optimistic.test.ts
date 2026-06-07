import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  OptimisticSlowStreamComponent,
  OptimisticDefaultStreamComponent,
  OptimisticErrorStreamComponent,
  OptimisticDisabledStreamComponent,
  OptimisticValuesStreamComponent,
  OptimisticValuesMissingStreamComponent,
  OptimisticValuesDisabledStreamComponent,
} from "./components/OptimisticStream.js";

it("echoes the submitted message immediately as pending, then marks it sent", async () => {
  const screen = await render(OptimisticSlowStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0-content"))
    .toHaveTextContent("Hello");
  // The server echoes the input id within a frame or two, so the live
  // `pending` status is too short-lived to poll reliably under suite load.
  // Assert the sticky latch (it rendered `pending` at least once) instead
  // of racing the transient.
  await expect
    .element(screen.getByTestId("message-0-ever-pending"))
    .toHaveTextContent("true");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0-status"))
    .toHaveTextContent("sent");
  await expect
    .element(screen.getByTestId("message-1-content"))
    .toHaveTextContent("Done.");
});

it("reconciles the server echo by id without duplicating the message", async () => {
  const screen = await render(OptimisticDefaultStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("message-0-content"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-0-status"))
    .toHaveTextContent("sent");
  await expect
    .element(screen.getByTestId("message-1-content"))
    .toHaveTextContent("Hey");
});

it("keeps the optimistic message and marks it failed when the run errors", async () => {
  const screen = await render(OptimisticErrorStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("message-0-content"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-0-status"))
    .toHaveTextContent("failed");
});

it("does not echo optimistically when optimistic is disabled", async () => {
  const screen = await render(OptimisticDisabledStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("message-0-content"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-0-status"))
    .toHaveTextContent("none");
});

it("merges non-message state optimistically and converges to server truth", async () => {
  const screen = await render(OptimisticValuesStreamComponent);

  await screen.getByTestId("submit").click();

  await expect.element(screen.getByTestId("status")).toHaveTextContent("draft");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("status")).toHaveTextContent("final");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Done.");
});

it("rolls back an optimistic non-message key when the run never starts", async () => {
  // An unknown assistant id makes dispatch reject before any `values`
  // snapshot streams back — the one case where the optimistic
  // non-message key is reverted rather than converged to server truth.
  const screen = await render(OptimisticValuesMissingStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("error")).toBeInTheDocument();

  // No server `values` ever landed, so the optimistic `status` is
  // reverted to its pre-submit state (absent).
  await expect.element(screen.getByTestId("status")).toHaveTextContent("none");
});

it("does not merge non-message state when optimistic is disabled", async () => {
  const screen = await render(OptimisticValuesDisabledStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");
  await expect.element(screen.getByTestId("status")).toHaveTextContent("none");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("status")).toHaveTextContent("final");
});
