/**
 * Vue port of the parallel fan-out + reconnect e2e (subagents +
 * subgraphs). See the React `stream.fanout-reconnect.test.tsx` for the
 * full rationale. Asserts every card reappears after reconnect (Phase A
 * checkpoint seeding for subagents, Phase A2 getHistory seeding for
 * subgraphs) and that the `/history` request count after reconnect is
 * bounded and independent of the fan-out width.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ParallelFanoutReconnectStream } from "./components/ParallelFanoutReconnectStream.js";
import { apiUrl } from "./test-utils.js";

// Mirrors FANOUT_WORKER_COUNT / SUBGRAPH_WORKER_COUNT in mock-server.ts.
const WORKER_COUNT = 6;

function readNumber(testId: string): number {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  return el ? Number.parseInt(el.textContent || "0", 10) : 0;
}

it("seeds N parallel subagents on reconnect with a bounded getHistory cost", async () => {
  const screen = await render(ParallelFanoutReconnectStream, {
    props: { apiUrl, assistantId: "parallel_fanout", kind: "subagent" },
  });

  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    await screen.getByTestId("reconnect").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("card-statuses"), { timeout: 20_000 })
      .toHaveTextContent(
        Array.from({ length: WORKER_COUNT }, () => "complete").join(",")
      );

    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(3);
    expect(historyRequests).toBeLessThan(WORKER_COUNT);

    await screen.getByTestId("open-0").click();
    await expect
      .element(screen.getByTestId("panel-messages-count"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
    // Poll the element: `registry-size` is repainted on a 25ms tick (it
    // reads a non-reactive Map.size), so a synchronous read can race the
    // panel mount and observe a stale 0.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
    expect(readNumber("history-request-count")).toBeLessThanOrEqual(4);
  } finally {
    await screen.unmount();
  }
});

it("opening every subagent card at once after reconnect stays bounded (resolves coalesce onto one history read)", async () => {
  const screen = await render(ParallelFanoutReconnectStream, {
    props: {
      apiUrl,
      assistantId: "parallel_fanout",
      kind: "subagent",
      openAll: true,
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

    // Reconnect: every panel mounts at once, so all N scoped selectors
    // fire `resolveSubagentNamespace` concurrently and race the hydrate
    // seed (see the deterministic core unit test for the proof).
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

    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(WORKER_COUNT + 2);
  } finally {
    await screen.unmount();
  }
});

it("seeds M parallel subgraphs on reconnect with a bounded getHistory cost", async () => {
  const screen = await render(ParallelFanoutReconnectStream, {
    props: { apiUrl, assistantId: "parallel_subgraph", kind: "subgraph" },
  });

  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subgraph-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    await screen.getByTestId("reconnect").click();

    await expect
      .element(screen.getByTestId("subgraph-count"), { timeout: 20_000 })
      .toHaveTextContent(String(WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(3);
    expect(historyRequests).toBeLessThan(WORKER_COUNT);
    expect(readNumber("subagent-count")).toBe(0);

    await screen.getByTestId("open-0").click();
    await expect
      .element(screen.getByTestId("panel-messages-count"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});
