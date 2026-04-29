import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

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

  await expect
    .element(screen.getByTestId("subgraph-count"), { timeout: 15_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("loading"), { timeout: 15_000 })
    .toHaveTextContent("Not loading");

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

  await expect
    .element(screen.getByTestId("subgraph-count"), { timeout: 15_000 })
    .toHaveTextContent("1");

  await screen.getByTestId("toggle-a").click();
  await screen.getByTestId("toggle-b").click();

  await expect
    .element(screen.getByTestId("registry-size"), { timeout: 2_000 })
    .toHaveTextContent("1");

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
