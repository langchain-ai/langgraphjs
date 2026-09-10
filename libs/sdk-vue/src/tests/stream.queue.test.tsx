import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import { QueueStream } from "./components/QueueStream.js";
import { apiUrl } from "./test-utils.js";

it("ordinary submits still complete on a protocol-only server", async () => {
  const screen = await render(QueueStream, { props: { apiUrl } });
  try {
    await screen.getByTestId("submit-first").click();
    await expect.element(screen.getByTestId("message-count"), { timeout: 5_000 }).toHaveTextContent("2");
    await expect.element(screen.getByTestId("loading"), { timeout: 5_000 }).toHaveTextContent("Not loading");
    await expect.element(screen.getByTestId("queue-size")).toHaveTextContent("0");
  } finally {
    await screen.unmount();
  }
});

it("rejects enqueue without an explicit server queue capability", async () => {
  const screen = await render(QueueStream, { props: { apiUrl } });
  try {
    await screen.getByTestId("submit-first").click();
    await screen.getByTestId("submit-three").click();
    await expect.element(screen.getByTestId("queue-error"), { timeout: 5_000 }).toHaveTextContent("serverQueue capability");
    await expect.element(screen.getByTestId("queue-size")).toHaveTextContent("0");
    await expect.element(screen.getByTestId("message-count"), { timeout: 5_000 }).toHaveTextContent("2");
  } finally {
    await screen.unmount();
  }
});
