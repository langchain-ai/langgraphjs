import { useRef, useEffect } from "react";
import { 
  Check,
  Loader2
} from "lucide-react";

import type { ResearchConfig } from "../types";

/**
 * Research card component showing streamed content
 */
export function ResearchCard({
  config,
  content,
  isLoading,
  isSelected,
  onSelect,
  disabled,
}: {
  config: ResearchConfig;
  content: string;
  isLoading: boolean;
  isSelected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll as content streams in
  useEffect(() => {
    if (scrollRef.current && isLoading) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, isLoading]);

  return (
    <div
      className={`
          relative flex flex-col h-full rounded-2xl border-2 transition-all duration-300
          ${
            isSelected
              ? `${
                  config.borderColor
                } ring-2 ring-offset-2 ring-offset-black ${config.borderColor.replace(
                  "border",
                  "ring"
                )}`
              : "border-neutral-800 hover:border-neutral-700"
          }
          ${config.bgColor}
        `}
    >
      {/* Card Header */}
      <div
        className={`
          flex items-center gap-3 px-4 py-3 border-b border-neutral-800/50
          bg-gradient-to-r ${config.gradient} rounded-t-xl
        `}
      >
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center
            ${config.iconBg} ${config.accentColor}
          `}
        >
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold ${config.accentColor}`}>
            {config.name}
          </h3>
          <p className="text-xs text-neutral-500 truncate">
            {config.description}
          </p>
        </div>
        {isLoading && (
          <Loader2 className={`w-5 h-5 animate-spin ${config.accentColor}`} />
        )}
      </div>

      {/* Content Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
        {content ? (
          <div className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
            {content}
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-neutral-500 animate-pulse">
            <div className="w-2 h-2 rounded-full bg-current" />
            <div className="w-2 h-2 rounded-full bg-current animation-delay-150" />
            <div className="w-2 h-2 rounded-full bg-current animation-delay-300" />
            <span className="text-sm ml-2">Researching...</span>
          </div>
        ) : (
          <p className="text-neutral-600 text-sm italic">
            Waiting for research to begin...
          </p>
        )}
      </div>

      {/* Select Button */}
      {content && !isLoading && (
        <div className="px-4 py-3 border-t border-neutral-800/50">
          <button
            onClick={onSelect}
            disabled={disabled || isSelected}
            className={`
                w-full py-2.5 px-4 rounded-xl font-medium text-sm
                flex items-center justify-center gap-2 transition-all
                ${
                  isSelected
                    ? `${config.bgColor} ${config.accentColor} border ${config.borderColor}`
                    : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white"
                }
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
          >
            {isSelected ? (
              <>
                <Check className="w-4 h-4" />
                Selected
              </>
            ) : (
              "Select This Research"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
