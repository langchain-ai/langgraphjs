import { useCallback, useMemo, useState } from "react";

import { useChannel, useStream, type UseStreamReturn } from "@langchain/react";

import type { agent as researchTimelineAgentType } from "../agents/research-timeline";
import type { TimelineEvent } from "../agents/timeline-transformer";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { ViewShell } from "../components/ViewShell";

import { ChannelSummary, deriveSummary } from "../components/ChannelSummary";
import { TimelineRow } from "../components/TimelineRow";

const ASSISTANT_ID = "research-timeline";

const SUGGESTIONS = [
  "Research the state of real-time streaming for AI agents and summarise the trade-offs.",
  "Look into checkpoint-driven time travel, then score the biggest risks of rolling it out.",
  "Search for what makes a good onboarding flow and give me a three-bullet takeaway.",
  "Compare HTTP+SSE and WebSocket transports for streaming, then compute 3600/15.",
];

type TimelineStream = UseStreamReturn<typeof researchTimelineAgentType>;
type StreamState = TimelineStream["values"];

/**
 * Raw `custom` events land as `{ params: { data: { payload } } }` after
 * the protocol wraps the transformer's `StreamChannel` pushes. Unwrap
 * once, validate the shape, and you have a typed `TimelineEvent[]`.
 */
type CustomChannelEvent = {
  params: { data: { payload?: unknown } };
};

export function CustomChannelView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const stream = useStream<typeof researchTimelineAgentType>({
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
          <code>TimelineEvent</code> union on a single remote{" "}
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
