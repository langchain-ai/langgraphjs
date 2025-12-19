import type { Message, AIMessage, DefaultToolCall } from "../types.messages.js";
import type {
  OpenAIReasoning,
  ReasoningContent,
  ReasoningMessage,
  ThinkingContentBlock,
  ReasoningSummaryItem,
} from "../types.reasoning.js";

/**
 * Extracts reasoning/thinking content from an AI message.
 * Supports both OpenAI reasoning (additional_kwargs.reasoning.summary)
 * and Anthropic extended thinking (contentBlocks with type "thinking").
 *
 * @param message - The AI message to extract reasoning from.
 * @param isStreaming - Whether the message is still being streamed.
 * @returns ReasoningContent if reasoning is found, undefined otherwise.
 *
 * @example
 * ```ts
 * const reasoning = getReasoningFromMessage(aiMessage, stream.isLoading);
 * if (reasoning) {
 *   console.log("Model is thinking:", reasoning.content);
 * }
 * ```
 */
export function getReasoningFromMessage(
  message: AIMessage,
  isStreaming = false
): ReasoningContent | undefined {
  // Type for accessing additional properties
  type MessageWithExtras = AIMessage & {
    additional_kwargs?: { reasoning?: OpenAIReasoning };
    contentBlocks?: Array<{ type: string; thinking?: string; text?: string }>;
  };

  const msg = message as MessageWithExtras;

  // Check for OpenAI reasoning in additional_kwargs
  if (msg.additional_kwargs?.reasoning?.summary) {
    const { summary } = msg.additional_kwargs.reasoning;
    const content = summary
      .filter(
        (item): item is ReasoningSummaryItem =>
          item.type === "summary_text" && typeof item.text === "string"
      )
      .map((item) => item.text)
      .join("");

    if (content.trim()) {
      return {
        id:
          msg.additional_kwargs.reasoning.id ??
          `reasoning-${msg.id ?? "unknown"}`,
        content,
        source: "openai",
        isStreaming,
      };
    }
  }

  // Check for Anthropic thinking in contentBlocks
  if (msg.contentBlocks && Array.isArray(msg.contentBlocks)) {
    const thinkingBlocks = msg.contentBlocks.filter(
      (block): block is ThinkingContentBlock =>
        block.type === "thinking" && typeof block.thinking === "string"
    );

    if (thinkingBlocks.length > 0) {
      const content = thinkingBlocks.map((b) => b.thinking).join("\n");
      return {
        id: `thinking-${msg.id ?? "unknown"}`,
        content,
        source: "anthropic",
        isStreaming,
      };
    }
  }

  // Check for thinking in message.content array
  if (Array.isArray(msg.content)) {
    const thinkingContent: string[] = [];
    for (const block of msg.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: string }).type === "thinking" &&
        "thinking" in block &&
        typeof (block as { thinking: unknown }).thinking === "string"
      ) {
        thinkingContent.push((block as { thinking: string }).thinking);
      }
    }

    if (thinkingContent.length > 0) {
      return {
        id: `content-thinking-${msg.id ?? "unknown"}`,
        content: thinkingContent.join("\n"),
        source: "content",
        isStreaming,
      };
    }
  }

  return undefined;
}

/**
 * Extracts all reasoning/thinking content from a list of messages.
 *
 * @param messages - The list of messages to extract reasoning from.
 * @param isLastMessageStreaming - Whether the last message is still being streamed.
 * @returns An array of ReasoningContent objects.
 *
 * @example
 * ```ts
 * const allReasoning = getReasoningFromMessages(messages, stream.isLoading);
 * for (const reasoning of allReasoning) {
 *   console.log(`Reasoning from ${reasoning.source}:`, reasoning.content);
 * }
 * ```
 */
export function getReasoningFromMessages<ToolCall = DefaultToolCall>(
  messages: Message<ToolCall>[],
  isLastMessageStreaming = false
): ReasoningContent[] {
  const results: ReasoningContent[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.type === "ai") {
      const isStreaming = isLastMessageStreaming && i === messages.length - 1;
      // Cast to AIMessage since we're only passing AI messages
      const reasoning = getReasoningFromMessage(
        msg as unknown as AIMessage,
        isStreaming
      );
      if (reasoning) {
        results.push(reasoning);
      }
    }
  }

  return results;
}

/**
 * Extracts a ReasoningMessage from an AI message if it contains reasoning content.
 *
 * @param message - The AI message to extract reasoning from.
 * @returns ReasoningMessage if reasoning is found, undefined otherwise.
 */
export function getReasoningMessage(
  message: AIMessage
): ReasoningMessage | undefined {
  const reasoning = getReasoningFromMessage(message, false);
  if (!reasoning) return undefined;

  return {
    type: "reasoning",
    content: reasoning.content,
    id: reasoning.id,
    aiMessage: message,
    source: reasoning.source,
  };
}
