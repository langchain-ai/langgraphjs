import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import RootSelectorsStream from "./components/RootSelectorsStream.svelte";
import DeepAgentStream from "./components/DeepAgentStream.svelte";
import SubgraphStream from "./components/SubgraphStream.svelte";
import ExtensionSelectorsStream from "./components/ExtensionSelectorsStream.svelte";

const serverUrl = inject("serverUrl");

it("root useMessages / useToolCalls / useValues delegate to stream root projections", async () => {
  const screen = render(RootSelectorsStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("messages-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  // Human message + AI reply.
  await expect
    .element(screen.getByTestId("messages-count"))
    .toHaveTextContent("2");
  await expect
    .element(screen.getByTestId("messages-first"))
    .toHaveTextContent("Hi");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  // values surface should hold the same messages array length.
  await expect
    .element(screen.getByTestId("values-messages-count"))
    .toHaveTextContent("2");
});

it("useChannel buffers raw custom events", async () => {
  const screen = render(RootSelectorsStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");

  const customCount = Number(
    screen.getByTestId("custom-event-count").element().textContent,
  );
  expect(customCount).toBeGreaterThan(0);
  await expect
    .element(screen.getByTestId("custom-event-types"))
    .toHaveTextContent(/custom/);
});

it("unwraps named custom event payloads through useExtension", async () => {
  const screen = render(ExtensionSelectorsStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("extension-label"))
    .toHaveTextContent("answering");
  await expect
    .element(screen.getByTestId("extension-json"))
    .toHaveTextContent('{"label":"answering"}');
  await expect
    .element(screen.getByTestId("values-message-count"))
    .toHaveTextContent("2");
});

it("continues useExtension subscriptions across serial submits", async () => {
  const screen = render(ExtensionSelectorsStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("extension-count"))
    .toHaveTextContent("1");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("extension-count"))
    .toHaveTextContent("2");
});

it("discovers subagents and scopes useMessages/useToolCalls to each namespace", async () => {
  const screen = render(DeepAgentStream, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("subagent-count"), { timeout: 5_000 })
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
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
    .element(screen.getByTestId("subagent-researcher-namespace"))
    .toHaveTextContent(/^tools:/);
  await expect
    .element(screen.getByTestId("subagent-data-analyst-namespace"))
    .toHaveTextContent(/^tools:/);

  await expect
    .element(screen.getByTestId("root-toolcall-names"))
    .toHaveTextContent(/task/);
});

it("populates subgraphs and subgraphsByNode maps", async () => {
  const screen = render(SubgraphStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("subgraph-count"), { timeout: 5_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("subgraph-nodes"))
    .toHaveTextContent(/^child:1$/);
});

it("ignores leaf function nodes and only promotes subgraph hosts", async () => {
  const screen = render(SubgraphStream, {
    apiUrl: serverUrl,
    assistantId: "embedded_subgraph_graph",
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("subgraph-count"), { timeout: 5_000 })
    .toHaveTextContent("1");
  await expect
    .element(screen.getByTestId("subgraph-nodes"))
    .toHaveTextContent(/^research:1$/);
});
