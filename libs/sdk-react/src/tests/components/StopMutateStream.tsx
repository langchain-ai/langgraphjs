import { useState } from "react";
import type { Message } from "@langchain/langgraph-sdk";

import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  onStopMutate: (prev: Record<string, unknown>) => Record<string, unknown>;
}

export function StopMutateStream({
  apiUrl,
  assistantId = "agent",
  onStopMutate,
}: Props) {
  const [stopped, setStopped] = useState(false);

  const { messages, isLoading, submit, stop } = useStream<{
    messages: Message[];
  }>({
    assistantId,
    apiUrl,
    onStop: ({ mutate }) => {
      setStopped(true);
      mutate(onStopMutate);
    },
  });

  return (
    <div>
      <div data-testid="stopped-status">
        {stopped ? "Stopped" : "Not stopped"}
      </div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
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
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
      <button data-testid="stop" onClick={() => void stop()}>
        Stop
      </button>
    </div>
  );
}
