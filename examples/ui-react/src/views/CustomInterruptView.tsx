import { useCallback, useEffect, useState } from "react";

import { useStream, type UseStreamReturn } from "@langchain/react";

import type {
  agent as customInterruptAgentType,
  ApprovalInterrupt,
  ApprovalResponse,
} from "../agents/custom-interrupt";
import { API_URL, type Transport } from "../api";
import {
  Composer,
  JsonPanel,
  MessageFeed,
  RecentEvents,
  ViewShell,
} from "../components";
import { isRecord } from "../utils";
import { useEventTrace } from "./shared";

type CustomInterruptStream = UseStreamReturn<
  typeof customInterruptAgentType,
  ApprovalInterrupt
>;
type StreamState = CustomInterruptStream["values"];

const ASSISTANT_ID = "custom-interrupt";
const THREAD_ID_STORAGE_KEY = "ui-streaming:custom-interrupt:threadId";

const SUGGESTIONS = [
  "Send the launch email — needs approval first.",
  "Rotate the production key, pending approval.",
  "Draft the changelog slowly (stays in flight ~20s; reload mid-run).",
];

const FOLLOW_UP_HINT =
  "Now send a normal follow-up (no 'approval' keyword), then reload the page.";

export function CustomInterruptView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(THREAD_ID_STORAGE_KEY);
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (threadId) {
      window.localStorage.setItem(THREAD_ID_STORAGE_KEY, threadId);
    } else {
      window.localStorage.removeItem(THREAD_ID_STORAGE_KEY);
    }
  }, [threadId]);

  const clearThread = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(THREAD_ID_STORAGE_KEY);
      window.location.reload();
    }
  }, []);

  const reloadPage = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  return (
    <InnerView
      onClearThread={clearThread}
      onReloadPage={reloadPage}
      onThreadId={setThreadId}
      threadId={threadId}
      transport={transport}
    />
  );
}

function InnerView({
  onClearThread,
  onReloadPage,
  onThreadId,
  threadId,
  transport,
}: {
  onClearThread: () => void;
  onReloadPage: () => void;
  onThreadId: (threadId: string) => void;
  threadId: string | null;
  transport: Transport;
}) {
  const [isResponding, setIsResponding] = useState(false);

  const stream = useStream<typeof customInterruptAgentType, ApprovalInterrupt>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId,
  });

  const eventTrace = useEventTrace(stream);

  const pending = stream.interrupt;
  // The checkpoint also carries `__interrupt__` in its persisted values. A UI
  // that renders from state instead of `stream.interrupt` would keep showing a
  // resolved interrupt after reload, so surface both to tell them apart.
  const valuesInterrupt = isRecord(stream.values)
    ? (stream.values as Record<string, unknown>).__interrupt__
    : undefined;

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as unknown as Partial<StreamState>;
      void stream.submit(input);
    },
    [stream]
  );

  const respond = useCallback(
    async (approved: boolean) => {
      if (pending?.id == null) return;
      setIsResponding(true);
      try {
        await stream.respond(
          {
            approved,
            note: approved ? "Approved from the UI." : "Rejected from the UI.",
          } satisfies ApprovalResponse,
          { interruptId: pending.id }
        );
      } finally {
        setIsResponding(false);
      }
    },
    [pending?.id, stream]
  );

  const statusLabel = stream.isThreadLoading
    ? "Hydrating thread..."
    : pending != null
      ? "Waiting for approval..."
      : isResponding
        ? "Resuming..."
        : stream.isLoading
          ? "Streaming..."
          : "Idle";

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Custom Interrupt + Reload"
      description={
        <>
          A deterministic graph that pauses on a custom <code>interrupt()</code>{" "}
          payload. The thread id is persisted to <code>localStorage</code>, so
          reloading the page re-mounts <code>useStream</code> against the same
          thread and exercises hydration. Reproduction order: trigger the
          interrupt, respond, send a follow-up turn, then reload and check that
          the resolved interrupt does not come back.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            className="suggestion-chip"
            disabled={stream.isLoading || pending != null}
            key={suggestion}
            onClick={() => handleSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Conversation</h3>
            <span className="conversation-status" data-testid="status">
              {statusLabel}
            </span>
          </div>
          <MessageFeed
            isStreaming={stream.isLoading}
            messages={stream.messages}
          />
          {pending != null ? (
            <section className="approval-card" data-testid="interrupt-card">
              <div className="approval-header">
                <div>
                  <div className="eyebrow">Custom Interrupt</div>
                  <h4>{pending.value?.question ?? "Approve this request?"}</h4>
                  <p className="approval-description">
                    Raised by {pending.value?.requestedBy ?? "unknown"} · id{" "}
                    {pending.id}
                  </p>
                </div>
                <span className="status-pill status-pending">paused</span>
              </div>
              <div className="approval-actions">
                <span className="approval-hint">{FOLLOW_UP_HINT}</span>
                <button
                  className="secondary-button"
                  disabled={isResponding}
                  onClick={() => void respond(false)}
                  type="button"
                >
                  Reject
                </button>
                <button
                  className="primary-button"
                  data-testid="approve"
                  disabled={isResponding}
                  onClick={() => void respond(true)}
                  type="button"
                >
                  Approve
                </button>
              </div>
            </section>
          ) : null}
          <Composer
            disabled={stream.isLoading || isResponding || pending != null}
            onSubmit={handleSubmit}
            placeholder={
              pending != null
                ? "Respond to the pending approval to resume the run."
                : "Say anything. Include the word 'approval' to pause on an interrupt."
            }
          />
        </section>

        <aside className="sidebar-stack">
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Reload diagnostics</h3>
              <span
                className={`status-pill ${
                  pending != null ? "status-pending" : "status-complete"
                }`}
                data-testid="interrupt-count"
              >
                {stream.interrupts.length} pending
              </span>
            </div>
            <dl className="hero-metadata" style={{ marginBottom: 12 }}>
              <div>
                <dt>stream.interrupt</dt>
                <dd data-testid="stream-interrupt">
                  {pending?.id ?? "none"}
                </dd>
              </div>
              <div>
                <dt>values.__interrupt__</dt>
                <dd data-testid="values-interrupt">
                  {Array.isArray(valuesInterrupt)
                    ? `${valuesInterrupt.length} entr${
                        valuesInterrupt.length === 1 ? "y" : "ies"
                      }`
                    : valuesInterrupt != null
                      ? "present"
                      : "none"}
                </dd>
              </div>
              <div>
                <dt>isThreadLoading</dt>
                <dd>{String(stream.isThreadLoading)}</dd>
              </div>
              <div>
                <dt>isLoading</dt>
                <dd>{String(stream.isLoading)}</dd>
              </div>
            </dl>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                className="suggestion-chip"
                data-testid="reload"
                onClick={onReloadPage}
                type="button"
              >
                Reload page
              </button>
              <button
                className="suggestion-chip"
                onClick={onClearThread}
                type="button"
              >
                Clear thread
              </button>
            </div>
          </section>
          <JsonPanel title="Interrupt Payload" value={stream.interrupt} />
          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}
