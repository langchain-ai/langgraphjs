import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import CustomTransportStream from "./components/CustomTransportStream.svelte";

const serverUrl = inject("serverUrl");

it("useStream works with HttpAgentServerAdapter", async () => {
  const screen = render(CustomTransportStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});
