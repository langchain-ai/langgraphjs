import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import ContextParent from "./components/ContextParent.svelte";
import ContextOrphan from "./components/ContextOrphan.svelte";

const serverUrl = inject("serverUrl");

it("provideStream exposes the stream to descendants", async () => {
  const screen = render(ContextParent, { apiUrl: serverUrl });

  await expect
    .element(screen.getByTestId("parent-loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("child-loading"))
    .toHaveTextContent("Not loading");

  await screen.getByTestId("parent-submit").click();

  // Both parent and child observe the same stream.
  await expect
    .element(screen.getByTestId("child-message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("child-message-1"))
    .toHaveTextContent("Hey");
});

it("getStream throws when no ancestor provided a stream", async () => {
  const screen = render(ContextOrphan);

  await expect
    .element(screen.getByTestId("orphan-error"))
    .toHaveTextContent(/provideStream/);
});
