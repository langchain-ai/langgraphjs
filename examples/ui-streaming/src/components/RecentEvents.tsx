import type { TraceEntry } from "./ProtocolPlayground.types";
import { safeStringify } from "../utils";

interface RecentEventsProps {
  events: TraceEntry[];
}

export function RecentEvents({ events }: RecentEventsProps) {
  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>Recent Events</h3>
      </div>
      {events.length === 0 ? (
        <div className="empty-panel">
          Tool and update events will appear here.
        </div>
      ) : (
        <div className="trace-list">
          {events.map((entry) => (
            <details key={entry.id} className="trace-item">
              <summary>
                <span className="trace-time">{entry.timestamp}</span>
                <span className="trace-summary-main">
                  <span className="trace-kind">{entry.kind}</span>
                  <span className="trace-label">{entry.label}</span>
                </span>
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
