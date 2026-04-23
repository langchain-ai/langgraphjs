import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { ContextStream } from "./components/ContextStream.js";
import { apiUrl } from "./test-utils.js";

it("shares a stream handle across ancestor/descendant components", async () => {
  const screen = await render(ContextStream, { props: { apiUrl } });

  try {
    await expect
      .element(screen.getByTestId("child-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("child-submit").click();

    await expect
      .element(screen.getByTestId("child-message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("child-message-1"))
      .toHaveTextContent("Hey");
  } finally {
    await screen.unmount();
  }
});
