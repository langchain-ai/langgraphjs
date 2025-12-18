import type { Message, AIMessage, DefaultToolCall, UIMessage } from "../types.messages.js";
import { getReasoningMessage } from "../utils/reasoning.js"

/**
 * Checks if an AI message has non-reasoning text content.
 * Returns true if the message has string content or text blocks in array content.
 */
function hasNonReasoningContent(message: AIMessage): boolean {
  const { content } = message;

  // String content
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  // Array content - check for text blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && "type" in block) {
        const typed = block as { type: string; text?: string };
        // Text block with actual content
        if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim().length > 0) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Builds the uiMessages list with reasoning messages included.
 * Reasoning messages are inserted before their corresponding AI messages.
 * AI messages that only contain reasoning (no text content) are omitted.
 *
 * @param messages - The list of messages to process.
 * @returns An array of UIMessage including ReasoningMessage entries.
 *
 * @example
 * ```tsx
 * const uiMessages = getUIMessagesWithReasoning(messages);
 * {uiMessages.map((message) => {
 *   if (message.type === "reasoning") {
 *     return <ReasoningBubble key={message.id} content={message.content} />;
 *   }
 *   if (message.type === "ai") {
 *     return <AIBubble key={message.id} message={message} />;
 *   }
 *   return <HumanBubble key={message.id} message={message} />;
 * })}
 * ```
 */
export function getUIMessagesWithReasoning<ToolCall = DefaultToolCall>(
  messages: Message<ToolCall>[]
): UIMessage<ToolCall>[] {
  const result: UIMessage<ToolCall>[] = [];

  for (const msg of messages) {
    /**
     * Skip tool messages
     */
    if (msg.type === "tool") continue;

    /**
     * For AI messages, check for reasoning content
     */
    if (msg.type === "ai") {
      const aiMessage = msg as unknown as AIMessage;
      const reasoningMessage = getReasoningMessage(aiMessage);

      if (reasoningMessage) {
        result.push(reasoningMessage);
      }

      // Skip AI message if it only contains reasoning (no text content)
      if (reasoningMessage && !hasNonReasoningContent(aiMessage)) {
        continue;
      }
    }

    // Add the message itself
    result.push(msg as UIMessage<ToolCall>);
  }

  return result;
}
