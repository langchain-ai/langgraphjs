import { Component } from "@angular/core";
import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { injectStream } from "../index.js";
import { ContextProviderComponent } from "./components/ContextProvider.js";

@Component({
  template: `<div data-testid="orphan-messages">{{ stream.messages().length }}</div>`,
})
class OrphanStreamComponent {
  stream = injectStream<{ messages: never[] }>();
}

it("provideStream + injectStream share a single stream", async () => {
  const screen = await render(ContextProviderComponent);

  await expect
    .element(screen.getByTestId("message-0"))
    .not.toBeInTheDocument();

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("throws a descriptive error when injectStream is called outside provideStream", async () => {
  await expect(async () => {
    await render(OrphanStreamComponent);
  }).rejects.toThrow(/provideStream/);
});
