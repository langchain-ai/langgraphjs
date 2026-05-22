import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { InterruptStream } from "./components/InterruptStream.js";
import { apiUrl } from "./test-utils.js";

it("surfaces the first interrupt on submit()", async () => {
  const screen = await render(InterruptStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-node"))
      .toHaveTextContent("agent");
    await expect
      .element(screen.getByTestId("interrupt-id"))
      .not.toHaveTextContent("");
  } finally {
    await screen.unmount();
  }
});

it("resumes an interrupt via submit({ command: { resume } })", async () => {
  const screen = await render(InterruptStream, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("last-message"))
      .toHaveTextContent("After interrupt");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("resumes an interrupt via respond()", async () => {
  const screen = await render(InterruptStream, {
    props: { apiUrl, useRespondMethod: true },
  });

  try {
    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .element(screen.getByTestId("last-message"))
      .toHaveTextContent("After interrupt");
  } finally {
    await screen.unmount();
  }
});
