import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  WebSocketEmbeddedSubgraphDiscoveryStreamComponent,
} from "./components/SubgraphDiscoveryStream.js";
import { WebSocketBasicStreamComponent } from "./components/WebSocketBasicStream.js";

it("streams successfully over the websocket transport", async () => {
  const screen = await render(WebSocketBasicStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("discovers subgraphs over the websocket transport", async () => {
  const screen = await render(WebSocketEmbeddedSubgraphDiscoveryStreamComponent);

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
});
