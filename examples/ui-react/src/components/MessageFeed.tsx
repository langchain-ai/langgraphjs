import type { BaseMessage } from "langchain";
import type { ToolCallWithResult } from "@langchain/react";
import { memo, useState } from "react";
import { Streamdown } from "streamdown";

import {
  getToolCallId,
  getToolCallsWithResults,
  isToolMessage,
  type MessageFeedToolCall,
  ToolCallCard,
} from "./cards";
import {
  getMessageLabel,
  getMetadataBadge,
  getReasoningContent,
  safeStringify,
} from "../utils";

interface MessageFeedProps {
  messages: BaseMessage[];
  getMessageMetadata?: (message: BaseMessage) => unknown;
  isStreaming?: boolean;
}

// Whether `message.content` is effectively empty and NOT worth rendering
// as a JSON dump. Empty strings and empty arrays both collapse to an
// ugly `""` / `[]` preview during streaming turns that only emit tool
// calls (the tool card carries the real payload).
const isRenderableEmpty = (value: unknown): boolean => {
  if (value == null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const MESSAGE_CONTENT_TOKEN_LIMIT = 120;
const MESSAGE_CONTENT_CHAR_LIMIT = 800;

const getTokenLimitedPreview = (
  value: string,
  maxTokens = MESSAGE_CONTENT_TOKEN_LIMIT,
  maxChars = MESSAGE_CONTENT_CHAR_LIMIT
) => {
  const normalized = value.trim();
  const parts = normalized.split(/(\s+)/);
  let tokenCount = 0;
  let endIndex = parts.length;

  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.trim().length === 0) {
      continue;
    }

    tokenCount += 1;
    if (tokenCount > maxTokens) {
      endIndex = index;
      break;
    }
  }

  const tokenPreview = parts.slice(0, endIndex).join("").trimEnd();
  const isTokenTruncated = endIndex < parts.length;
  const isCharTruncated = normalized.length > maxChars;
  const charPreview = isCharTruncated
    ? `${normalized.slice(0, maxChars - 3).trimEnd()}...`
    : normalized;

  if (isTokenTruncated && isCharTruncated) {
    return tokenPreview.length <= charPreview.length
      ? {
        preview: `${tokenPreview}...`,
        isTruncated: true,
      }
      : {
        preview: charPreview,
        isTruncated: true,
      };
  }

  if (isTokenTruncated) {
    return {
      preview: `${tokenPreview}...`,
      isTruncated: true,
    };
  }

  return {
    preview: charPreview,
    isTruncated: isCharTruncated,
  };
};

interface ExpandableMessageContentProps {
  content: string;
  isAnimating?: boolean;
  preview: string;
}

function MessageContent({
  content,
  isAnimating = false,
}: {
  content: string;
  isAnimating?: boolean;
}) {
  return (
    <Streamdown
      animated={{ animation: "blurIn", duration: 180, stagger: 25 }}
      className="message-content"
      isAnimating={isAnimating}
    >
      {content}
    </Streamdown>
  );
}

// Toggle between a truncated preview and the full message body. Keeping
// these mutually exclusive avoids rendering the opening of the message
// twice (preview + full) when the user expands it.
function ExpandableMessageContent({
  content,
  isAnimating = false,
  preview,
}: ExpandableMessageContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="message-content-stack">
      <div className={isExpanded ? "message-content-expanded" : undefined}>
        <MessageContent
          content={isExpanded ? content : preview}
          isAnimating={!isExpanded && isAnimating}
        />
      </div>
      <button
        type="button"
        className="message-content-toggle"
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        {isExpanded ? "Show less" : "Show full message"}
      </button>
    </div>
  );
}

export const MessageFeed = memo(function MessageFeed({
  messages,
  getMessageMetadata,
  isStreaming = false,
}: MessageFeedProps) {
  const allToolCalls = getToolCallsWithResults(messages);
  const pairedToolResultIds = new Set(
    allToolCalls
      .map((toolCall) =>
        toolCall.result != null ? getToolCallId(toolCall.result) : undefined
      )
      .filter((toolCallId): toolCallId is string => typeof toolCallId === "string"),
  );
  const toolCallsByMessage = new Map<
    BaseMessage,
    ToolCallWithResult<MessageFeedToolCall>[]
  >();

  for (const toolCall of allToolCalls) {
    const existing =
      toolCallsByMessage.get(toolCall.aiMessage as BaseMessage) ?? [];
    existing.push(toolCall);
    toolCallsByMessage.set(
      toolCall.aiMessage as BaseMessage,
      existing as ToolCallWithResult<MessageFeedToolCall>[]
    );
  }

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
        const toolCallId = getToolCallId(message);
        if (
          isToolMessage(message) &&
          toolCallId != null &&
          pairedToolResultIds.has(toolCallId)
        ) {
          return null;
        }

        const text = message.text;
        const reasoning = getReasoningContent(message);
        const metadata = getMessageMetadata?.(message);
        const badge = getMetadataBadge(metadata);
        const toolCalls = toolCallsByMessage.get(message) ?? [];
        const isLatestStreamingMessage =
          isStreaming && index === messages.length - 1;
        // Prefer real text/reasoning; only fall back to a JSON dump of
        // `message.content` when there are no tool calls to render AND
        // the content is a non-empty non-string payload worth showing.
        // Dumping an empty string produces a literal `""` in the DOM,
        // which the user sees as "stuck" during pure-tool-call turns.
        const fallbackContent =
          toolCalls.length === 0 && !isRenderableEmpty(message.content)
            ? safeStringify(message.content)
            : "";
        const content = text || reasoning || fallbackContent;
        const contentPreview = getTokenLimitedPreview(content);
        const shouldRenderPreview =
          contentPreview.isTruncated && !isLatestStreamingMessage;

        // Suppress cards that have no renderable payload at all. AI turns
        // that finish with empty content AND no tool calls (e.g. a
        // sub-agent whose final message never streamed any blocks) would
        // otherwise render as a ghost card with just a role label.
        const hasContent = content.trim().length > 0;
        const hasToolCalls = toolCalls.length > 0;
        const hasReasoning = Boolean(reasoning);
        if (message.type !== "human" && !hasContent && !hasToolCalls && !hasReasoning) {
          return null;
        }

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
            {content.trim().length > 0 ? (
              shouldRenderPreview ? (
                <ExpandableMessageContent
                  content={content}
                  preview={contentPreview.preview}
                />
              ) : (
                <MessageContent
                  content={content}
                  isAnimating={isLatestStreamingMessage}
                />
              )
            ) : null}
            {toolCalls.length > 0 ? (
              <div className="tool-card-list">
                {toolCalls.map((toolCall) => (
                  <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}, areMessageFeedPropsEqual);

function areMessageFeedPropsEqual(
  previous: MessageFeedProps,
  next: MessageFeedProps
) {
  return (
    previous.messages === next.messages &&
    previous.getMessageMetadata === next.getMessageMetadata &&
    previous.isStreaming === next.isStreaming
  );
}
