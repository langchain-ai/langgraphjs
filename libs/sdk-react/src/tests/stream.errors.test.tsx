import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SubmitOnError } from "./components/SubmitOnError.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("invokes per-submit onError when the underlying graph errors", async () => {
  const screen = await render(<SubmitOnError apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("submit-error"), { timeout: 5_000 })
      .toBeInTheDocument();

    await expect
      .element(screen.getByTestId("error"))
      .toBeInTheDocument();
  } finally {
    await cleanupRender(screen);
  }
});
