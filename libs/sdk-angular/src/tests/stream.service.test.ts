import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  StreamServiceBasicComponent,
  StreamServiceErrorComponent,
} from "./components/StreamServiceBasic.js";

it("StreamService exposes the stream through DI", async () => {
  const screen = await render(StreamServiceBasicComponent);

  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("svc-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("svc-message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("selector-message-count"))
    .toHaveTextContent("2");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("StreamService surfaces errors through its signal API", async () => {
  const screen = await render(StreamServiceErrorComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("error"))
    .toHaveTextContent(/Run failed/);
});
