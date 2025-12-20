export function LoadingIndicator() {
  return (
    <div className="animate-fade-in">
      <div className="text-xs font-medium text-neutral-500 mb-2">Assistant</div>
      <div className="flex items-center gap-1">
        <span
          className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-pulse-subtle"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-pulse-subtle"
          style={{ animationDelay: "300ms" }}
        />
        <span
          className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-pulse-subtle"
          style={{ animationDelay: "600ms" }}
        />
      </div>
    </div>
  );
}
