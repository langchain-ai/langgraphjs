import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/**
 * Mounts `useStream` with a controlled `threadId` and
 * exposes buttons to change that id (or reset to `null`). Used to
 * verify that `hydrate()` rebinds the underlying thread and clears
 * the rendered snapshot.
 */
export function SwitchThreadStream({
  apiUrl,
  assistantId = "stategraph_text",
}: Props) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId: setThreadId,
  });

  return (
    <div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <div data-testid="thread-id">{thread.threadId ?? "none"}</div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-loading">
        {thread.isThreadLoading ? "Hydrating..." : "Ready"}
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
      <button
        data-testid="switch-thread"
        onClick={() => setThreadId(crypto.randomUUID())}
      >
        Switch Thread
      </button>
      <button
        data-testid="switch-thread-null"
        onClick={() => setThreadId(null)}
      >
        Clear Thread
      </button>
    </div>
  );
}
