import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { BasicStream } from "./components/BasicStream.js";
import { SubmitOnError } from "./components/SubmitOnError.js";
import { apiUrl } from "./test-utils.js";

it("recovers to idle when the underlying graph errors", async () => {
  const screen = await render(BasicStream, {
    props: { apiUrl, assistantId: "errorAgent" },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");
  } finally {
    await screen.unmount();
  }
});

it("invokes per-submit onError when the underlying graph errors", async () => {
  const screen = await render(SubmitOnError, { props: { apiUrl } });

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
    await screen.unmount();
  }
});
