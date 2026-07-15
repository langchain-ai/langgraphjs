import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { InterruptStream } from "./components/InterruptStream.js";
import { InterruptReconnectStream } from "./components/InterruptReconnectStream.js";
import { MultiInterruptStream } from "./components/MultiInterruptStream.js";
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

it("resumes an interrupt via respond()", async () => {
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

it(
  "resumes after a mid-HITL SSE drop when using a custom auth fetch",
  { timeout: 20_000 },
  async () => {
    const screen = await render(InterruptReconnectStream, {
      props: { apiUrl },
    });

    try {
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
              screen.getByTestId("reconnect-count").element().textContent ??
                "0"
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
    } finally {
      await screen.unmount();
    }
  }
);

it("resumes several parallel interrupts via respondAll()", { timeout: 15_000 }, async () => {
  const screen = await render(MultiInterruptStream, { props: { apiUrl } });

  try {
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
  } finally {
    await screen.unmount();
  }
});
