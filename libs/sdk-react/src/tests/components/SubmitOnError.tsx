import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function SubmitOnError({
  apiUrl,
  assistantId = "error_graph",
}: Props) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
  });

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}
      {submitError ? (
        <div data-testid="submit-error">{submitError}</div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            { messages: [new HumanMessage("Hello")] },
            {
              onError: (error: unknown) => {
                setSubmitError(
                  // eslint-disable-next-line no-instanceof/no-instanceof
                  error instanceof Error ? error.message : String(error),
                );
              },
            },
          )
        }
      >
        Send
      </button>
    </div>
  );
}
