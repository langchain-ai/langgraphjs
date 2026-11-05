import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { MultiInterruptReloadStreamComponent } from "./components/MultiInterruptReloadStream.js";

/**
 * A plain `submit()` while a thread is paused on several interrupts can't say
 * which interrupt it answers. The server must refuse it without starting a
 * run and leave every interrupt answerable (langchain-ai/langgraphjs#3025).
 */

type Screen = Awaited<ReturnType<typeof render>>;

const text = (screen: Screen, testId: string) =>
  screen.getByTestId(testId).element().textContent ?? "";

it(
  "refuses a free-text submit while several interrupts are pending and keeps them answerable",
  { timeout: 30_000 },
  async () => {
    const screen = await render(MultiInterruptReloadStreamComponent);

    await screen.getByTestId("submit").click();
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
      .toHaveTextContent("2");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await screen.getByTestId("free-text-submit").click();
    await expect
      .poll(
        () => `${text(screen, "error")} ${text(screen, "action-error")}`,
        { timeout: 10_000 }
      )
      .toContain("pending interrupts");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    // What the server kept: the thread is still paused on both.
    await screen.getByTestId("reload").click();
    await expect.element(screen.getByTestId("session")).toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("thread-loading"), { timeout: 5_000 })
      .toHaveTextContent("Ready");
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 5_000 })
      .toHaveTextContent("2");
    expect(text(screen, "completed")).toBe("false");

    await screen.getByTestId("resume-all").click();
    await expect
      .element(screen.getByTestId("completed"), { timeout: 10_000 })
      .toHaveTextContent("true");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
    expect(text(screen, "action-error")).toBe("");
  }
);
