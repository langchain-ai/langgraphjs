import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { SelectorsStreamComponent } from "./components/SelectorsStream.js";

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
