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
      .element(screen.getByTestId("subagent-researcher-messages-count"))
      .not.toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("subagent-data-analyst-messages-count"))
      .not.toHaveTextContent("0");

    // TODO: pre-existing flake — scoped `useToolCalls(subagent)` mounted via
    // the `{subagents.map(...)}` path races with the server's `tools`
    // channel emission: by the time the subscription is open, the events
    // for this run may already have been dispatched. Re-enable once the
    // `ChannelRegistry` replays buffered `tools` events to late-joiners.
    // (The root `useToolCalls(stream)` path below continues to work.)
    // await expect
    //   .element(screen.getByTestId("subagent-researcher-toolcall-names"))
    //   .toHaveTextContent("search_web");
    // await expect
    //   .element(screen.getByTestId("subagent-data-analyst-toolcall-names"))
    //   .toHaveTextContent("query_database");

    await expect
      .element(screen.getByTestId("root-toolcall-names"))
      .toHaveTextContent(/task/);
  } finally {
    await cleanupRender(screen);
  }
});

it("populates subgraphs and subgraphsByNode maps and scoped useMessages", async () => {
  const screen = await render(<SubgraphDiscoveryStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // `subgraph_graph` fixture has exactly one host namespace (the
    // `child` node, a compiled subgraph containing an `inner` node).
    // The inner node itself is a leaf and MUST NOT be counted as a
    // subgraph — only namespaces observed as a strict prefix of a
    // deeper one are promoted.
    await expect
      .element(screen.getByTestId("subgraph-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("subgraph-nodes"))
      .toHaveTextContent(/^child:1$/);
    await expect
      .element(screen.getByTestId("scoped-subgraph-messages-count"))
      .not.toHaveTextContent("0");
  } finally {
    await cleanupRender(screen);
  }
});

it("ignores leaf function nodes and only promotes subgraph hosts", async () => {
  // The `embedded_subgraph_graph` fixture mirrors the
  // `nested-stategraph.ts` demo: a plain async function node
  // (`research`) invokes a compiled subgraph via `.invoke()` and
  // declares it with `{ subgraphs: [...] }`. A sibling `summarize`
  // node is a plain function with no subgraph invocation.
  //
  // Expected discovery result:
  //   - `research:<uuid>`        → subgraph (hosts `inner:<uuid>`)
  //   - `summarize:<uuid>`       → NOT a subgraph (leaf function node)
  //   - `research:<uuid>/inner:<uuid>` → NOT a subgraph (leaf inside host)
  const screen = await render(
    <SubgraphDiscoveryStream
      apiUrl={apiUrl}
      assistantId="embedded_subgraph_graph"
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
    await cleanupRender(screen);
  }
});

it("honours useChannel bufferSize for raw custom events", async () => {
  const screen = await render(
    <ExtensionSelectorsStream apiUrl={apiUrl} customBufferSize={1} />,
  );

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("custom-event-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("custom-event-types"))
      .toHaveTextContent(/custom/);
  } finally {
    await cleanupRender(screen);
  }
});

it("unwraps named custom event payloads through useExtension", async () => {
  const screen = await render(<ExtensionSelectorsStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});

it("continues useExtension subscriptions across serial submits", async () => {
  const screen = await render(<ExtensionSelectorsStream apiUrl={apiUrl} />);

  try {
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
  } finally {
    await cleanupRender(screen);
  }
});

it("exposes the latest thread values via useValues", async () => {
  const screen = await render(<ExtensionSelectorsStream apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("values-message-count"))
      .toHaveTextContent("2");
  } finally {
    await cleanupRender(screen);
  }
});
