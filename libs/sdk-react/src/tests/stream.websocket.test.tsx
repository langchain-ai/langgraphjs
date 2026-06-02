import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BasicStream } from "./components/BasicStream.js";
import { SubgraphDiscoveryStream } from "./components/SubgraphDiscoveryStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("streams successfully over the websocket transport", async () => {
  const screen = await render(
    <BasicStream apiUrl={apiUrl} transport="websocket" />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");
  } finally {
    await cleanupRender(screen);
  }
});

it("discovers subgraphs over the websocket transport", async () => {
  // Deep-descendant lifecycle events (namespace length > 1) only
  // match a wildcard `["lifecycle", "input"]` subscription, which on
  // SSE lives on a dedicated stream opened via `openEventStream`.
  // WebSocket has no `openEventStream`, so before the lifecycle
  // watcher was extended to WS, the new has-descendants promotion
  // rule in `SubgraphDiscovery` never fired over WS — the narrow
  // content pump (`depth: 1`) simply never delivered the deeper
  // events we infer from. This regression-guards that both
  // transports converge on the same discovery result.
  const screen = await render(
    <SubgraphDiscoveryStream
      apiUrl={apiUrl}
      assistantId="embedded_subgraph_graph"
      transport="websocket"
    />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("subgraph-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("subgraph-nodes"))
      .toHaveTextContent(/^research:1$/);
  } finally {
    await cleanupRender(screen);
  }
});
