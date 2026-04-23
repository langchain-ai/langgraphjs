import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { HeadlessToolStream } from "./components/HeadlessToolStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it(
  "invokes onTool with start + success phases on happy path",
  { timeout: 60_000 },
  async () => {
    const screen = await render(<HeadlessToolStream apiUrl={apiUrl} />);

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("tool-event-0"), { timeout: 20_000 })
        .toHaveTextContent("start:get_location");

      await expect
        .element(screen.getByTestId("tool-event-1"), { timeout: 20_000 })
        .toHaveTextContent("success:get_location");
    } finally {
      cleanupRender(screen);
    }
  },
);

it(
  "propagates execute error to the agent as a tool error payload",
  { timeout: 60_000 },
  async () => {
    const failingExecute = async () => {
      throw new Error("GPS unavailable");
    };

    const screen = await render(
      <HeadlessToolStream apiUrl={apiUrl} execute={failingExecute} />,
    );

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("tool-event-1"), { timeout: 20_000 })
        .toHaveTextContent("error:get_location:GPS unavailable");
    } finally {
      cleanupRender(screen);
    }
  },
);
