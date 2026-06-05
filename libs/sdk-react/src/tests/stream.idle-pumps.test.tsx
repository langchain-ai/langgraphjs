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
import { FANOUT_WORKER_COUNT } from "./fixtures/parallel-constants.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("opens no idle /events on reconnect to a finished thread, then opens them on submit", async () => {
  let eventsCount = 0;
  let counting = false;
  const eventBodies: string[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (counting && typeof url === "string" && url.includes("/events")) {
      eventsCount += 1;
      try {
        eventBodies.push(String(init?.body ?? ""));
      } catch {
        /* ignore */
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const screen = await render(
    <ParallelFanoutReconnectStream
      apiUrl={apiUrl}
      assistantId="parallel_fanout"
      kind="subagent"
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
    counting = true;
    eventsCount = 0;
    await screen.getByTestId("reconnect").click();

    // Cards reappear from the seed (getState + getHistory) — no SSE.
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    // Let any (erroneous) idle pump open.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The core assertion: a finished thread opens ZERO /events.
    expect(eventsCount, `/events bodies: ${JSON.stringify(eventBodies)}`).toBe(
      0
    );

    // ---- submit on the reconnected idle thread → pumps come up ----
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    // Sending a message brought the pumps up.
    expect(eventsCount).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupRender(screen);
  }
});
