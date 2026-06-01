import type { UseStreamReturn } from "@langchain/react";
import type { agent as reactAgentType } from "../agents/react-agent";

import type { ReattachStatus, ReattachVerdict } from "../hooks/useReattachStatus";

export function ReattachPanel({
  stream,
  status,
  onRemountHook,
  onReloadPage,
  onClearThread,
}: {
  stream: UseStreamReturn<typeof reactAgentType>;
  status: ReattachStatus;
  onRemountHook: () => void;
  onReloadPage: () => void;
  onClearThread: () => void;
}) {
  const verdictCopy = VERDICT_COPY[status.verdict];
  const msSinceMount = status.firstLoadingObservedAt
    ? status.firstLoadingObservedAt - status.mountedAt
    : null;

  return (
    <section className="panel-card">
      <div className="panel-card-header">
        <h3>Re-attach diagnostics</h3>
        <span className={`status-pill status-${verdictCopy.tone}`}>
          {verdictCopy.label}
        </span>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.4 }}>
        {verdictCopy.description}
      </p>
      <dl className="hero-metadata" style={{ marginBottom: 12 }}>
        <div>
          <dt>threadId at mount</dt>
          <dd>{status.threadIdAtMount ?? "none"}</dd>
        </div>
        <div>
          <dt>isThreadLoading</dt>
          <dd>{String(stream.isThreadLoading)}</dd>
        </div>
        <div>
          <dt>isLoading (now)</dt>
          <dd>{String(stream.isLoading)}</dd>
        </div>
        <div>
          <dt>first isLoading=true</dt>
          <dd>
            {msSinceMount != null
              ? `${msSinceMount}ms after mount`
              : "not yet"}
          </dd>
        </div>
        <div>
          <dt>submitted this session</dt>
          <dd>{String(status.submittedThisSession)}</dd>
        </div>
      </dl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          className="suggestion-chip"
          onClick={onRemountHook}
        >
          Remount hook
        </button>
        <button
          type="button"
          className="suggestion-chip"
          onClick={onReloadPage}
        >
          Reload page
        </button>
        <button
          type="button"
          className="suggestion-chip"
          onClick={onClearThread}
        >
          Clear thread
        </button>
      </div>
      <p
        style={{
          margin: "12px 0 0",
          fontSize: 12,
          lineHeight: 1.4,
          opacity: 0.75,
        }}
      >
        Test flow: submit the <code>deep_research</code> suggestion, wait for{" "}
        <code>isLoading=true</code>, then click <strong>Remount hook</strong>{" "}
        or <strong>Reload page</strong> before the ~21s tool finishes. The
        verdict should flip to <em>attached-to-in-flight</em> and events
        should keep arriving in the log.
      </p>
    </section>
  );
}

const VERDICT_COPY: Record<
  ReattachVerdict,
  { label: string; description: string; tone: string }
> = {
  "no-thread": {
    label: "no thread",
    description:
      "Hook mounted without a threadId — nothing to re-attach to. Submit a run to create a thread.",
    tone: "pending",
  },
  observing: {
    label: "observing",
    description:
      "Watching for an isLoading transition within the attach window.",
    tone: "running",
  },
  "attached-to-in-flight": {
    label: "attached to in-flight run",
    description:
      "isLoading became true shortly after mount without a local submit — hydrate() successfully re-attached to a pre-existing run.",
    tone: "complete",
  },
  "hydrated-idle": {
    label: "hydrated (idle thread)",
    description:
      "The observation window elapsed and the thread is idle — thread state hydrated but there was no in-flight run to attach to.",
    tone: "pending",
  },
};
