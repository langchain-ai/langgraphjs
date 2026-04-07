import type { Message } from "@langchain/langgraph-sdk";

import {
  getMessageLabel,
  getMetadataBadge,
  getReasoningContent,
  getTextContent,
  getToolCallSummary,
  safeStringify,
} from "../utils";

interface MessageFeedProps {
  messages: Message[];
  getMessageMetadata?: (message: Message) => unknown;
}

export function MessageFeed({
  messages,
  getMessageMetadata,
}: MessageFeedProps) {
  if (messages.length === 0) {
    return (
      <div className="empty-feed">
        <h3>No messages yet</h3>
        <p>
          Start a run to inspect how this agent behaves over the new protocol.
        </p>
      </div>
    );
  }

  return (
    <div className="message-feed">
      {messages.map((message, index) => {
        const text = getTextContent(message);
        const reasoning = getReasoningContent(message);
        const toolSummary = getToolCallSummary(message);
        const metadata = getMessageMetadata?.(message);
        const badge = getMetadataBadge(metadata);
        const content =
          text || reasoning || toolSummary || safeStringify(message.content);

        return (
          <article
            key={message.id ?? `${message.type}-${index}`}
            className="message-card"
          >
            <div className="message-card-header">
              <span className="message-role">
                {getMessageLabel(message.type)}
              </span>
              {badge ? <span className="message-badge">{badge}</span> : null}
            </div>
            {reasoning ? (
              <div className="reasoning-block">
                <div className="reasoning-label">Reasoning</div>
                <div>{reasoning}</div>
              </div>
            ) : null}
            <div className="message-content">{content}</div>
          </article>
        );
      })}
    </div>
  );
}
