import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { QueueStream } from "./components/QueueStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

/**
 * Runtime coverage for `useSubmissionQueue` — the client-side mirror
 * of the submission queue. The hook surface and the controller's
 * `queueStore` together record every `submit()` that arrives with
 * `multitaskStrategy: "enqueue"` while another run is in flight so
 * consumers can render pending submissions and give users cancel /
 * clear affordances before the controller drains them.
 *
 * Ported 1:1 from the legacy `sdk-react/src/tests/stream.test.tsx`
 * queue suite. Once the server emits a dedicated queue channel
 * (roadmap A0.3) the controller will switch to mirroring the
 * server-driven state directly; these tests continue to apply
 * because the public hook shape is unchanged.
 */

it("records rapid submits in the submission queue", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit-first").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Loading...");

    await screen.getByTestId("submit-three").click();

    await expect
      .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
      .toHaveTextContent("3");
  } finally {
    await cleanupRender(screen);
  }
});

it("exposes queued submission payloads via entries", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});

it("drains the queue sequentially once the active run terminates", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit-first").click();
    await screen.getByTestId("submit-three").click();

    await expect
      .element(screen.getByTestId("queue-size"), { timeout: 5_000 })
      .toHaveTextContent("0");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // Each enqueued submission landed in the message history after
    // the controller drained the queue. The graph adds a single
    // AIMessage per run (`Done.`) so we expect 8 messages total:
    // 4 human + 4 AI.
    await expect
      .element(screen.getByTestId("message-count"), { timeout: 5_000 })
      .toHaveTextContent("8");
  } finally {
    await cleanupRender(screen);
  }
});

it("removes a queued entry via cancel()", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});

it("empties the queue via clear()", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});

it("clears the queue when the controller switches thread", async () => {
  const screen = await render(<QueueStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});
