import { useEffect, useRef } from "react";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  onRender?: (messages: string[]) => void;
}

export function MultiSubmit({
  apiUrl,
  assistantId = "agent",
  onRender,
}: Props) {
  const { messages, isLoading, submit } = useStream({
    assistantId,
    apiUrl,
  });

  const onRenderRef = useRef(onRender);
  onRenderRef.current = onRender;

  useEffect(() => {
    const rawMessages = messages.map(
      (msg) =>
        `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`
    );
    onRenderRef.current?.(rawMessages);
  }, [messages]);

  return (
    <div>
      <div data-testid="loading">
        {isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="messages">
        {messages.map((msg, i) => {
          const content = `${msg.type}: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`;
          return (
            <div key={msg.id ?? i} data-testid={`message-${i}`}>
              <span>{content}</span>
            </div>
          );
        })}
      </div>
      <button
        data-testid="submit-first"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello (1)", type: "human" }],
          })
        }
      >
        Send First
      </button>
      <button
        data-testid="submit-second"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello (2)", type: "human" }],
          })
        }
      >
        Send Second
      </button>
    </div>
  );
}
