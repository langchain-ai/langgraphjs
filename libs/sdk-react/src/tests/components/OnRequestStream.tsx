import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Client } from "@langchain/langgraph-sdk";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface Props {
  apiUrl: string;
  client: Client;
  assistantId?: string;
  threadId?: string;
}

export function OnRequestStream({
  apiUrl,
  client,
  assistantId = "stategraph_text",
  threadId,
}: Props) {
  const thread = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
    client,
    threadId,
  });

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Hello")],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
