import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { InterruptStreamComponent } from "./components/InterruptStream.js";

it("surfaces the first interrupt on submit()", async () => {
  const screen = await render(InterruptStreamComponent);

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
});

it("resumes an interrupt via submit({ command: { resume } })", async () => {
  const screen = await render(InterruptStreamComponent);

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
});

it("resumes an interrupt via respond()", async () => {
  const screen = await render(InterruptStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
    .toHaveTextContent("1");

  await screen.getByTestId("respond").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("last-message"))
    .toHaveTextContent("After interrupt");
});
