import { useState } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

export function SubmitOnError({ apiUrl }: Props) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const thread = useStream<{ messages: Message[] }>({
    assistantId: "errorAgent",
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
      {submitError ? <div data-testid="submit-error">{submitError}</div> : null}
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            { messages: [{ content: "Hello", type: "human" }] },
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
