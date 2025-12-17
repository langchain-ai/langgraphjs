import type { Message } from "@langchain/langgraph-sdk";

/**
 * MessageBubble component that renders human and AI text messages.
 * Tool calls are handled separately by ToolCallCard.
 */
export function MessageBubble({ message }: { message: Message }) {
  const isHuman = message.type === "human";
  const isSystem = message.type === "system";

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
