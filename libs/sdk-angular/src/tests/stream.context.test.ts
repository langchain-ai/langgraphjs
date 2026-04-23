import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { ContextProviderComponent } from "./components/ContextProvider.js";

it("provideStream + injectStreamContext share a single stream", async () => {
  const screen = await render(ContextProviderComponent);

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
});
