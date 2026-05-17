import { TRANSPORT_LABEL, type Transport } from "../api";

const OPTIONS: Transport[] = ["sse", "websocket"];

export function TransportToggle({
  transport,
  onChange,
}: {
  transport: Transport;
  onChange: (transport: Transport) => void;
}) {
  return (
    <div className="transport-toggle" role="group" aria-label="Transport">
      {OPTIONS.map((option) => (
        <button
          key={option}
          className={`transport-button ${
            transport === option ? "transport-button-active" : ""
          }`}
          onClick={() => onChange(option)}
          type="button"
        >
          {TRANSPORT_LABEL[option]}
        </button>
      ))}
    </div>
  );
}
