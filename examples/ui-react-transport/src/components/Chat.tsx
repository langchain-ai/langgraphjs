import { useMemo } from "react";

import { useStreamContext } from "@langchain/react";

import type { GraphType } from "../app";

export function Chat() {
  const stream = useStreamContext<GraphType>();
  const visibleMessages = useMemo(
    () => stream.messages.filter((message) => message != null),
    [stream.messages]
  );

  return (
    <section aria-label="Chat messages" className="chat-card">
      {visibleMessages.length === 0 ? (
        <div className="empty-state">Ask the agent about LangGraph streaming.</div>
      ) : null}

      {visibleMessages.map((message, index) => (
        <div
          className={`message ${message.type === "human" ? "user" : ""}`}
          key={message.id ?? index}
        >
          <span>{message.type === "human" ? "You" : "Assistant"}</span>
          <p>{message.text}</p>
        </div>
      ))}

      {visibleMessages.length === 0 && !stream.isLoading && stream.error ? (
        <div className="error">
          Could not reach the custom stream backend. Check that{" "}
          <code>pnpm dev</code> is running, then try again.
        </div>
      ) : null}
    </section>
  );
}
