import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { DeepAgentSubscriptionStreamComponent } from "./components/DeepAgentSubscriptionStream.js";
import { SubscriptionSubgraphStreamComponent } from "./components/SubscriptionSubgraphStream.js";

it("does not open scoped subscriptions for a bare injectStream mount", async () => {
  const screen = await render(SubscriptionSubgraphStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("registry-size"))
    .toHaveTextContent("0");
});

it("opens one scoped subgraph subscription and releases it on destroy", async () => {
  const screen = await render(SubscriptionSubgraphStreamComponent);

  await screen.getByTestId("submit").click();

  // Wait for the run to finish before snapshotting the discovery state.
  // Asserting `subgraph-count == 1` while the run is still in flight is
  // racy: the discovery promotion can arrive in the same Angular change-
  // detection tick that lands the next event, so the DOM may transition
  // 0 → N without displaying "1" long enough for the matcher's polling
  // loop to observe it. By the time loading flips to "Not loading", the
  // promoted set has settled and the count is stable.
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("subgraph-count"))
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-a").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("observer-a-namespace"))
    .toHaveTextContent(/^child:/);
  await expect
    .element(screen.getByTestId("observer-a-count"))
    .not.toHaveTextContent("0");

  await screen.getByTestId("toggle-a").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("dedupes multiple Angular consumers of the same subgraph target", async () => {
  const screen = await render(SubscriptionSubgraphStreamComponent);

  await screen.getByTestId("submit").click();

  // Wait for the run to complete before mounting observers. Gating on
  // `subgraph-count == 1` mid-flight is racy in CI because discovery
  // promotions can land in the same change-detection tick as the next
  // event, occasionally causing the DOM to skip "1" and read "2"
  // before settling. Waiting for loading to flip provides a stable
  // anchor; both observers share `firstSubgraph()` regardless of how
  // many subgraphs exist, so the dedup invariant we are testing here
  // does not depend on the exact count.
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("subgraph-count"))
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-a").click();
  await screen.getByTestId("toggle-b").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");

  // Observers acquire the shared registry entry which subscribes the
  // server side via a fresh stream rotation; replay drains
  // asynchronously after registry-size flips. Poll for non-zero
  // before sampling so we don't capture a pre-data `0/0` snapshot.
  await expect
    .element(screen.getByTestId("observer-a-count"), { timeout: 5_000 })
    .not.toHaveTextContent("0");

  const a = Number(
    screen.getByTestId("observer-a-count").element().textContent,
  );
  const b = Number(
    screen.getByTestId("observer-b-count").element().textContent,
  );
  expect(a).toBeGreaterThan(0);
  expect(a).toBe(b);

  await screen.getByTestId("toggle-a").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("observer-b-count"))
    .toHaveTextContent(String(b));

  await screen.getByTestId("toggle-b").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("root injectMessages is served by the always-on projection", async () => {
  const screen = await render(DeepAgentSubscriptionStreamComponent);

  await expect
    .element(screen.getByTestId("registry-size"))
    .toHaveTextContent("0");

  await screen.getByTestId("toggle-root-messages").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");

  await screen.getByTestId("toggle-root-messages").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("keeps subagent message streams isolated across namespaces", async () => {
  const screen = await render(DeepAgentSubscriptionStreamComponent, {
    inputs: {
      initialMounts: {
        researcherMessagesA: true,
        analystMessages: true,
      },
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  const researcherNs = screen
    .getByTestId("obs-researcher-a-namespace")
    .element().textContent;
  const analystNs = screen
    .getByTestId("obs-analyst-namespace")
    .element().textContent;
  expect(researcherNs).toBeTruthy();
  expect(analystNs).toBeTruthy();
  expect(researcherNs).not.toBe(analystNs);

  // Both projections drain asynchronously after the terminal
  // lifecycle event; poll each before sampling so we never read a
  // pre-data `0` from a healthy projection.
  await expect
    .element(screen.getByTestId("obs-researcher-a-count"), { timeout: 5_000 })
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("obs-analyst-count"), { timeout: 5_000 })
    .not.toHaveTextContent("0");

  const researcherCount = Number(
    screen.getByTestId("obs-researcher-a-count").element().textContent,
  );
  const analystCount = Number(
    screen.getByTestId("obs-analyst-count").element().textContent,
  );
  expect(researcherCount).toBeGreaterThan(0);
  expect(analystCount).toBeGreaterThan(0);

  await screen.getByTestId("toggle-researcher-messages-a").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-analyst-messages").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("0");
});

it("ratchets registry entries across subagent observer kinds", async () => {
  const screen = await render(DeepAgentSubscriptionStreamComponent);

  await screen.getByTestId("submit").click();
  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  const steps: Array<{ click: string; expected: number }> = [
    { click: "toggle-researcher-messages-a", expected: 1 },
    { click: "toggle-researcher-messages-b", expected: 1 },
    { click: "toggle-analyst-messages", expected: 2 },
    { click: "toggle-researcher-toolcalls", expected: 3 },
  ];

  for (const step of steps) {
    await screen.getByTestId(step.click).click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent(String(step.expected));
  }

  const teardown: Array<{ click: string; expected: number }> = [
    { click: "toggle-researcher-toolcalls", expected: 2 },
    { click: "toggle-analyst-messages", expected: 1 },
    { click: "toggle-researcher-messages-b", expected: 1 },
    { click: "toggle-researcher-messages-a", expected: 0 },
  ];

  for (const step of teardown) {
    await screen.getByTestId(step.click).click();
    await expect
      .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
      .toHaveTextContent(String(step.expected));
  }
});
