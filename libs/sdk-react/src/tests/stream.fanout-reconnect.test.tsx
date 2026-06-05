/**
 * End-to-end: parallel fan-out + reconnect for both subagents and
 * subgraphs.
 *
 * A producer runs a wide fan-out (N parallel `task` subagents, or M
 * parallel subgraph `Send`s) to completion, then a fresh `useStream`
 * remounts against the same thread (the real reconnect path: new
 * controller → hydrate). We assert that:
 *
 *  1. Every card reappears after reconnect — subagents are seeded from
 *     checkpoint messages (Phase A); subgraphs are seeded from a single
 *     bounded `getHistory` (Phase A2) — without replaying per-card SSE.
 *  2. The number of `/history` requests after reconnect is bounded and
 *     independent of N/M (the getHistory invariant): a per-card walk
 *     would scale with the fan-out width.
 *  3. Opening a single card lazily attaches exactly its scoped
 *     subscriptions and renders that card's own content.
 *
 * Honest caveat: on an in-memory server SSE replay is effectively
 * instant, so this proves correctness + boundedness under parallel
 * stress, not wall-clock "cards before replay" latency.
 */
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ParallelFanoutReconnectStream } from "./components/ParallelFanoutReconnectStream.js";
import {
  FANOUT_WORKER_COUNT,
  SUBGRAPH_WORKER_COUNT,
} from "./fixtures/parallel-constants.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

function readNumber(testId: string): number {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  return el ? Number.parseInt(el.textContent || "0", 10) : 0;
}

it("seeds N parallel subagents on reconnect with a bounded getHistory cost", async () => {
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

    // ---- reconnect: fresh controller hydrates the same thread ----
    await screen.getByTestId("reconnect").click();

    // All subagent cards reappear (seeded from checkpoint messages).
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");
    // Every card resolved to a terminal status.
    await expect
      .element(screen.getByTestId("card-statuses"), { timeout: 20_000 })
      .toHaveTextContent(
        Array.from({ length: FANOUT_WORKER_COUNT }, () => "complete").join(",")
      );

    // History cost is bounded and does NOT scale with the fan-out width.
    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(3);
    expect(historyRequests).toBeLessThan(FANOUT_WORKER_COUNT);

    // ---- open exactly one card: lazy scoped subscription ----
    expect(readNumber("registry-size")).toBe(0);
    await screen.getByTestId("open-0").click();
    await expect
      .element(screen.getByTestId("panel-messages-count"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
    // useMessages + useToolCalls → two scoped entries for the one card.
    // Poll the element: `registry-size` is repainted on a 25ms tick (it
    // reads a non-reactive Map.size), so a synchronous read can race the
    // panel mount and observe a stale 0.
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 20_000 })
      .not.toHaveTextContent("0");

    // Opening one card must not re-trigger an O(N) history walk.
    expect(readNumber("history-request-count")).toBeLessThanOrEqual(4);
  } finally {
    await cleanupRender(screen);
  }
});

it("opening every subagent card at once after reconnect stays bounded (resolves coalesce onto one history read)", async () => {
  const screen = await render(
    <ParallelFanoutReconnectStream
      apiUrl={apiUrl}
      assistantId="parallel_fanout"
      kind="subagent"
      openAll
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

    // ---- reconnect: every card's panel mounts at once, so all N
    // scoped selectors fire `resolveSubagentNamespace` concurrently and
    // race the hydrate-time discovery seed. ----
    await screen.getByTestId("reconnect").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    // Wait for every panel's scoped messages to land → every lazy
    // resolve has settled.
    await expect
      .element(screen.getByTestId("panels-ready"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    // The root discovery seed stays O(1); scoped message/tool projections
    // coalesce per namespace so each card costs at most one history read.
    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(FANOUT_WORKER_COUNT + 2);
  } finally {
    await cleanupRender(screen);
  }
});

it("keeps the final root AI message after reconnect once every subagent card resolves", async () => {
  const screen = await render(
    <ParallelFanoutReconnectStream
      apiUrl={apiUrl}
      assistantId="parallel_fanout"
      kind="subagent"
      openAll
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
    // The orchestrator's final summary turn is part of root messages.
    await expect
      .element(screen.getByTestId("root-message-texts"), { timeout: 20_000 })
      .toHaveTextContent("All workers completed.");

    // ---- reconnect: every card's panel mounts at once and races the
    // hydrate-time seed; the root final message must survive. ----
    await screen.getByTestId("reconnect").click();
    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("panels-ready"), { timeout: 20_000 })
      .toHaveTextContent(String(FANOUT_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    // Regression: the final root AI message must remain after the scoped
    // card pumps resolve — it must not be dropped from root messages.
    await expect
      .element(screen.getByTestId("root-message-texts"), { timeout: 20_000 })
      .toHaveTextContent("All workers completed.");
  } finally {
    await cleanupRender(screen);
  }
});

it("seeds M parallel subgraphs on reconnect with a bounded getHistory cost", async () => {
  const screen = await render(
    <ParallelFanoutReconnectStream
      apiUrl={apiUrl}
      assistantId="parallel_subgraph"
      kind="subgraph"
    />
  );

  try {
    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("subgraph-count"), { timeout: 20_000 })
      .toHaveTextContent(String(SUBGRAPH_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    await screen.getByTestId("reconnect").click();

    // Subgraph hosts reappear, seeded purely from getHistory (they are
    // not present in root checkpoint messages like subagents are).
    await expect
      .element(screen.getByTestId("subgraph-count"), { timeout: 20_000 })
      .toHaveTextContent(String(SUBGRAPH_WORKER_COUNT));
    await expect
      .element(screen.getByTestId("loading"), { timeout: 20_000 })
      .toHaveTextContent("Not loading");

    const historyRequests = readNumber("history-request-count");
    expect(historyRequests).toBeLessThanOrEqual(3);
    expect(historyRequests).toBeLessThan(SUBGRAPH_WORKER_COUNT);

    // Subagent and subgraph discovery stay disjoint.
    expect(readNumber("subagent-count")).toBe(0);

    await screen.getByTestId("open-0").click();
    await expect
      .element(screen.getByTestId("panel-messages-count"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 20_000 })
      .not.toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});
