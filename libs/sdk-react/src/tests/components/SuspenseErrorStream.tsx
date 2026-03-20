import { Component, Suspense, type ReactNode } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useSuspenseStream, invalidateSuspenseCache } from "../../index.js";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: (props: { error: Error; reset: () => void }) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  reset = () => {
    invalidateSuspenseCache();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallback({
        error: this.state.error,
        reset: this.reset,
      });
    }
    return this.props.children;
  }
}

interface Props {
  apiUrl: string;
}

function ErrorChat({ apiUrl }: Props) {
  const thread = useSuspenseStream<{ messages: Message[] }>({
    assistantId: "errorAgent",
    apiUrl,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="streaming">
        {thread.isStreaming ? "Streaming..." : "Not streaming"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

export function SuspenseErrorStream({ apiUrl }: Props) {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <div>
          <div data-testid="error-boundary">{error.message}</div>
          <button data-testid="retry" onClick={reset}>
            Retry
          </button>
        </div>
      )}
    >
      <Suspense
        fallback={<div data-testid="suspense-fallback">Loading...</div>}
      >
        <ErrorChat apiUrl={apiUrl} />
      </Suspense>
    </ErrorBoundary>
  );
}
