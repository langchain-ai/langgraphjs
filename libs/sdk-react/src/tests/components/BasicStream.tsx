import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  submitInput?: Record<string, unknown>;
  submitOptions?: Record<string, unknown>;
  onCheckpointEvent?: (...args: unknown[]) => void;
  onTaskEvent?: (...args: unknown[]) => void;
  onUpdateEvent?: (...args: unknown[]) => void;
  onCustomEvent?: (...args: unknown[]) => void;
  fetchStateHistory?: boolean | { limit: number };
}

export function BasicStream({
  apiUrl,
  assistantId = "agent",
  submitInput = { messages: [{ content: "Hello", type: "human" }] },
  submitOptions,
  onCheckpointEvent,
  onTaskEvent,
  onUpdateEvent,
  onCustomEvent,
  fetchStateHistory,
}: Props) {
  const thread = useStream<{ messages: Message[] }>({
    assistantId,
    apiUrl,
    onCheckpointEvent,
    onTaskEvent,
    onUpdateEvent,
    onCustomEvent,
    fetchStateHistory,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      {thread.error ? (
        <div data-testid="error">{String(thread.error)}</div>
      ) : null}
      <button
        data-testid="submit"
        onClick={() => void thread.submit(submitInput, submitOptions)}
      >
        Send
      </button>
      <button data-testid="stop" onClick={() => void thread.stop()}>
        Stop
      </button>
    </div>
  );
}
