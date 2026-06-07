/**
 * Angular port: idle/finished threads must not open the always-on SSE
 * pumps on reconnect. See the React `stream.idle-pumps.test.tsx` for the
 * full rationale. A finished thread's cards seed from getState +
 * getHistory, so hydrating it opens ZERO `/events`; the pumps come up on
 * submit.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { ParallelFanoutSubagentOpenAllAfterReconnectHarnessComponent } from "./components/ParallelFanoutReconnectStream.js";
import { InterruptReconnectHarnessComponent } from "./components/InterruptReconnectStream.js";

const WORKER_COUNT = 6;

/** Wrap global `fetch` to count `/events` (SSE pump) opens. */
function trackEventsRequests() {
  let count = 0;
  let counting = false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (counting && typeof url === "string" && url.includes("/events")) {
      count += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return {
    start() {
      count = 0;
      counting = true;
    },
    get count() {
      return count;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

it("opens no idle /events on reconnect to a finished thread, then opens them on submit", async () => {
  const events = trackEventsRequests();

  try {
    const screen = await render(
      ParallelFanoutSubagentOpenAllAfterReconnectHarnessComponent
    );

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    events.start();
    await screen.getByTestId("reconnect").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("panels-ready"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(events.count).toBe(0);

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    expect(events.count).toBeGreaterThan(0);
  } finally {
    events.restore();
  }
}, 30_000);

it("opens /events on hydrate of an interrupted thread (active → eager pumps)", async () => {
  const events = trackEventsRequests();

  try {
    const screen = await render(InterruptReconnectHarnessComponent);

    // ---- run the interrupt graph until it pauses at the interrupt ----
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");

    // ---- reconnect: a fresh controller hydrates the INTERRUPTED thread ----
    events.start();
    await screen.getByTestId("reconnect").click();

    // The pending interrupt is restored from getState...
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");
    // ...and because the thread is active (interrupted), the pumps open
    // eagerly so a resume — which starts a run — is observed.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events.count).toBeGreaterThan(0);
  } finally {
    events.restore();
  }
});
