import { Suspense } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useSuspenseStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  threadId?: string;
}

function SuspenseChat({
  apiUrl,
  assistantId = "stategraph_text",
  threadId,
}: Props) {
  const thread = useSuspenseStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
    threadId,
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
          void thread.submit({ messages: [new HumanMessage("Hello")] })
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

export function SuspenseBasicStream(props: Props) {
  return (
    <Suspense
      fallback={<div data-testid="suspense-fallback">Loading...</div>}
    >
      <SuspenseChat {...props} />
    </Suspense>
  );
}
