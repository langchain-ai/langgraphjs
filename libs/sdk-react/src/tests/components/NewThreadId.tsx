import { useStream } from "../../index.js";
import type { Message } from "@langchain/langgraph-sdk";

interface Props {
  apiUrl: string;
  assistantId?: string;
  threadId?: string | null;
  onThreadId?: (threadId: string) => void;
  submitThreadId?: string;
}

export function NewThreadId({
  apiUrl,
  assistantId = "agent",
  threadId = null,
  onThreadId,
  submitThreadId,
}: Props) {
  const stream = useStream<{ messages: Message[] }>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-id">
        {stream.client ? "Client ready" : "No client"}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({} as any, { threadId: submitThreadId })
        }
      >
        Submit
      </button>
    </div>
  );
}
