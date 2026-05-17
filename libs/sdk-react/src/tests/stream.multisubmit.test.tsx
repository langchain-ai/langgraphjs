import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MultiSubmit } from "./components/MultiSubmit.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("handles back-to-back serial submits with rollback (default)", async () => {
  const screen = await render(<MultiSubmit apiUrl={apiUrl} />);

  try {
    await screen.getByTestId("submit-first").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    await screen.getByTestId("submit-second").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // Both user turns should have landed — rollback semantics keep
    // the first run's terminal state in the message history.
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
    await cleanupRender(screen);
  }
});

it("accepts multitaskStrategy: 'enqueue' without breaking serial submits", async () => {
  const screen = await render(
    <MultiSubmit
      apiUrl={apiUrl}
      submitOptions={{ multitaskStrategy: "enqueue" }}
    />,
  );

  try {
    await screen.getByTestId("submit-first").click();
    await screen.getByTestId("submit-second").click();

    await expect
      .element(screen.getByTestId("loading"), { timeout: 5_000 })
      .toHaveTextContent("Not loading");

    // The client-side queue drains both submits once the first run
    // terminates, so both human turns must appear.
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
    await cleanupRender(screen);
  }
});
