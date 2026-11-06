import type { Client } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  client: Client;
  threadId: string;
}

export function RejoinOnMount({ apiUrl, client, threadId }: Props) {
  const { messages, isLoading } = useStream({
    assistantId: "agent",
    apiUrl,
    client,
    threadId,
    reconnectOnMount: true,
  });

  return (
    <div>
      <div data-testid="messages">
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="loading">{isLoading ? "Loading..." : "Not loading"}</div>
    </div>
  );
}
