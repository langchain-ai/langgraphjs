import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import {
  HeadlessToolStream,
  setHeadlessToolExecute,
} from "./components/HeadlessToolStream.js";
import { apiUrl } from "./test-utils.js";

const LOCATION_RESULT =
  '{"latitude":37.7749,"longitude":-122.4194}' as const;

afterEach(() => {
  setHeadlessToolExecute(null);
});

it(
  "executes headless tool, resumes with result, and completes the run",
  { timeout: 20_000 },
  async () => {
    const screen = await render(HeadlessToolStream, { props: { apiUrl } });

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("tool-event-0"), { timeout: 5_000 })
        .toHaveTextContent("start:get_location");

      await expect
        .element(screen.getByTestId("tool-event-1"), { timeout: 5_000 })
        .toHaveTextContent(`success:get_location:${LOCATION_RESULT}`);

      await expect
        .element(screen.getByTestId("message-last"), { timeout: 5_000 })
        .toHaveTextContent("Location received!");

      await expect
        .element(screen.getByTestId("loading"), { timeout: 5_000 })
        .toHaveTextContent("idle");

      await expect
        .element(screen.getByTestId("interrupt-count"))
        .toHaveTextContent("0");
    } finally {
      await screen.unmount();
    }
  },
);

it(
  "propagates execute error to the agent as a tool error payload",
  { timeout: 20_000 },
  async () => {
    setHeadlessToolExecute(async () => {
      throw new Error("GPS unavailable");
    });

    const screen = await render(HeadlessToolStream, { props: { apiUrl } });

    try {
      await screen.getByTestId("submit").click();

      await expect
        .element(screen.getByTestId("tool-event-1"), { timeout: 5_000 })
        .toHaveTextContent("error:get_location:GPS unavailable");

      await expect
        .element(screen.getByTestId("message-last"), { timeout: 5_000 })
        .toHaveTextContent("Location received!");
    } finally {
      await screen.unmount();
    }
  },
);
