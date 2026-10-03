import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HeadlessToolStream } from "./components/HeadlessToolStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";
import { useStream } from "../index.js";
import { getLocationTool } from "./components/browser-fixtures.js";

const LOCATION_RESULT =
  '{"latitude":37.7749,"longitude":-122.4194}' as const;

it("preserves pending tool claims across StrictMode replay but resets them on thread change", async () => {
  // Keep execution pending so the interrupt remains present throughout replay.
  const execute = vi.fn(() => new Promise<never>(() => {}));
  const tools = [getLocationTool.implement(execute)];
  const initialValues = {
    messages: [],
    __interrupt__: [
      {
        id: "pending-location-interrupt",
        value: {
          type: "tool",
          toolCall: {
            id: "pending-location-call",
            name: "get_location",
            args: {},
          },
        },
      },
    ],
  };

  function PendingToolStream({
    threadId,
    revision = 0,
  }: {
    threadId?: string;
    revision?: number;
  }) {
    useStream({
      assistantId: "headless_tool_graph",
      apiUrl,
      tools,
      initialValues,
      threadId,
    });
    return <div data-testid="revision">{revision}</div>;
  }

  const screen = await render(
    <StrictMode>
      <PendingToolStream />
    </StrictMode>,
  );
  try {
    await expect.poll(() => execute.mock.calls.length).toBe(1);
    await screen.rerender(
      <StrictMode>
        <PendingToolStream revision={1} />
      </StrictMode>,
    );
    await expect
      .element(screen.getByTestId("revision"))
      .toHaveTextContent("1");
    expect(execute).toHaveBeenCalledTimes(1);

    // A different thread may legitimately reuse the same interrupt/tool IDs.
    await screen.rerender(
      <StrictMode>
        <PendingToolStream
          threadId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
          revision={2}
        />
      </StrictMode>,
    );
    await expect.poll(() => execute.mock.calls.length).toBe(2);
  } finally {
    await cleanupRender(screen);
  }
});

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
