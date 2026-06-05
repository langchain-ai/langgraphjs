/**
 * Svelte port: idle/finished threads must not open the always-on SSE
 * pumps on reconnect. See the React `stream.idle-pumps.test.tsx` for the
 * full rationale. A finished thread's cards seed from getState +
 * getHistory, so hydrating it opens ZERO `/events`; the pumps come up on
 * submit.
 */
import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import ParallelFanoutReconnectStream from "./components/ParallelFanoutReconnectStream.svelte";

const serverUrl = inject("serverUrl");

const WORKER_COUNT = 6;

it("opens no idle /events on reconnect to a finished thread, then opens them on submit", async () => {
  let eventsCount = 0;
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
      eventsCount += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const screen = render(ParallelFanoutReconnectStream, {
      apiUrl: serverUrl,
      assistantId: "parallel_fanout",
      kind: "subagent",
    });

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    counting = true;
    eventsCount = 0;
    await screen.getByTestId("reconnect").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(eventsCount).toBe(0);

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Loading...");
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    expect(eventsCount).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
