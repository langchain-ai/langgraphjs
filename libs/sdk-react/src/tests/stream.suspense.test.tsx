import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Component, Suspense, type ReactNode } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useSuspenseStream } from "../index.js";
import { SuspenseBasicStream } from "./components/SuspenseBasicStream.js";
import { apiUrl, cleanupRender } from "./test-utils.js";

it("renders immediately when no threadId is supplied (no hydrate)", async () => {
  const screen = await render(<SuspenseBasicStream apiUrl={apiUrl} />);

  try {
    // With no threadId there is nothing to hydrate, so Suspense
    // should never render its fallback — `useSuspenseStream` returns
    // synchronously on first render.
    await expect
      .element(screen.getByTestId("streaming"))
      .toHaveTextContent("Not streaming");

    await screen.getByTestId("submit").click();

    await expect
      .element(screen.getByTestId("streaming"), { timeout: 5_000 })
      .toHaveTextContent("Streaming...");

    await expect
      .element(screen.getByTestId("message-1"), { timeout: 5_000 })
      .toHaveTextContent("Plan accepted.");

    await expect
      .element(screen.getByTestId("streaming"), { timeout: 5_000 })
      .toHaveTextContent("Not streaming");
  } finally {
    await cleanupRender(screen);
  }
});

it("suspends during the initial hydrate when a threadId is supplied", async () => {
  const threadId = crypto.randomUUID();
  const screen = await render(
    <SuspenseBasicStream apiUrl={apiUrl} threadId={threadId} />,
  );

  try {
    // The component was mounted with an externally-supplied threadId,
    // which the client has never seen. Hydrate starts immediately and
    // the Suspense fallback is visible until the request settles.
    await expect
      .element(screen.getByTestId("suspense-fallback"))
      .toBeInTheDocument();

    // Once hydrate resolves (the server returns 404 / empty state)
    // the inner chat mounts and the fallback disappears.
    await expect
      .element(screen.getByTestId("streaming"), { timeout: 5_000 })
      .toBeInTheDocument();
  } finally {
    await cleanupRender(screen);
  }
});

interface BoundaryProps {
  children: ReactNode;
  fallback: (error: Error) => ReactNode;
}

class ErrorBoundary extends Component<
  BoundaryProps,
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

function ErrorChat({
  apiUrl,
  threadId,
}: {
  apiUrl: string;
  threadId: string;
}) {
  const stream = useSuspenseStream<{ messages: BaseMessage[] }>({
    assistantId: "error_graph",
    apiUrl,
    threadId,
  });
  return (
    <div>
      <div data-testid="streaming">
        {stream.isStreaming ? "Streaming..." : "Not streaming"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({ messages: [new HumanMessage("Hello")] })
        }
      >
        Send
      </button>
    </div>
  );
}

it("routes non-streaming errors to the nearest Error Boundary", async () => {
  const originalError = console.error;
  console.error = () => undefined;

  try {
    const invalidUrl = "http://localhost:1/nope";
    const threadId = crypto.randomUUID();

    const screen = await render(
      <ErrorBoundary
        fallback={(error) => (
          <div data-testid="boundary">{error.message}</div>
        )}
      >
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <ErrorChat apiUrl={invalidUrl} threadId={threadId} />
        </Suspense>
      </ErrorBoundary>,
    );

    try {
      // The hydrate request fails (unreachable host). The rejection
      // propagates through `hydrationPromise` into the Error Boundary.
      await expect
        .element(screen.getByTestId("boundary"), { timeout: 5_000 })
        .toBeInTheDocument();
    } finally {
      await cleanupRender(screen);
    }
  } finally {
    console.error = originalError;
  }
});
