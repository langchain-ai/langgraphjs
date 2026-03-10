import { useRef } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

const PRESETS = ["Msg1", "Msg2", "Msg3"];

export function QueueOnCreated({ apiUrl }: Props) {
  const pendingRef = useRef<string[]>([]);
  const submitRef = useRef<ReturnType<typeof useStream>["submit"]>(null!);

  const stream = useStream<{ messages: Message[] }>({
    assistantId: "agent",
    apiUrl,
    fetchStateHistory: false,
    onCreated: () => {
      if (pendingRef.current.length > 0) {
        const followUps = pendingRef.current;
        pendingRef.current = [];
        for (const text of followUps) {
          void submitRef.current?.({
            messages: [{ content: text, type: "human" }],
          });
        }
      }
    },
  });

  submitRef.current = stream.submit;

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
      <button
        data-testid="submit-presets"
        onClick={() => {
          pendingRef.current = PRESETS.slice(1);
          void stream.submit({
            messages: [{ content: PRESETS[0], type: "human" }],
          });
        }}
      >
        Submit Presets
      </button>
    </div>
  );
}
