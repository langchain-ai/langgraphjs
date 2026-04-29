import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStreamContext } from "../index.js";
import { ContextProvider } from "./components/ContextProvider.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("shares a single stream across siblings via StreamProvider", async () => {
  const screen = await render(<ContextProvider apiUrl={apiUrl} />);

  try {
    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Loading...");

    await expect
      .element(screen.getByTestId("message-0"))
      .toHaveTextContent("Hello");
    await expect
      .element(screen.getByTestId("message-1"))
      .toHaveTextContent("Plan accepted.");

    await expect
      .element(screen.getByTestId("loading"))
      .toHaveTextContent("Not loading");
  } finally {
    await cleanupRender(screen);
  }
});

it("throws a descriptive error when useStreamContext is called outside a provider", async () => {
  function Orphan() {
    const { messages } = useStreamContext<{ messages: never[] }>();
    return <div data-testid="orphan-messages">{messages.length}</div>;
  }

  // React swallows render-throw errors into the console by default —
  // silence them so the test output stays clean.
  const originalError = console.error;
  console.error = () => undefined;

  try {
    await expect(async () => {
      const screen = await render(<Orphan />);
      await cleanupRender(screen);
    }).rejects.toThrow(/StreamProvider/);
  } finally {
    console.error = originalError;
  }
});
