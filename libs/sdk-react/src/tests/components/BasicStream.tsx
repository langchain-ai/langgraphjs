import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StreamSubmitOptions } from "@langchain/langgraph-sdk/stream";
import type { Client } from "@langchain/langgraph-sdk";

import { useStream } from "../../index.js";
import { formatMessage } from "./format.js";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

interface Props {
  apiUrl?: string;
  client?: Client;
  assistantId?: string;
  threadId?: string;
  submitInput?: StreamState;
  submitOptions?: StreamSubmitOptions<StreamState>;
  transport?: "sse" | "websocket";
  onThreadId?: (threadId: string) => void;
  onCreated?: (meta: { run_id: string; thread_id: string }) => void;
}

export function BasicStream({
  apiUrl,
  client,
  assistantId = "stategraph_text",
  threadId,
  submitInput,
  submitOptions,
  transport,
  onThreadId,
  onCreated,
}: Props) {
  const thread = useStream<StreamState>({
    assistantId,
    apiUrl,
    client,
    threadId,
    transport,
    onThreadId,
    onCreated,
  });

  return (
    <div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {formatMessage(msg)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-id">{thread.threadId ?? "none"}</div>
      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit(
            submitInput ?? {
              messages: [new HumanMessage("Hello")],
            },
            submitOptions,
          )
        }
      >
        Send
      </button>
      <button data-testid="stop" onClick={() => void thread.stop()}>
        Stop
      </button>
    </div>
  );
}
