import { Suspense } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useSuspenseStream, invalidateSuspenseCache } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
}

function SuspenseChat({ apiUrl, assistantId = "agent" }: Props) {
  const thread = useSuspenseStream<{ messages: Message[] }>({
    assistantId,
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
      <button data-testid="stop" onClick={() => void thread.stop()}>
        Stop
      </button>
    </div>
  );
}

export function SuspenseBasicStream({ apiUrl, assistantId }: Props) {
  return (
    <Suspense fallback={<div data-testid="suspense-fallback">Loading...</div>}>
      <SuspenseChat apiUrl={apiUrl} assistantId={assistantId} />
    </Suspense>
  );
}

export { invalidateSuspenseCache };
