import type { TraceEntry } from "./ProtocolPlayground.types";
import { safeStringify } from "../utils";

interface EventLogProps {
  eventLog: TraceEntry[];
}

export function EventLog({ eventLog }: EventLogProps) {
  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>Recent Events</h3>
      </div>
      {eventLog.length === 0 ? (
        <div className="empty-panel">
          Tool and update events will appear here.
        </div>
      ) : (
        <div className="trace-list">
          {eventLog.map((entry) => (
            <details key={entry.id} className="trace-item">
              <summary>
                <span className="trace-kind">{entry.kind}</span>
                <span className="trace-label">{entry.label}</span>
                <span className="trace-time">{entry.timestamp}</span>
              </summary>
              <div className="trace-detail">{entry.detail}</div>
              <pre className="trace-raw">{safeStringify(entry.raw)}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
