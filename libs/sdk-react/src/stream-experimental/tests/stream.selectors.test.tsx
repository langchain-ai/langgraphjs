import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { DeepAgentStream } from "./components/DeepAgentStream.js";
import { SubgraphDiscoveryStream } from "./components/SubgraphDiscoveryStream.js";
import { ExtensionSelectorsStream } from "./components/ExtensionSelectorsStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("discovers subagents and scopes useMessages/useToolCalls to each namespace", async () => {
  const screen = await render(<DeepAgentStream apiUrl={apiUrl} />);

  try {
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("subagent-count"), { timeout: 30_000 })
      .toHaveTextContent("2");

    await expect
      .element(screen.getByTestId("loading"), { timeout: 30_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("subagent-names"))
      .toHaveTextContent(/data-analyst/);
    await expect
      .element(screen.getByTestId("subagent-names"))
      .toHaveTextContent(/researcher/);

    await expect
      .element(screen.getByTestId("subagent-researcher-status"))
      .toHaveTextContent("complete");
    await expect
      .element(screen.getByTestId("subagent-data-analyst-status"))
      .toHaveTextContent("complete");

    await expect
      .element(screen.getByTestId("subagent-researcher-messages-count"))
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("subagent-data-analyst-messages-count"))
      .not.toHaveTextContent("0");

    await expect
      .element(screen.getByTestId("subagent-researcher-toolcall-names"))
      .toHaveTextContent("search_web");
    await expect
      .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
      .toHaveTextContent("query_database");

    await expect
      .element(screen.getByTestId("root-toolcall-names"))
      .toHaveTextContent(/task/);
  } finally {
    cleanupRender(screen);
  }
});

it("populates subgraphs and subgraphsByNode maps and scoped useMessages", async () => {
  const screen = await render(<SubgraphDiscoveryStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 15_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("subgraph-count"))
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("subgraph-nodes"))
      .toHaveTextContent(/child:\d+/);
  } finally {
    cleanupRender(screen);
  }
});

it("captures anonymous writer events on the raw custom channel", async () => {
  const screen = await render(<ExtensionSelectorsStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");

    const rawCount = Number(
      screen.getByTestId("custom-event-count").element().textContent,
    );
    expect(rawCount).toBeGreaterThan(0);
    await expect
      .element(screen.getByTestId("custom-event-types"))
      .toHaveTextContent(/custom/);
  } finally {
    cleanupRender(screen);
  }
});

it("exposes the latest thread values via useValues", async () => {
  const screen = await render(<ExtensionSelectorsStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");

    // The `custom_channel_graph` fixture appends a single AI reply, so
    // the authoritative `values` surface should include the echoed
    // human message plus the AI response.
    const valuesCount = Number(
      screen.getByTestId("values-message-count").element().textContent,
    );
    expect(valuesCount).toBeGreaterThanOrEqual(2);
  } finally {
    cleanupRender(screen);
  }
});
