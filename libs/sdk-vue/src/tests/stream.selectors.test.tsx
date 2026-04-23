import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { SelectorsStream } from "./components/SelectorsStream.js";
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
