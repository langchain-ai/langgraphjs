import { Brain } from "lucide-react";
import type { ContentBlock } from "langchain";
import type { Message } from "@langchain/langgraph-sdk";

// Styles for each message type - kept separate for readability
const BUBBLE_STYLES = {
  human:
    "bg-brand-dark text-brand-light rounded-2xl px-4 py-2.5 ml-auto max-w-[85%] md:max-w-[70%] w-fit",
  system:
    "bg-amber-500/10 border border-amber-500/20 text-amber-200 rounded-lg px-4 py-3",
  ai: "text-neutral-100",
} as const;

/**
 * Extract text content from a message
 */
function getTextContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/**
 * MessageBubble component that renders human and AI text messages.
 * Tool calls are handled separately by ToolCallCard.
 */
export function MessageBubble({ message }: { message: Message }) {
  const content = getTextContent(message);

  /**
   * Don't render tool messages as render them separately
   */
  if (message.type === "tool") {
    return null;
  }

  if (message.type === "human") {
    return <HumanBubble content={content} />;
  }

  if (message.type === "system") {
    return <SystemBubble content={content} />;
  }

  return <AssistantBubble message={message} />;
}

/**
 * Human message bubble - right-aligned with brand colors
 */
function HumanBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in">
      <div className={BUBBLE_STYLES.human}>
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * System message bubble - warning-styled with amber colors
 */
function SystemBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in">
      <div className="text-xs font-medium text-neutral-500 mb-2">System</div>
      <div className={BUBBLE_STYLES.system}>
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * Assistant message bubble with reasoning bubble if it exists
 */
function AssistantBubble({ message }: { message: Message }) {
  const content = getTextContent(message);
  const reasoning = getReasoningFromMessage(message);

  return (
    <>
      {/* Render reasoning bubble if it exists */}
      {reasoning && <ReasoningBubble content={reasoning} />}
      {content && (
        <div className="animate-fade-in">
          <div className="text-xs font-medium text-neutral-500 mb-2">
            Assistant
          </div>
          <div className={BUBBLE_STYLES.ai}>
            <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
              {content}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Reasoning bubble component - displays thinking tokens in a separate bubble
 */
function ReasoningBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in">
      {/* Label */}
      <div className="text-xs font-medium text-amber-400/80 mb-2 flex items-center gap-1.5">
        <Brain className="w-3 h-3" />
        <span>Reasoning</span>
      </div>

      {/* Bubble */}
      <div className="bg-linear-to-br from-amber-950/50 to-orange-950/40 border border-amber-500/20 rounded-2xl px-4 py-3 max-w-[95%]">
        <div className="text-sm text-amber-100/90 whitespace-pre-wrap leading-relaxed">
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * Extracts reasoning/thinking content from an AI message.
 *
 * Supports the standardized content block format where both OpenAI reasoning
 * and Anthropic extended thinking are normalized to `type: "reasoning"` blocks
 * with a `reasoning` field in message.content.
 *
 * @param message - The AI message to extract reasoning from.
 * @returns a string of the reasoning/thinking content if found, undefined otherwise.
 *
 * @example
 * ```ts
 * const reasoning = getReasoningFromMessage(aiMessage);
 * if (reasoning) {
 *   console.log("Model is thinking:", reasoning);
 * }
 * ```
 */
export function getReasoningFromMessage(message: Message): string | undefined {
  if (Array.isArray(message.content)) {
    console.log(message);
    const reasoningContent = (message.content as ContentBlock[])
      .filter(
        (block): block is ContentBlock.Reasoning =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "reasoning" &&
          "reasoning" in block &&
          typeof block.reasoning === "string"
      )
      .map((block) => block.reasoning)
      .join("");

    if (reasoningContent.trim()) {
      return reasoningContent;
    }
  }

  return undefined;
}
