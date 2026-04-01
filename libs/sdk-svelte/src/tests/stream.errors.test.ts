import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import SubmitOnError from "./components/SubmitOnError.svelte";

const serverUrl = inject("serverUrl");

it("invokes per-submit onError when the underlying graph errors", async () => {
  const screen = render(SubmitOnError, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("submit-error"), { timeout: 5_000 })
    .toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();
});
