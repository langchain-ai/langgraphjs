import type { Client } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  client: Client;
}

export function OnRequest({
  apiUrl,
  assistantId = "agent",
  client,
}: Props) {
  const { submit, messages } = useStream({
    assistantId,
    apiUrl,
    client,
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
      <button
        data-testid="submit"
        onClick={() =>
          void submit(
            { messages: [{ content: "Hello", type: "human" }] }
          )
        }
      >
        Send
      </button>
    </div>
  );
}
