/**
 * Vue port: idle/finished threads must not open the always-on SSE pumps
 * on reconnect. See the React `stream.idle-pumps.test.tsx` for the full
 * rationale. A finished thread's cards seed from getState + getHistory,
 * so hydrating it opens ZERO `/events`; the pumps come up on submit.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ParallelFanoutReconnectStream } from "./components/ParallelFanoutReconnectStream.js";
import { InterruptStream } from "./components/InterruptStream.js";
import { apiUrl } from "./test-utils.js";

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

it(
  "opens no idle /events on reconnect to a finished thread, then opens them on submit",
  async () => {
    const events = trackEventsRequests();
    const screen = await render(ParallelFanoutReconnectStream, {
      props: {
        apiUrl,
        assistantId: "parallel_fanout",
        kind: "subagent",
        openAllAfterReconnect: true,
      },
    });

    try {
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
      await screen.unmount();
    }
  },
  30_000
);

it("opens /events on hydrate of an interrupted thread (active → eager pumps)", async () => {
  const events = trackEventsRequests();
  let capturedThreadId: string | undefined;

  const seed = await render(InterruptStream, {
    props: {
      apiUrl,
      onThreadId: (id: string) => {
        capturedThreadId = id;
      },
    },
  });
  try {
    await seed.getByTestId("submit").click();
    await expect
      .element(seed.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");
  } finally {
    await seed.unmount();
  }
  expect(capturedThreadId).toMatch(/.+/);

  events.start();
  const screen = await render(InterruptStream, {
    props: { apiUrl, threadId: capturedThreadId },
  });
  try {
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 20_000 })
      .toHaveTextContent("1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events.count).toBeGreaterThan(0);
  } finally {
    events.restore();
    await screen.unmount();
  }
});
