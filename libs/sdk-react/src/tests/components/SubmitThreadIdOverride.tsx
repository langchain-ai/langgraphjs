import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  submitThreadId: string;
}

export function SubmitThreadIdOverride({
  apiUrl,
  assistantId = "stategraph_text",
  submitThreadId,
}: Props) {
  const stream = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
  });

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-id">{stream.threadId ?? "none"}</div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit(
            { messages: [new HumanMessage("Hello")] },
            { threadId: submitThreadId },
          )
        }
      >
        Send
      </button>
    </div>
  );
}
