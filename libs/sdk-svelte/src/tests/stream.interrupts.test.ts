import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import InterruptStream from "./components/InterruptStream.svelte";

const serverUrl = inject("serverUrl");

it("surfaces the first interrupt on submit()", async () => {
  const screen = render(InterruptStream, { apiUrl: serverUrl });

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
  const screen = render(InterruptStream, { apiUrl: serverUrl });

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
});

it("resumes an interrupt via respond()", async () => {
  const screen = render(InterruptStream, {
    apiUrl: serverUrl,
    useRespondMethod: true,
  });

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
