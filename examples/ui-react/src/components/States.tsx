import { MessageCircle, type LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  suggestions?: string[];
  onSuggestionClick?: (suggestion: string) => void;
}

export function EmptyState({
  icon: Icon = MessageCircle,
  title = "How can I help you today?",
  description = "Send a message to start a conversation with the AI assistant.",
  suggestions = [],
  onSuggestionClick,
}: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24">
      <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-brand-accent/20 to-brand-dark/30 border border-brand-accent/30 flex items-center justify-center mb-6">
        <Icon className="w-8 h-8 text-brand-accent" strokeWidth={1.5} />
      </div>
      <h2 className="text-xl font-semibold text-white mb-2">{title}</h2>
      <p className="text-neutral-400 max-w-md mb-6 leading-relaxed">
        {description}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-center">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick?.(suggestion)}
              className="px-3 py-1.5 rounded-full bg-brand-dark/40 hover:bg-brand-dark/60 text-brand-light text-xs transition-colors border border-brand-accent/20 hover:border-brand-accent/40 cursor-pointer"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
