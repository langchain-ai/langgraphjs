import { Activity, StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HeadlessToolStream } from "./components/HeadlessToolStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

const LOCATION_RESULT =
  '{"latitude":37.7749,"longitude":-122.4194}' as const;

const PENDING_LOCATION_VALUES = {
  messages: [],
  __interrupt__: [
    {
      id: "location-interrupt",
      value: {
        type: "tool",
        toolCall: { id: "location-call", name: "get_location", args: {} },
      },
    },
  ],
};

it(
  "executes headless tool, resumes with result, and completes the run",
  { timeout: 20_000 },
  async () => {
    const screen = await render(<HeadlessToolStream apiUrl={apiUrl} />);

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
      await cleanupRender(screen);
    }
  },
);

it(
  "propagates execute error to the agent as a tool error payload",
  { timeout: 20_000 },
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
        .element(screen.getByTestId("tool-event-1"), { timeout: 5_000 })
        .toHaveTextContent("error:get_location:GPS unavailable");

      await expect
        .element(screen.getByTestId("message-last"), { timeout: 5_000 })
        .toHaveTextContent("Location received!");
    } finally {
      await cleanupRender(screen);
    }
  },
);

it("runs a pending headless tool once under StrictMode", async () => {
  const execute = vi.fn(() => new Promise<never>(() => {}));
  const screen = await render(
    <StrictMode>
      <HeadlessToolStream
        apiUrl={apiUrl}
        execute={execute}
        initialValues={PENDING_LOCATION_VALUES}
      />
    </StrictMode>,
  );

  try {
    await expect
      .element(screen.getByTestId("tool-event-0"))
      .toHaveTextContent("start:get_location");
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await cleanupRender(screen);
  }
});

it("runs a pending headless tool once per thread across a switch", async () => {
  const execute = vi.fn(() => new Promise<never>(() => {}));
  const firstThread = crypto.randomUUID();
  const secondThread = crypto.randomUUID();
  const view = (threadId: string, mode: "visible" | "hidden" = "visible") => (
    <Activity mode={mode}>
      <HeadlessToolStream
        apiUrl={apiUrl}
        execute={execute}
        initialValues={PENDING_LOCATION_VALUES}
        threadId={threadId}
      />
    </Activity>
  );

  const screen = await render(view(firstThread));
  try {
    expect(execute, "on the first thread").toHaveBeenCalledTimes(1);

    await screen.rerender(view(secondThread));
    expect(execute, "after switching threads").toHaveBeenCalledTimes(2);

    await screen.rerender(view(secondThread, "hidden"));
    await screen.rerender(view(secondThread));
    expect(execute, "replayed on the new thread").toHaveBeenCalledTimes(2);
  } finally {
    await cleanupRender(screen);
  }
});
