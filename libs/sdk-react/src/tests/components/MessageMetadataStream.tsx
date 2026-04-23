import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useMessageMetadata } from "../../index.js";
import type { UseStreamExperimentalReturn } from "../../index.js";

type StreamState = { messages: BaseMessage[] };

function MessageRow({
  stream,
  index,
  message,
}: {
  stream: UseStreamExperimentalReturn<StreamState>;
  index: number;
  message: BaseMessage;
}) {
  const metadata = useMessageMetadata(stream, message.id);
  return (
    <div data-testid={`message-${index}`}>
      <span data-testid={`message-${index}-content`}>
        {typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)}
      </span>
      <span data-testid={`message-${index}-parent`}>
        {metadata?.parentCheckpointId ?? "none"}
      </span>
    </div>
  );
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

export function MessageMetadataStream({
  apiUrl,
  assistantId = "stategraph_text",
}: Props) {
  const stream = useStream<StreamState>({ assistantId, apiUrl });

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
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
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({ messages: [new HumanMessage("Hello")] })
        }
      >
        Send
      </button>
    </div>
  );
}
