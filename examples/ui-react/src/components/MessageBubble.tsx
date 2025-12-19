import { Brain } from "lucide-react";
import type { UIMessage } from "@langchain/langgraph-sdk";

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
function getTextContent(message: UIMessage): string {
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
export function MessageBubble({ message }: { message: UIMessage }) {
  const content = getTextContent(message);

  // Don't render if there's no content
  if (!content) return null;

  if (message.type === "reasoning") {
    return <ReasoningBubble content={content} />;
  }

  if (message.type === "human") {
    return <HumanBubble content={content} />;
  }

  if (message.type === "system") {
    return <SystemBubble content={content} />;
  }

  return <AssistantBubble content={content} />;
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
 * Assistant message bubble - minimal styling with label
 */
function AssistantBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in">
      <div className="text-xs font-medium text-neutral-500 mb-2">Assistant</div>
      <div className={BUBBLE_STYLES.ai}>
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {content}
        </div>
      </div>
    </div>
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
