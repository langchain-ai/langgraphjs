import { useEffect, useMemo, useState } from "react";

import { useExtension, useStreamContext } from "@langchain/react";

import type { A2AStreamEvent } from "../app/transformer";
import type { GraphType } from "../app";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextParts(parts: unknown) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) =>
      isRecord(part) && part.kind === "text" && typeof part.text === "string"
        ? part.text
        : ""
    )
    .filter(Boolean)
    .join("");
}

function getStatusMessage(event: A2AStreamEvent) {
  if (event.kind !== "status-update") return "";
  return extractTextParts(event.status.message?.parts);
}

function getArtifactText(event: A2AStreamEvent) {
  if (event.kind !== "artifact-update") return "";
  return extractTextParts(event.artifact.parts);
}

function formatTaskId(taskId: string | undefined) {
  return taskId == null ? "pending" : taskId.slice(0, 8);
}

function getA2AProjection(events: A2AStreamEvent[]) {
  const statuses: Array<{
    final: boolean;
    message: string;
    state: string;
    timestamp?: string;
  }> = [];
  const artifacts = new Map<
    string,
    { complete: boolean; name: string; text: string }
  >();
  let taskId: string | undefined;

  for (const event of events) {
    taskId ??= event.taskId;

    if (event.kind === "status-update") {
      statuses.push({
        final: event.final,
        message: getStatusMessage(event),
        state: event.status.state,
        timestamp: event.status.timestamp,
      });
      continue;
    }

    const id = event.artifact.artifactId;
    const current = artifacts.get(id);
    const text = getArtifactText(event);
    artifacts.set(id, {
      complete: event.lastChunk || current?.complete === true,
      name: event.artifact.name ?? id,
      text:
        event.append === false || event.lastChunk
          ? text
          : `${current?.text ?? ""}${text}`,
    });
  }

  return {
    artifacts: [...artifacts.values()],
    eventCount: events.length,
    latestStatus: statuses.at(-1),
    statuses,
    taskId,
  };
}

export function A2AProjectionPanel() {
  const stream = useStreamContext<GraphType>();
  const [events, setEvents] = useState<A2AStreamEvent[]>([]);
  const a2a = useExtension<A2AStreamEvent>(stream, "a2a");
  const projection = useMemo(() => getA2AProjection(events), [events]);

  useEffect(() => {
    if (stream.isLoading) {
      setEvents([]);
    }
  }, [stream.isLoading]);

  useEffect(() => {
    if (a2a == null) return;
    setEvents((current) => [...current, a2a]);
  }, [a2a]);

  return (
    <section aria-label="A2A stream events" className="a2a-card">
      <div className="a2a-heading">
        <div>
          <h2>Custom A2A Projection</h2>
          <p>
            Rendered from <code>useExtension(stream, "a2a")</code>.
          </p>
        </div>
        <span>{stream.isLoading ? "Streaming" : "Idle"}</span>
      </div>

      {events.length === 0 ? (
        <div className="empty-state">
          Start a run to see status updates and streamed artifacts projected
          into this UI.
        </div>
      ) : null}

      {events.length > 0 ? (
        <>
          <div className="a2a-summary">
            <div>
              <span>Task</span>
              <strong>{formatTaskId(projection.taskId)}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{projection.latestStatus?.state ?? "pending"}</strong>
            </div>
            <div>
              <span>Custom events</span>
              <strong>{projection.eventCount}</strong>
            </div>
          </div>

          <div className="a2a-status-list" aria-label="A2A status timeline">
            {projection.statuses.map((status, index) => (
              <div
                className={`a2a-status ${status.final ? "final" : ""}`}
                key={`${status.state}-${status.timestamp ?? index}`}
              >
                <span>{status.state}</span>
                <p>{status.message}</p>
              </div>
            ))}
          </div>

          <div className="a2a-artifacts">
            {projection.artifacts.map((artifact) => (
              <article className="a2a-artifact" key={artifact.name}>
                <div>
                  <span>{artifact.name}</span>
                  <strong>{artifact.complete ? "Final" : "Streaming"}</strong>
                </div>
                <p>{artifact.text}</p>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
