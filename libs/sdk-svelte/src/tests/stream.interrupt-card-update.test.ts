import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import InterruptCardStream from "./components/InterruptCardStream.svelte";

/**
 * End-to-end coverage for the customer HITL flow: an interrupt raised
 * from a tool carries an AIMessage card, and the frontend resolves the
 * interrupt AND pushes that card into state in a single atomic
 * `respond(decision, { update: { messages: [card] } })`. The card must
 * land in committed state exactly once (the backend never adds it) and
 * stay there while the slow tool finishes — no flicker, no disappearance.
 */

const serverUrl = inject("serverUrl");

it(
  "keeps the FE-pushed card in state through a slow tool on approve",
  { timeout: 20_000 },
  async () => {
    const screen = render(InterruptCardStream, { apiUrl: serverUrl });

    await screen.getByTestId("submit").click();

    // The tool raised an interrupt carrying the validation card.
    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-card"))
      .toHaveTextContent("tool_validation");

    // Resolve the interrupt AND push the card into state in one call.
    await screen.getByTestId("approve").click();

    // The FE-pushed card lands in committed state — exactly one copy.
    await expect
      .element(screen.getByTestId("card-count"), { timeout: 10_000 })
      .toHaveTextContent("1");

    // It is still present while the slow tool is executing (no flicker).
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("loading");
    await expect
      .element(screen.getByTestId("card-in-state"))
      .toHaveTextContent("present");

    // Once the tool finishes, the backend's result lands alongside the
    // single FE-owned card, and the interrupt is cleared.
    await expect
      .element(screen.getByTestId("messages"), { timeout: 15_000 })
      .toHaveTextContent('tool:Executed "delete_db".');
    await expect
      .element(screen.getByTestId("card-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("idle");
  },
);

it(
  "keeps the card and informs the agent on reject",
  { timeout: 20_000 },
  async () => {
    const screen = render(InterruptCardStream, { apiUrl: serverUrl });

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("interrupt-count"), { timeout: 10_000 })
      .toHaveTextContent("1");

    await screen.getByTestId("reject").click();

    // The rejection tool message lands; the FE-pushed card is still
    // there exactly once.
    await expect
      .element(screen.getByTestId("messages"), { timeout: 15_000 })
      .toHaveTextContent("tool:User has rejected the toolcall");
    await expect
      .element(screen.getByTestId("card-count"))
      .toHaveTextContent("1");
    await expect
      .element(screen.getByTestId("interrupt-count"))
      .toHaveTextContent("0");
  },
);
