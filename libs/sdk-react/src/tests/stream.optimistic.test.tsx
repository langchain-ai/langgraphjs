import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { OptimisticStream } from "./components/OptimisticStream.js";
import { OptimisticValuesStream } from "./components/OptimisticValuesStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("echoes the submitted message immediately as pending, then marks it sent", async () => {
  const screen = await render(
    <OptimisticStream apiUrl={apiUrl} assistantId="slow_graph" />,
  );

  try {
    await screen.getByTestId("submit").click();

    // The human message paints before the server responds.
    await expect
      .element(screen.getByTestId("message-0-content"))
      .toHaveTextContent("Hello");
    // The server echoes the input id within a frame or two, so the live
    // `pending` status is too short-lived to poll reliably under suite
    // load. Assert the sticky latch (it rendered `pending` at least once)
    // instead of racing the transient.
    await expect
      .element(screen.getByTestId("message-0-ever-pending"))
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");

    // Once the run settles, the optimistic message reconciles to sent
    // and the assistant reply lands.
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-0-status"))
      .toHaveTextContent("sent");
    await expect
      .element(screen.getByTestId("message-1-content"))
      .toHaveTextContent("Done.");
  } finally {
    await cleanupRender(screen);
  }
});

it("reconciles the server echo by id without duplicating the message", async () => {
  const screen = await render(<OptimisticStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // Exactly one human message (reconciled by minted id) plus one
    // assistant reply — no duplicate human turn from the server echo.
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
      .toHaveTextContent("Plan accepted.");
  } finally {
    await cleanupRender(screen);
  }
});

it("keeps the optimistic message and marks it failed when the run errors", async () => {
  const screen = await render(
    <OptimisticStream apiUrl={apiUrl} assistantId="error_graph" />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect.element(screen.getByTestId("error")).toBeInTheDocument();

    // The human turn is retained (so the UI can offer a retry) and
    // flagged as failed; no assistant message was produced.
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("message-0-content"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("message-0-status"))
      .toHaveTextContent("failed");
  } finally {
    await cleanupRender(screen);
  }
});

it("does not echo optimistically when optimistic is disabled", async () => {
  const screen = await render(
    <OptimisticStream
      apiUrl={apiUrl}
      assistantId="slow_graph"
      optimistic={false}
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    // No synchronous echo: while the slow run is in flight nothing has
    // been projected yet.
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("message-count"))
      .toHaveTextContent("0");

    // Server-authoritative state arrives once the run completes, and
    // carries no optimistic status.
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
  } finally {
    await cleanupRender(screen);
  }
});

it("merges non-message state optimistically and converges to server truth", async () => {
  const screen = await render(<OptimisticValuesStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    // The submitted non-message key paints immediately while the slow
    // run is still in flight.
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("draft");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");

    // Once the server's `values` snapshot lands, the key converges to
    // the authoritative value.
    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("final");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Done.");
  } finally {
    await cleanupRender(screen);
  }
});

it("rolls back an optimistic non-message key when the run never starts", async () => {
  // An unknown assistant id makes dispatch reject before any `values`
  // snapshot streams back — the one case where the optimistic
  // non-message key is reverted rather than converged to server truth.
  const screen = await render(
    <OptimisticValuesStream apiUrl={apiUrl} assistantId="missing_graph" />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect.element(screen.getByTestId("error")).toBeInTheDocument();

    // No server `values` ever landed, so the optimistic `status` is
    // reverted to its pre-submit state (absent).
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("none");
  } finally {
    await cleanupRender(screen);
  }
});

it("does not merge non-message state when optimistic is disabled", async () => {
  const screen = await render(
    <OptimisticValuesStream apiUrl={apiUrl} optimistic={false} />,
  );

  try {
    await screen.getByTestId("submit").click();

    // No synchronous merge: the key is absent until the server replies.
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("none");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("status"))
      .toHaveTextContent("final");
  } finally {
    await cleanupRender(screen);
  }
});
