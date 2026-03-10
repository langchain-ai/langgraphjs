import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

export function QueueStream({ apiUrl }: Props) {
  const stream = useStream<{ messages: Message[] }>({
    assistantId: "agent",
    apiUrl,
    fetchStateHistory: false,
  });

  return (
    <div>
      <div data-testid="messages">
        {stream.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <div data-testid="queue-size">{stream.queue.size}</div>
      <div data-testid="queue-entries">
        {stream.queue.entries
          .map((e) => {
            const msgs = e.values?.messages;
            return msgs?.[0]?.content ?? "?";
          })
          .join(",")}
      </div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({
            messages: [{ content: "Hi", type: "human" }],
          })
        }
      >
        Submit
      </button>
      <button
        data-testid="submit-three"
        onClick={() => {
          void stream.submit({
            messages: [{ content: "Msg1", type: "human" }],
          });
          void stream.submit({
            messages: [{ content: "Msg2", type: "human" }],
          });
          void stream.submit({
            messages: [{ content: "Msg3", type: "human" }],
          });
        }}
      >
        Submit Three
      </button>
      <button
        data-testid="cancel-first"
        onClick={() => {
          const first = stream.queue.entries[0];
          if (first) void stream.queue.cancel(first.id);
        }}
      >
        Cancel First
      </button>
      <button
        data-testid="clear-queue"
        onClick={() => void stream.queue.clear()}
      >
        Clear Queue
      </button>
      <button
        data-testid="switch-thread"
        onClick={() => stream.switchThread(crypto.randomUUID())}
      >
        Switch Thread
      </button>
    </div>
  );
}
