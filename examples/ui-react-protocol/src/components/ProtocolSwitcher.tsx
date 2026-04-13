type PlaygroundTransportMode = "legacy" | "http-sse" | "websocket";

const OPTIONS: Array<{
  id: PlaygroundTransportMode;
  label: string;
}> = [
  { id: "legacy", label: "Legacy" },
  { id: "http-sse", label: "HTTP+SSE" },
  { id: "websocket", label: "WebSocket" },
];

export function ProtocolSwitcher({
  transportMode,
  onChange,
}: {
  transportMode: PlaygroundTransportMode;
  onChange: (mode: PlaygroundTransportMode) => void;
}) {
  return (
    <div className="transport-toggle" role="group" aria-label="Protocol">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          className={`transport-button ${
            transportMode === option.id ? "transport-button-active" : ""
          }`}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type { PlaygroundTransportMode };
