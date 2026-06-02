import { expect, it, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import HeadlessToolStream from "./components/HeadlessToolStream.svelte";

const serverUrl = inject("serverUrl");

it(
  "invokes onTool with start + success phases on happy path",
  { timeout: 20_000 },
  async () => {
    const screen = render(HeadlessToolStream, { apiUrl: serverUrl });

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("tool-event-0"), { timeout: 5_000 })
      .toHaveTextContent("start:get_location");

    await expect
      .element(screen.getByTestId("tool-event-1"), { timeout: 5_000 })
      .toHaveTextContent("success:get_location");
  },
);

it(
  "propagates execute error to the agent as a tool error payload",
  { timeout: 20_000 },
  async () => {
    const screen = render(HeadlessToolStream, {
      apiUrl: serverUrl,
      execute: async () => {
        throw new Error("GPS unavailable");
      },
    });

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("tool-event-1"), { timeout: 5_000 })
      .toHaveTextContent("error:get_location:GPS unavailable");
  },
);
