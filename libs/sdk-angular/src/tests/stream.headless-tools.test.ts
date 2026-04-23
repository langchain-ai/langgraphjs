import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import {
  HeadlessToolStreamComponent,
  setHeadlessToolExecute,
} from "./components/HeadlessToolStream.js";

afterEach(() => {
  setHeadlessToolExecute(null);
});

it(
  "invokes onTool with start + success phases on happy path",
  { timeout: 60_000 },
  async () => {
    const screen = await render(HeadlessToolStreamComponent);

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("tool-event-0"), { timeout: 20_000 })
      .toHaveTextContent("start:get_location");

    await expect
      .element(screen.getByTestId("tool-event-1"), { timeout: 20_000 })
      .toHaveTextContent("success:get_location");
  },
);

it(
  "propagates execute error to the agent as a tool error payload",
  { timeout: 60_000 },
  async () => {
    setHeadlessToolExecute(async () => {
      throw new Error("GPS unavailable");
    });

    const screen = await render(HeadlessToolStreamComponent);

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("tool-event-1"), { timeout: 20_000 })
      .toHaveTextContent("error:get_location:GPS unavailable");
  },
);
