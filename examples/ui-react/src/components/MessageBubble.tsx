import { Brain, Sparkles } from "lucide-react";
import type { UIMessage, ReasoningMessage } from "@langchain/langgraph-sdk";

/**
 * MessageBubble component that renders human and AI text messages.
 * Tool calls are handled separately by ToolCallCard.
 */
export function MessageBubble({ message }: { message: UIMessage }) {
  const isHuman = message.type === "human";
  const isSystem = message.type === "system";
  const isReasoning = message.type === "reasoning";

  // Extract text content from message
  const getContent = () => {
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
  };

  const content = getContent();

  // Don't render if there's no content
  if (!content) return null;

  if (isReasoning) {
    return <ReasoningBubble message={message} isStreaming={false} />;
  }

  return (
    <div className="animate-fade-in">
      {!isHuman && (
        <div className="text-xs font-medium text-neutral-500 mb-2">
          {isSystem ? "System" : "Assistant"}
        </div>
      )}

      <div
        className={`${
          isHuman
            ? "bg-brand-dark text-brand-light rounded-2xl px-4 py-2.5 ml-auto max-w-[85%] md:max-w-[70%] w-fit"
            : isSystem
            ? "bg-amber-500/10 border border-amber-500/20 text-amber-200 rounded-lg px-4 py-3"
            : "text-neutral-100"
        }`}
      >
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
function ReasoningBubble({
  message,
  isStreaming,
}: {
  message: ReasoningMessage;
  isStreaming: boolean;
}) {
  return (
    <div className="animate-fade-in">
      {/* Label */}
      <div className="text-xs font-medium text-amber-400/80 mb-2 flex items-center gap-1.5">
        <Brain className="w-3 h-3" />
        <span>Reasoning</span>
        {isStreaming && (
          <span className="flex items-center gap-1 text-amber-400/60">
            <Sparkles className="w-3 h-3 animate-pulse" />
          </span>
        )}
      </div>

      {/* Bubble */}
      <div className="bg-gradient-to-br from-amber-950/50 to-orange-950/40 border border-amber-500/20 rounded-2xl px-4 py-3 max-w-[95%]">
        <div className="text-sm text-amber-100/90 whitespace-pre-wrap leading-relaxed">
          {message.content}
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-amber-400/70 animate-pulse ml-0.5 rounded-sm" />
          )}
        </div>
      </div>
    </div>
  );
}
