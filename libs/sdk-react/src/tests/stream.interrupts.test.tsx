import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { InterruptStream } from "./components/InterruptStream.js";
import { InterruptReconnectStream } from "./components/InterruptReconnectStream.js";
import { InterruptReloadStream } from "./components/InterruptReloadStream.js";
import { MultiInterruptStream } from "./components/MultiInterruptStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("surfaces the first interrupt on submit()", async () => {
  const screen = await render(<InterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-prompt"))
      .toHaveTextContent("Approve the outbound action?");
    await expect
      .element(screen.getByTestId("completed"))
      .toHaveTextContent("false");
    await expect
      .element(screen.getByTestId("interrupt-id"))
      .not.toHaveTextContent("");
  } finally {
    await cleanupRender(screen);
  }
});

it("resumes an interrupt via respond()", async () => {
  const screen = await render(<InterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("completed"), { timeout: 10_000 })
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("decision"))
      .toHaveTextContent('"approved":true');
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it(
  "resumes after a mid-HITL SSE drop when using a custom auth fetch",
  { timeout: 20_000 },
  async () => {
    // Regression for auth-shim fetch disabling reconnect: waiting on an
    // interrupt while the events pump dies (QUIC/idle) must recover so
    // respond() can finish instead of spinning forever.
    const screen = await render(<InterruptReconnectStream apiUrl={apiUrl} />);

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("loading"))
        .toHaveTextContent("Not loading");

      const opensBeforeDrop = Number(
        screen.getByTestId("event-stream-opens").element().textContent ?? "0"
      );
      expect(opensBeforeDrop).toBeGreaterThan(0);

      await screen.getByTestId("drop-events").click();

      // Reconnect must reopen `/stream/events` (custom fetch used to disable
      // this). Prefer open-count over onReconnect in case multiple pumps drop.
      await expect
        .poll(
          () =>
            Number(
              screen.getByTestId("event-stream-opens").element().textContent ??
                "0"
            ),
          { timeout: 10_000 }
        )
        .toBeGreaterThan(opensBeforeDrop);

      await expect
        .poll(
          () =>
            Number(
              screen.getByTestId("reconnect-count").element().textContent ??
                "0"
            ),
          { timeout: 10_000 }
        )
        .toBeGreaterThan(0);

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("completed"), { timeout: 10_000 })
        .toHaveTextContent("true");
      await expect
        .element(screen.getByTestId("loading"))
        .toHaveTextContent("Not loading");
      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("0");
    } finally {
      await cleanupRender(screen);
    }
  }
);

it(
  "keeps a resolved interrupt hidden after a reload and a follow-up submit",
  { timeout: 30_000 },
  async () => {
    // Regression: a reloaded session has no memory of the interrupt it
    // resolved before the reload. The follow-up submit opens fresh pumps
    // that replay the thread's history, and that historical
    // `input.requested` used to re-surface the resolved form.
    const screen = await render(<InterruptReloadStream apiUrl={apiUrl} />);

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
        .toHaveTextContent("1");

      const resolvedInterruptId = screen
        .getByTestId("interrupt-ids")
        .element()
        .textContent?.trim();
      expect(resolvedInterruptId).toBeTruthy();

      await screen.getByTestId("resume").click();

      await expect
        .element(screen.getByTestId("completed-turns"), { timeout: 10_000 })
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("0");

      await screen.getByTestId("reload").click();

      await expect
        .element(screen.getByTestId("session"), { timeout: 10_000 })
        .toHaveTextContent("1");
      await expect
        .element(screen.getByTestId("thread-loading"), { timeout: 10_000 })
        .toHaveTextContent("Ready");

      // Hydration alone already filtered the resolved interrupt before
      // this fix; the replay only leaks once a new run is dispatched.
      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("0");
      await expect
        .element(screen.getByTestId("completed-turns"))
        .toHaveTextContent("1");

      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("completed-turns"), { timeout: 10_000 })
        .toHaveTextContent("2");
      await expect
        .element(screen.getByTestId("loading"), { timeout: 10_000 })
        .toHaveTextContent("Not loading");

      // Guard the setup itself: without the replayed interrupt on the
      // wire this test would pass for the wrong reason.
      await expect
        .poll(
          () =>
            Number(
              screen.getByTestId("replayed-frames").element().textContent ?? "0"
            ),
          { timeout: 5_000 }
        )
        .toBeGreaterThan(0);

      // The replayed event can land after the run settles, so watch for a
      // window rather than sampling a single frame.
      const observedIds = new Set<string>();
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const ids = screen
          .getByTestId("interrupt-ids")
          .element()
          .textContent?.trim();
        if (ids) observedIds.add(ids);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect([...observedIds]).toEqual([]);
    } finally {
      await cleanupRender(screen);
    }
  }
);

it("resumes several parallel interrupts via respondAll()", { timeout: 15_000 }, async () => {
  const screen = await render(<MultiInterruptStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("thread-interrupt-count"), {
        timeout: 10_000,
      })
      .toHaveTextContent("2");

    await screen.getByTestId("resume-all").click();

    await expect
      .element(screen.getByTestId("completed"), { timeout: 10_000 })
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("decisions"))
      .toHaveTextContent('"A":{"approved":true}');
    await expect
      .element(screen.getByTestId("decisions"))
      .toHaveTextContent('"B":{"approved":false}');
    await expect
      .element(screen.getByTestId("thread-interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});
