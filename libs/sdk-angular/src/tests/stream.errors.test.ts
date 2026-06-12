import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { SubmitOnErrorComponent } from "./components/SubmitOnError.js";

it("invokes per-submit onError when the underlying graph errors", async () => {
  const screen = await render(SubmitOnErrorComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("submit-error"), { timeout: 5_000 })
    .toBeInTheDocument();

  await expect.element(screen.getByTestId("error")).toBeInTheDocument();
});

it("recovers to idle when the underlying graph errors", async () => {
  const screen = await render(SubmitOnErrorComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect.element(screen.getByTestId("error")).toBeInTheDocument();
});
