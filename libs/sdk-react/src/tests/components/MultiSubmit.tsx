import { useEffect, useRef } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import type { StreamSubmitOptions } from "@langchain/langgraph-sdk/stream";

interface StreamState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  onRender?: (messages: string[]) => void;
  submitOptions?: StreamSubmitOptions<StreamState>;
}

export function MultiSubmit({
  apiUrl,
  assistantId = "stategraph_text",
  onRender,
  submitOptions,
}: Props) {
  const { messages, isLoading, submit } = useStream<StreamState>({
    assistantId,
    apiUrl,
  });

  const onRenderRef = useRef(onRender);
  onRenderRef.current = onRender;

  useEffect(() => {
    const rawMessages = messages.map(
      (msg) =>
        `${msg.getType()}: ${
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content)
        }`,
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
          const content = `${msg.getType()}: ${
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)
          }`;
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
          void submit(
            { messages: [new HumanMessage("Hello (1)")] },
            submitOptions,
          )
        }
      >
        Send First
      </button>
      <button
        data-testid="submit-second"
        onClick={() =>
          void submit(
            { messages: [new HumanMessage("Hello (2)")] },
            submitOptions,
          )
        }
      >
        Send Second
      </button>
    </div>
  );
}
