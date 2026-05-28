import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ExtensionSelectorsStream } from "./components/ExtensionSelectorsStream.js";
import { SelectorsStream } from "./components/SelectorsStream.js";
import { SubgraphDiscoveryStream } from "./components/SubgraphDiscoveryStream.js";
import { apiUrl } from "./test-utils.js";

it("useMessages projects the same data as stream.messages", async () => {
  const screen = await render(SelectorsStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("selector-message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("selector-message-1"))
      .toHaveTextContent("Hey");

    await expect
      .element(screen.getByTestId("messages-count"))
      .toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});

it("useToolCalls is empty for a non-tool agent", async () => {
  const screen = await render(SelectorsStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("selector-message-1"))
      .toHaveTextContent("Hey");

    await expect
      .element(screen.getByTestId("toolcalls-count"))
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("populates subgraphs and subgraphsByNode maps and scoped useMessages", async () => {
  const screen = await render(SubgraphDiscoveryStream, { props: { apiUrl } });

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
      .toHaveTextContent(/^child:1$/);
  } finally {
    await screen.unmount();
  }
});

it("ignores leaf function nodes and only promotes subgraph hosts", async () => {
  const screen = await render(SubgraphDiscoveryStream, {
    props: { apiUrl, assistantId: "embeddedSubgraphAgent" },
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

it("captures anonymous writer events on the raw custom channel", async () => {
  const screen = await render(ExtensionSelectorsStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    const rawCount = Number(
      screen.getByTestId("custom-event-count").element().textContent,
    );
    expect(rawCount).toBeGreaterThan(0);
    await expect
      .element(screen.getByTestId("custom-event-types"))
      .toHaveTextContent(/custom/);
  } finally {
    await screen.unmount();
  }
});

it("caps raw custom channel events with bufferSize", async () => {
  const screen = await render(ExtensionSelectorsStream, {
    props: { apiUrl, rawBufferSize: 1 },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("custom-event-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("custom-event-types"))
      .toHaveTextContent(/^custom$/);
  } finally {
    await screen.unmount();
  }
});

it("captures named custom events through useExtension", async () => {
  const screen = await render(ExtensionSelectorsStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
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
  } finally {
    await screen.unmount();
  }
});

it("continues useExtension subscriptions across serial submits", async () => {
  const screen = await render(ExtensionSelectorsStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("extension-count"))
      .toHaveTextContent("1");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("extension-count"))
      .toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});

it("exposes the latest thread values via useValues", async () => {
  const screen = await render(ExtensionSelectorsStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("values-message-count"))
      .toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});
