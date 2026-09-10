import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream, useSubmissionQueue } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/** Tests ordinary submits and explicit rejection on a protocol-only server. */
export function QueueStream({
  apiUrl,
  assistantId = "slow_graph",
}: Props) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const stream = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId: setThreadId,
  });
  const queue = useSubmissionQueue(stream);

  const submitEnqueue = (content: string) =>
    void stream.submit(
      { messages: [new HumanMessage(content)] },
      { multitaskStrategy: "enqueue" },
    ).catch(() => undefined);

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <div data-testid="messages">
        {stream.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>

      <div data-testid="queue-error">{String(stream.error ?? "")}</div>
      <div data-testid="queue-size">{queue.size}</div>
      <div data-testid="queue-entries">
        {queue.entries
          .map((entry) => {
            const messages = entry.values?.messages;
            const first = Array.isArray(messages) ? messages[0] : undefined;
            return first ? formatMessage(first) : "?";
          })
          .join(",")}
      </div>

      <button data-testid="submit-first" onClick={() => void stream.submit({ messages: [new HumanMessage("Msg1")] })}>
        Submit First
      </button>
      <button
        data-testid="submit-three"
        onClick={() => {
          submitEnqueue("Msg2");
          submitEnqueue("Msg3");
          submitEnqueue("Msg4");
        }}
      >
        Submit Three
      </button>
      <button
        data-testid="cancel-first"
        onClick={() => {
          const first = queue.entries[0];
          if (first) void queue.cancel(first.id);
        }}
      >
        Cancel First
      </button>
      <button
        data-testid="clear-queue"
        onClick={() => void queue.clear()}
      >
        Clear Queue
      </button>
      <button
        data-testid="switch-thread"
        onClick={() => {
          const next = crypto.randomUUID();
          setThreadId(next);
        }}
      >
        Switch Thread
      </button>
    </div>
  );
}
