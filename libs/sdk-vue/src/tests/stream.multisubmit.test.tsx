import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import {
  MultiSubmit,
  setMultiSubmitOptions,
} from "./components/MultiSubmit.js";
import { apiUrl } from "./test-utils.js";

afterEach(() => {
  setMultiSubmitOptions(undefined);
});

it("handles back-to-back serial submits with rollback (default)", async () => {
  const screen = await render(MultiSubmit, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit-first").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await screen.getByTestId("submit-second").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .poll(
        () =>
          Array.from(
            screen
              .getByTestId("messages")
              .element()
              .querySelectorAll('[data-testid^="message-"]'),
          ).map((n) => n.textContent?.trim() ?? ""),
        { timeout: 5_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("Hello (1)"),
          expect.stringContaining("Hello (2)"),
        ]),
      );
  } finally {
    await screen.unmount();
  }
});

it("accepts multitaskStrategy: 'enqueue' without breaking serial submits", async () => {
  setMultiSubmitOptions({ multitaskStrategy: "enqueue" });

  const screen = await render(MultiSubmit, { props: { apiUrl } });

  try {
    await screen.getByTestId("submit-first").click();
    await screen.getByTestId("submit-second").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await expect
      .poll(
        () =>
          Array.from(
            screen
              .getByTestId("messages")
              .element()
              .querySelectorAll('[data-testid^="message-"]'),
          ).map((n) => n.textContent?.trim() ?? ""),
        { timeout: 5_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("Hello (1)"),
          expect.stringContaining("Hello (2)"),
        ]),
      );
  } finally {
    await screen.unmount();
  }
});
