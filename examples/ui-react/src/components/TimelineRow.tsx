import type { TimelineEvent } from "../agents/timeline-transformer";

export function TimelineRow({
  event,
  active,
}: {
  event: TimelineEvent;
  active: boolean;
}) {
  const meta = rowMeta(event);
  return (
    <li className={`channel-row channel-row-${meta.tone}`}>
      <span
        className={`channel-dot ${active ? "channel-dot-active" : ""}`}
        style={{ background: meta.color }}
        aria-hidden
      />
      <div className="channel-row-body">
        <div className="channel-row-header">
          <div className="channel-row-title">
            <strong>{meta.title}</strong>
            {meta.subtitle ? (
              <span className="channel-row-subtitle">{meta.subtitle}</span>
            ) : null}
          </div>
          <div className="channel-row-meta">
            <span className="channel-row-time">{formatClock(event.at)}</span>
            {meta.duration ? (
              <span className="channel-row-duration">{meta.duration}</span>
            ) : null}
          </div>
        </div>
        {meta.body ? <p className="channel-row-detail">{meta.body}</p> : null}
        {meta.badges.length > 0 ? (
          <div className="channel-row-badges">
            {meta.badges.map((badge) => (
              <span key={badge} className="channel-row-badge">
                {badge}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

type RowMeta = {
  tone: string;
  color: string;
  title: string;
  subtitle?: string;
  body?: string;
  duration?: string;
  badges: string[];
};

const PHASE_DOT: Record<string, string> = {
  search: "#60a5fa",
  summarize: "#a5b4fc",
  score: "#fbbf24",
  compute: "#f472b6",
  research: "#34d399",
  other: "#94a3b8",
};

function rowMeta(event: TimelineEvent): RowMeta {
  switch (event.kind) {
    case "run-started":
      return {
        tone: "run",
        color: "#818cf8",
        title: "Run started",
        subtitle: "transformer initialised",
        badges: [],
      };

    case "tool-started":
      return {
        tone: "tool",
        color: PHASE_DOT[event.phase] ?? PHASE_DOT.other,
        title: event.label,
        subtitle: event.tool,
        body: event.argsPreview || undefined,
        badges: ["started"],
      };

    case "tool-finished":
      return {
        tone: event.status === "error" ? "error" : "tool-done",
        color:
          event.status === "error"
            ? "#f87171"
            : PHASE_DOT[event.phase] ?? PHASE_DOT.other,
        title: event.label,
        subtitle: event.tool,
        body: event.outputPreview || undefined,
        duration: formatDuration(event.durationMs),
        badges: [event.status === "error" ? "failed" : "finished"],
      };

    case "thought":
      return {
        tone: "thought",
        color: "#c4b5fd",
        title: "Agent thought",
        subtitle: `${event.inputTokens + event.outputTokens} tok`,
        body: event.text,
        badges:
          event.outputTokens > 0 ? [`${event.outputTokens} out`] : [],
      };

    case "run-finished":
      return {
        tone: event.status === "error" ? "error" : "run-done",
        color: event.status === "error" ? "#f87171" : "#34d399",
        title: event.status === "error" ? "Run failed" : "Run finished",
        subtitle: `${event.totalTools} tool call${event.totalTools === 1 ? "" : "s"
          } · ${event.totalTokens} tok`,
        body: event.errorMessage,
        duration: formatDuration(event.durationMs),
        badges: [],
      };

    default: {
      const exhaustive: never = event;
      return {
        tone: "run",
        color: "#94a3b8",
        title: "Unknown timeline event",
        body: JSON.stringify(exhaustive),
        badges: [],
      };
    }
  }
}

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)}s`;
  return `${s.toFixed(1)}s`;
};

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
