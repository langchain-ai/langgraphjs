import { expect, it } from "vitest";
import { render } from "vitest-browser-angular";

import { BasicStreamComponent } from "./components/BasicStream.js";
import { MessageRemovalComponent } from "./components/MessageRemoval.js";

it("renders initial state correctly", async () => {
  const screen = await render(BasicStreamComponent);

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-count"))
    .toHaveTextContent("0");
  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent("none");
  await expect.element(screen.getByTestId("error")).not.toBeInTheDocument();
});

it("submits input, streams values, and projects messages", async () => {
  const screen = await render(BasicStreamComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Loading...");

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect.element(screen.getByTestId("message-1")).toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("cancels an in-flight run via stop()", async () => {
  const screen = await render(BasicStreamComponent);

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("assigns a thread id on first submit and surfaces it via onThreadId", async () => {
  const threadIds: string[] = [];
  const created: Array<{ run_id: string; thread_id: string }> = [];

  const screen = await render(BasicStreamComponent, {
    inputs: {
      onThreadIdCallback: (id: string) => threadIds.push(id),
      onCreatedCallback: (meta: { run_id: string; thread_id: string }) =>
        created.push(meta),
    },
  });

  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent("none");

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");

  await expect.poll(() => threadIds.length).toBeGreaterThanOrEqual(1);
  expect(typeof threadIds[0]).toBe("string");
  expect(threadIds[0].length).toBeGreaterThan(0);

  await expect
    .element(screen.getByTestId("thread-id"))
    .toHaveTextContent(threadIds[0]);

  await expect.poll(() => created.length).toBeGreaterThanOrEqual(1);
  expect(created[0].thread_id).toBe(threadIds[0]);
});

it("forwards submit options without tripping the controller", async () => {
  const screen = await render(BasicStreamComponent, {
    inputs: {
      submitOptions: {
        metadata: { tag: "protocol-v2", run: 42 },
        config: { configurable: { tone: "friendly" } },
      },
    },
  });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");
});

it("applies RemoveMessage deltas to the projected messages array", async () => {
  const screen = await render(MessageRemovalComponent);

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("loading"), { timeout: 5_000 })
    .toHaveTextContent("Not loading");

  await expect
    .element(screen.getByTestId("messages"))
    .not.toHaveTextContent("Step 1: To Remove");
  await expect
    .element(screen.getByTestId("messages"))
    .toHaveTextContent("Step 2: To Keep");
  await expect
    .element(screen.getByTestId("messages"))
    .toHaveTextContent("Step 3: To Keep");
});
