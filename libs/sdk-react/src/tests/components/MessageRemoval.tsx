import { useEffect, useRef } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  assistantId?: string;
  onRender?: (messages: string[]) => void;
}

export function MessageRemoval({
  apiUrl,
  assistantId = "removeMessageAgent",
  onRender,
}: Props) {
  const { messages, isLoading, submit } = useStream({
    assistantId,
    apiUrl,
    throttle: false,
  });

  const onRenderRef = useRef(onRender);
  onRenderRef.current = onRender;

  useEffect(() => {
    const rawMessages = messages.map(
      (msg: Message) =>
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
        data-testid="submit"
        onClick={() =>
          void submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
