import { Brain } from "lucide-react";
import type { Message, AIMessage } from "@langchain/langgraph-sdk";

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

  return (<>
    {/* Render reasoning bubble if it exists */}
    {reasoning && (
      <ReasoningBubble content={reasoning} />
    )}
    {content && (
      <div className="animate-fade-in">
        <div className="text-xs font-medium text-neutral-500 mb-2">Assistant</div>
        <div className={BUBBLE_STYLES.ai}>
          <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
            {content}
          </div>
        </div>
      </div>
    )}
  </>);
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
 * Supports both OpenAI reasoning (additional_kwargs.reasoning.summary)
 * and Anthropic extended thinking (contentBlocks with type "thinking").
 *
 * @param message - The AI message to extract reasoning from.
 * @returns a string of the reasoning/thinking content if found, undefined otherwise.
 *
 * @example
 * ```ts
 * const reasoning = getReasoningFromMessage(aiMessage, stream.isLoading);
 * if (reasoning) {
 *   console.log("Model is thinking:", reasoning.content);
 * }
 * ```
 */
export function getReasoningFromMessage(message: Message): string | undefined {
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
      return content;
    }
  }

  // Check for Anthropic thinking in contentBlocks
  if (msg.contentBlocks && Array.isArray(msg.contentBlocks)) {
    const thinkingBlocks = msg.contentBlocks.filter(
      (block): block is ThinkingContentBlock =>
        block.type === "thinking" && typeof block.thinking === "string"
    );

    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map((b) => b.thinking).join("\n");
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
      return thinkingContent.join("\n");
    }
  }

  return undefined;
}

/**
 * Anthropic thinking content block structure.
 * Used when streaming extended thinking from Claude models.
 */
export type ThinkingContentBlock = {
  type: "thinking";
  thinking: string;
};

/**
 * OpenAI reasoning summary item structure.
 * Used when streaming reasoning tokens from OpenAI models.
 */
export type ReasoningSummaryItem = {
  type: "summary_text";
  text: string;
  index?: number;
};

/**
 * OpenAI reasoning structure in additional_kwargs.
 */
export type OpenAIReasoning = {
  id?: string;
  type: "reasoning";
  summary?: ReasoningSummaryItem[];
};