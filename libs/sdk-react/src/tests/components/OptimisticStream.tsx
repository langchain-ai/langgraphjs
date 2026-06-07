import { useRef } from "react";
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
  const status = metadata?.optimisticStatus ?? "none";
  // Latch: the server echoes the input message id almost immediately, so
  // the live `pending` status is a sub-frame transient that a polling
  // assertion can race under suite load. Recording that we *ever* rendered
  // `pending` is sticky and race-free.
  const everPending = useRef(false);
  if (status === "pending") everPending.current = true;
  return (
    <div data-testid={`message-${index}`}>
      <span data-testid={`message-${index}-content`}>
        {formatMessage(message)}
      </span>
      <span data-testid={`message-${index}-status`}>{status}</span>
      <span data-testid={`message-${index}-ever-pending`}>
        {everPending.current ? "true" : "false"}
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
