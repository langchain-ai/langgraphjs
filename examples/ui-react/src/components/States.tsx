export function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24">
      <div className="w-12 h-12 mb-6 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-center">
        <svg
          className="w-6 h-6 text-neutral-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <h2 className="text-lg font-medium text-white mb-2">
        How can I help you today?
      </h2>
      <p className="text-neutral-500 text-sm max-w-sm">
        Send a message to start a conversation with the AI assistant.
      </p>
    </div>
  );
}
