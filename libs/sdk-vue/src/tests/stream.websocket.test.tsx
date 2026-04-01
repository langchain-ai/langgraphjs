import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { BasicStream } from "./components/BasicStream.js";
import { SubgraphDiscoveryStream } from "./components/SubgraphDiscoveryStream.js";
import { apiUrl } from "./test-utils.js";

it("streams successfully over the websocket transport", async () => {
  const screen = await render(BasicStream, {
    props: { apiUrl, transport: "websocket" },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect.element(screen.getByTestId("message-0")).toHaveTextContent("Hello");
    await expect.element(screen.getByTestId("message-1")).toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});

it("discovers subgraphs over the websocket transport", async () => {
  const screen = await render(SubgraphDiscoveryStream, {
    props: {
      apiUrl,
      assistantId: "embeddedSubgraphAgent",
      transport: "websocket",
    },
  });

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
    await screen.unmount();
  }
});
