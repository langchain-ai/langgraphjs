import type { TimelineEvent } from "../agents/timeline-transformer";
import { formatDuration } from "./TimelineRow";

export function ChannelSummary({
  summary,
}: {
  summary: ReturnType<typeof deriveSummary>;
}) {
  return (
    <dl className="channel-summary">
      <div>
        <dt>Events on channel</dt>
        <dd>{summary.eventCount}</dd>
      </div>
      <div>
        <dt>Tool calls</dt>
        <dd>{summary.toolCount}</dd>
      </div>
      <div>
        <dt>Thoughts</dt>
        <dd>{summary.thoughtCount}</dd>
      </div>
      <div>
        <dt>Total tokens</dt>
        <dd>{summary.totalTokens.toLocaleString()}</dd>
      </div>
      <div>
        <dt>Elapsed</dt>
        <dd>{summary.elapsedLabel}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>
          <span className={`status-pill status-${summary.statusTone}`}>
            {summary.statusLabel}
          </span>
        </dd>
      </div>
    </dl>
  );
}

export function deriveSummary(timeline: TimelineEvent[]): {
  eventCount: number;
  toolCount: number;
  thoughtCount: number;
  totalTokens: number;
  elapsedLabel: string;
  statusLabel: string;
  statusTone: string;
} {
  let toolCount = 0;
  let thoughtCount = 0;
  let totalTokens = 0;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let statusLabel = "idle";
  let statusTone = "pending";

  for (const event of timeline) {
    if (event.kind === "tool-started") toolCount += 1;
    if (event.kind === "thought") {
      thoughtCount += 1;
      totalTokens += event.inputTokens + event.outputTokens;
    }
    if (event.kind === "run-started") {
      startedAt = event.at;
      statusLabel = "running";
      statusTone = "running";
    }
    if (event.kind === "run-finished") {
      finishedAt = event.at;
      totalTokens = event.totalTokens || totalTokens;
      statusLabel = event.status === "error" ? "failed" : "complete";
      statusTone = event.status === "error" ? "error" : "complete";
    }
  }

  const elapsedLabel =
    startedAt != null && finishedAt != null
      ? formatDuration(finishedAt - startedAt)
      : startedAt != null
        ? "in flight"
        : "—";

  return {
    eventCount: timeline.length,
    toolCount,
    thoughtCount,
    totalTokens,
    elapsedLabel,
    statusLabel,
    statusTone,
  };
}
