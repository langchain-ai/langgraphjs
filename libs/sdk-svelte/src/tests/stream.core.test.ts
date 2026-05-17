import { it, expect, inject } from "vitest";
import { render } from "vitest-browser-svelte";

import BasicStream from "./components/BasicStream.svelte";

const serverUrl = inject("serverUrl");

it("renders initial state correctly", async () => {
  const screen = render(BasicStream, { apiUrl: serverUrl });

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
  const screen = render(BasicStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();

  await expect
    .element(screen.getByTestId("message-0"))
    .toHaveTextContent("Hello");
  await expect
    .element(screen.getByTestId("message-1"))
    .toHaveTextContent("Hey");

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("cancels an in-flight run via stop()", async () => {
  const screen = render(BasicStream, { apiUrl: serverUrl });

  await screen.getByTestId("submit").click();
  await screen.getByTestId("stop").click();

  await expect
    .element(screen.getByTestId("loading"))
    .toHaveTextContent("Not loading");
});

it("assigns a thread id on first submit and surfaces it via onThreadId", async () => {
  const threadIds: string[] = [];
  const created: Array<{ run_id: string; thread_id: string }> = [];

  const screen = render(BasicStream, {
    apiUrl: serverUrl,
    onThreadId: (id: string) => threadIds.push(id),
    onCreated: (meta: { run_id: string; thread_id: string }) =>
      created.push(meta),
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
  expect(typeof created[0].run_id).toBe("string");
  expect(created[0].run_id.length).toBeGreaterThan(0);
  expect(created[0].thread_id).toBe(threadIds[0]);
});
