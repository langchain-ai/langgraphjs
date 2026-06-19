import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { BasicStreamComponent } from "./components/BasicStream.js";
import { ContextProviderComponent } from "./components/ContextProvider.js";

it("injectStream exposes the documented signal root shape", async () => {
  const screen = await render(BasicStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("provideStream shares the same documented stream handle", async () => {
  const screen = await render(ContextProviderComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});
