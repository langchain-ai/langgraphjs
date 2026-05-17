import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  ExtensionSelectorsStreamComponent,
  NamedExtensionSelectorsStreamComponent,
} from "./components/ExtensionSelectorsStream.js";
import { SelectorsStreamComponent } from "./components/SelectorsStream.js";
import {
  EmbeddedSubgraphDiscoveryStreamComponent,
  SubgraphDiscoveryStreamComponent,
} from "./components/SubgraphDiscoveryStream.js";

it("injectMessages projects the same data as stream.messages()", async () => {
  const screen = await render(SelectorsStreamComponent);

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
});

it("injectToolCalls is empty for a non-tool agent", async () => {
  const screen = await render(SelectorsStreamComponent);
  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("selector-message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("toolcalls-count"))
    .toHaveTextContent("0");
});

it("populates subgraphs and scoped injectMessages", async () => {
  const screen = await render(SubgraphDiscoveryStreamComponent);

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
  await expect
    .element(screen.getByTestId("scoped-subgraph-messages-count"))
    .not.toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("registry-size"))
    .toHaveTextContent("1");
});

it("ignores leaf function nodes and only promotes subgraph hosts", async () => {
  const screen = await render(EmbeddedSubgraphDiscoveryStreamComponent);

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

it("captures anonymous writer events on the raw custom channel", async () => {
  const screen = await render(ExtensionSelectorsStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 10_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("custom-event-count"))
    .toHaveTextContent(/^[1-9]\d*$/);
  await expect
    .element(screen.getByTestId("custom-event-types"))
    .toHaveTextContent(/custom/);
});

it("captures named custom events and exposes latest values", async () => {
  const screen = await render(NamedExtensionSelectorsStreamComponent);

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

it("continues injectExtension subscriptions across serial submits", async () => {
  const screen = await render(NamedExtensionSelectorsStreamComponent);

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
