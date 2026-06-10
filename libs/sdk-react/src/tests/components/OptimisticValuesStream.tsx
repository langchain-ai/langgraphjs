import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
  status?: string;
  [key: string]: unknown;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  optimistic?: boolean;
  submitStatus?: string;
}

export function OptimisticValuesStream({
  apiUrl,
  assistantId = "stateful_values_graph",
  optimistic,
  submitStatus = "draft",
}: Props) {
  const stream = useStream<StreamState>({ assistantId, apiUrl, optimistic });
  const status = (stream.values as StreamState).status;

  return (
    <div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <div data-testid="messages">
        {stream.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="status">{status ?? "none"}</div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      {stream.error ? (
        <div data-testid="error">{String(stream.error)}</div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({
            messages: [new HumanMessage("Hello")],
            status: submitStatus,
          })
        }
      >
        Send
      </button>
    </div>
  );
}
