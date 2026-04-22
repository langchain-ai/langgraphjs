import { useCallback, useMemo, useState } from "react";

import { useChannel, useStreamExperimental } from "@langchain/react";

import type { agent as researchTimelineAgentType } from "../agents/research-timeline";
import type { TimelineEvent } from "../agents/timeline-transformer";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { ViewShell } from "../components/ViewShell";

const ASSISTANT_ID = "research-timeline";

const SUGGESTIONS = [
  "Research the state of real-time streaming for AI agents and summarise the trade-offs.",
  "Look into checkpoint-driven time travel, then score the biggest risks of rolling it out.",
  "Search for what makes a good onboarding flow and give me a three-bullet takeaway.",
  "Compare HTTP+SSE and WebSocket transports for streaming, then compute 3600/15.",
];

type TimelineStream = ReturnType<
  typeof useStreamExperimental<typeof researchTimelineAgentType>
>;
type StreamState = TimelineStream["values"];

/**
 * Raw `custom` events land as `{ params: { data: { payload } } }` after
 * the protocol wraps the transformer's `StreamChannel` pushes. Unwrap
 * once, validate the shape, and you have a typed `TimelineEvent[]`.
 */
type CustomChannelEvent = {
  params: { data: { payload?: unknown } };
};

const PHASE_DOT: Record<string, string> = {
  search: "#60a5fa",
  summarize: "#a5b4fc",
  score: "#fbbf24",
  compute: "#f472b6",
  research: "#34d399",
  other: "#94a3b8",
};

const formatDuration = (ms: number): string => {
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

export function CustomChannelView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const stream = useStreamExperimental<typeof researchTimelineAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  // The ONLY subscription this view opens. No `useMessages`, no
  // `useValues`, no `useToolCalls` — everything below is derived from
  // the curated `custom:timeline` events the server-side transformer
  // pushes. That's the whole point of this example.
  const rawEvents = useChannel(stream, ["custom:timeline"]);

  const timeline = useMemo<TimelineEvent[]>(() => {
    const out: TimelineEvent[] = [];
    for (const event of rawEvents as unknown as CustomChannelEvent[]) {
      const payload = event.params?.data?.payload;
      if (isTimelineEvent(payload)) out.push(payload);
    }
    return out;
  }, [rawEvents]);

  const summary = useMemo(() => deriveSummary(timeline), [timeline]);

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as unknown as Partial<StreamState>;
      void stream.submit(input);
    },
    [stream]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Custom Stream Channel"
      description={
        <>
          A server-side <code>StreamTransformer</code> watches every raw
          protocol event and republishes a curated, typed{" "}
          <code>TimelineEvent</code> union on a single{" "}
          <code>StreamChannel</code> named <code>timeline</code>. This view
          subscribes <strong>only</strong> via{" "}
          <code>useChannel(stream, ["custom:timeline"])</code>. No{" "}
          <code>useMessages</code>, no <code>useValues</code>, no{" "}
          <code>useToolCalls</code> — everything you see below is rendered
          from exactly one named projection.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-chip"
            disabled={stream.isLoading}
            onClick={() => handleSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <section className="channel-card">
        <div className="panel-card-header">
          <div>
            <h3>custom:timeline</h3>
            <div className="channel-subtitle">
              Everything rendered here comes from the transformer's
              projection — the view never reads another channel.
            </div>
          </div>
          <span className="conversation-status">
            {stream.isLoading ? "Streaming..." : "Idle"}
          </span>
        </div>

        <ChannelSummary summary={summary} />

        {timeline.length === 0 ? (
          <div className="empty-panel channel-empty">
            <strong>Waiting for a run.</strong>
            <p>
              Kick off a research question above. The agent will search,
              summarise, score risks, and reply — and the transformer will
              surface each milestone here.
            </p>
          </div>
        ) : (
          <ol className="channel-timeline">
            {timeline.map((event, index) => (
              <TimelineRow
                key={event.id}
                event={event}
                active={
                  event.kind === "tool-started" &&
                  !timeline
                    .slice(index + 1)
                    .some(
                      (later) =>
                        later.kind === "tool-finished" && later.tool === event.tool
                    )
                }
              />
            ))}
          </ol>
        )}

        <Composer
          disabled={stream.isLoading}
          onSubmit={handleSubmit}
          placeholder="Ask the research agent a question — watch the timeline fill in."
        />
      </section>
    </ViewShell>
  );
}

function ChannelSummary({
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

function TimelineRow({
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
        subtitle: `${event.totalTools} tool call${
          event.totalTools === 1 ? "" : "s"
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

function deriveSummary(timeline: TimelineEvent[]): {
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

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown };
  return (
    v.kind === "run-started" ||
    v.kind === "run-finished" ||
    v.kind === "tool-started" ||
    v.kind === "tool-finished" ||
    v.kind === "thought"
  );
}
