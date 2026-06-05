/**
 * End-to-end: idle/finished threads must not open the always-on SSE
 * pumps on reconnect.
 *
 * A finished thread's subagent/subgraph cards are seeded from
 * `getState()` + a single bounded `getHistory()` page — no SSE needed
 * for first paint. So hydrating a finished thread should open ZERO
 * `/events` connections (neither the wildcard lifecycle watcher nor the
 * depth-1 content pump). The pumps come up only when the thread is
 * actually active or when the user sends a message (the deferred path).
 *
 * We count `/events` at the global `fetch` level (the harness's own
 * `fetch` wrapper delegates here, and so do the SDK Client + transport),
 * so this captures every routing.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ParallelFanoutReconnectStream } from "./components/ParallelFanoutReconnectStream.js";
import { InterruptStream } from "./components/InterruptStream.js";
import { FANOUT_WORKER_COUNT } from "./fixtures/parallel-constants.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

/**
 * Wrap global `fetch` to count `/events` (SSE pump) opens. The SDK
 * Client + transport both route through global fetch, so this captures
 * every pump regardless of how the request is issued. Returns a handle
 * to start/stop counting and restore the original.
 */
function trackEventsRequests() {
  let count = 0;
  let bodies: string[] = [];
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
      bodies.push(String(init?.body ?? ""));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return {
    start() {
      count = 0;
      bodies = [];
      counting = true;
    },
    get count() {
      return count;
    },
    get bodies() {
      return bodies;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

it("opens no idle /events on reconnect to a finished thread, then opens them on submit", async () => {
  const events = trackEventsRequests();
  const screen = await render(
    <ParallelFanoutReconnectStream
      apiUrl={apiUrl}
      assistantId="parallel_fanout"
      kind="subagent"
      openAllAfterReconnect
    />
  );

  try {
    // ---- producer: run the fan-out to completion ----
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    // ---- reconnect: fresh controller hydrates a FINISHED thread ----
    events.start();
    await screen.getByTestId("reconnect").click();

    // Cards and their scoped panels reappear from getState + history — no SSE.
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("panels-ready"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    // Let any (erroneous) idle pump open.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The core assertion: a finished thread opens ZERO /events.
    expect(events.count, events.bodies.join("\n")).toBe(0);

    // ---- submit on the reconnected idle thread → pumps come up ----
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    // Sending a message brought the pumps up.
    expect(events.count).toBeGreaterThan(0);
  } finally {
    events.restore();
    await cleanupRender(screen);
  }
});

it("opens /events on hydrate of an interrupted thread (active → eager pumps)", async () => {
  const events = trackEventsRequests();
  let capturedThreadId: string | undefined;

  // ---- seed: run the interrupt graph until it pauses at the interrupt ----
  const seed = await render(
    <InterruptStream
      apiUrl={apiUrl}
      onThreadId={(id) => {
        capturedThreadId = id;
      }}
    />
  );
  try {
    await seed.getByTestId("submit").click();
    await expect
      .element(seed.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");
  } finally {
    await cleanupRender(seed);
  }
  expect(capturedThreadId).toMatch(/.+/);

  // ---- reconnect: a fresh controller hydrates the INTERRUPTED thread ----
  events.start();
  const screen = await render(
    <InterruptStream apiUrl={apiUrl} threadId={capturedThreadId} />
  );
  try {
    // The pending interrupt is restored from getState...
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");
    // ...and because the thread is active (interrupted), the pumps open
    // eagerly so the user's resume — which starts a run — is observed.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events.count).toBeGreaterThan(0);
  } finally {
    events.restore();
    await cleanupRender(screen);
  }
});
