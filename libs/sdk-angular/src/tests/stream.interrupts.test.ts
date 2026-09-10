import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { InterruptStreamComponent } from "./components/InterruptStream.js";
import { InterruptReconnectStreamComponent } from "./components/InterruptReconnectStream.js";
import { InterruptReloadStreamComponent } from "./components/InterruptReloadStream.js";
import { MultiInterruptStreamComponent } from "./components/MultiInterruptStream.js";

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

it("resumes an interrupt via respond()", async () => {
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
  await expect
    .element(screen.getByTestId("interrupt-count"))
    .toHaveTextContent("0");
});

it("responds via the dedicated respond button", async () => {
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
  await expect
    .element(screen.getByTestId("interrupt-count"))
    .toHaveTextContent("0");
});

it(
  "resumes after a mid-HITL SSE drop when using a custom auth fetch",
  { timeout: 20_000 },
  async () => {
    const screen = await render(InterruptReconnectStreamComponent);

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    const opensBeforeDrop = Number(
      screen.getByTestId("event-stream-opens").element().textContent ?? "0"
    );

    await screen.getByTestId("drop-events").click();

    await expect
      .poll(
        () =>
          Number(
            screen.getByTestId("event-stream-opens").element().textContent ??
              "0"
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(opensBeforeDrop);

    await expect
      .poll(
        () =>
          Number(
            screen.getByTestId("reconnect-count").element().textContent ?? "0"
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    await screen.getByTestId("resume").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 10_000 })
      .toHaveTextContent("Not loading");
    await expect
      .element(screen.getByTestId("last-message"))
      .toHaveTextContent("After interrupt");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  }
);

it(
  "keeps a resolved interrupt hidden after a reload and a follow-up submit",
  { timeout: 30_000 },
  async () => {
    const screen = await render(InterruptReloadStreamComponent);

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("resume").click();
    await expect
      .element(screen.getByTestId("completed-turns"), { timeout: 10_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");

    await screen.getByTestId("reload").click();
    await expect
      .element(screen.getByTestId("session"), { timeout: 10_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 10_000 })
      .toHaveTextContent("Ready");

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("completed-turns"), { timeout: 10_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
    await expect
      .poll(
        () =>
          Number(
            screen.getByTestId("replayed-frames").element().textContent ?? "0"
          ),
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0);

    const observedIds = new Set<string>();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const ids = screen
        .getByTestId("interrupt-ids")
        .element()
        .textContent?.trim();
      if (ids) observedIds.add(ids);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect([...observedIds]).toEqual([]);
  }
);

it("resumes several parallel interrupts via respondAll()", { timeout: 15_000 }, async () => {
  const screen = await render(MultiInterruptStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("thread-interrupt-count"), {
      timeout: 10_000,
    })
    .toHaveTextContent("2");

  await screen.getByTestId("resume-all").click();

  await expect
    .element(screen.getByTestId("completed"), { timeout: 10_000 })
    .toHaveTextContent("true");
  await expect
    .element(screen.getByTestId("decisions"))
    .toHaveTextContent('"A":{"approved":true}');
  await expect
    .element(screen.getByTestId("decisions"))
    .toHaveTextContent('"B":{"approved":false}');
  await expect
    .element(screen.getByTestId("thread-interrupt-count"))
    .toHaveTextContent("0");
});
