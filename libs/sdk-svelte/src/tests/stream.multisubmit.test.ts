import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import MultiSubmit from "./components/MultiSubmit.svelte";

const serverUrl = inject("serverUrl");

it("handles back-to-back serial submits with rollback (default)", async () => {
  const screen = render(MultiSubmit, { apiUrl: serverUrl });

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
});

it("accepts multitaskStrategy: 'enqueue' without breaking serial submits", async () => {
  const screen = render(MultiSubmit, {
    apiUrl: serverUrl,
    submitOptions: { multitaskStrategy: "enqueue" },
  });

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
});
