import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useMessageMetadata } from "../../index.js";
import type { UseStreamReturn } from "../../index.js";
import { formatMessage } from "./format.js";

type StreamState = { messages: BaseMessage[] };

function MessageRow({
  stream,
  index,
  message,
}: {
  stream: UseStreamReturn<StreamState>;
  index: number;
  message: BaseMessage;
}) {
  const metadata = useMessageMetadata(stream, message.id);
  return (
    <div data-testid={`message-${index}`}>
      <span data-testid={`message-${index}-content`}>
        {formatMessage(message)}
      </span>
      <span data-testid={`message-${index}-status`}>
        {metadata?.optimisticStatus ?? "none"}
      </span>
    </div>
  );
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  optimistic?: boolean;
  submitText?: string;
}

export function OptimisticStream({
  apiUrl,
  assistantId = "stategraph_text",
  optimistic,
  submitText = "Hello",
}: Props) {
  const stream = useStream<StreamState>({ assistantId, apiUrl, optimistic });

  return (
    <div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <div data-testid="messages">
        {stream.messages.map((msg, i) => (
          <MessageRow
            key={msg.id ?? i}
            stream={stream}
            index={i}
            message={msg}
          />
        ))}
      </div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      {stream.error ? (
        <div data-testid="error">{String(stream.error)}</div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({ messages: [new HumanMessage(submitText)] })
        }
      >
        Send
      </button>
    </div>
  );
}
