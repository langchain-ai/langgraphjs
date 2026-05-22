import { expect, inject, it } from "vitest";
import { render } from "vitest-browser-svelte";

import BasicStream from "./components/BasicStream.svelte";
import SubgraphStream from "./components/SubgraphStream.svelte";

const serverUrl = inject("serverUrl");

it("streams successfully over the websocket transport", async () => {
  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    assistantId: "stategraph_text",
    transport: "websocket",
  });

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
});

it("discovers subgraphs over the websocket transport", async () => {
  const screen = render(SubgraphStream, {
    apiUrl: serverUrl,
    assistantId: "embedded_subgraph_graph",
    transport: "websocket",
  });

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
