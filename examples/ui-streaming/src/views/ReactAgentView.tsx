import { useCallback, useEffect, useState } from "react";

import { useMessages, useStreamExperimental } from "@langchain/react";

import type { agent as reactAgentType } from "../agents/react-agent";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { EventLog } from "../components/EventLog";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { ViewShell } from "../components/ViewShell";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "react-agent";
const THREAD_ID_STORAGE_KEY = "ui-streaming:react-agent:threadId";

/**
 * Window after hook mount during which a transition to `isLoading=true`
 * is attributed to hydrate() re-attaching to a pre-existing in-flight
 * run, rather than to a user-initiated submit in this session.
 */
const ATTACH_OBSERVATION_WINDOW_MS = 5_000;

const SUGGESTIONS = [
  "Run the deep_research tool on 'ephemeral dev agents' and give me three bullets. (slow; use this to test mid-run refresh)",
  "Research what makes a good release announcement, then summarize in three bullets.",
  "Search for the current state of TypeScript 5.5 decorators and compute 42 * 17.",
  "Use the calculator to add 12345 and 67890, then explain when you'd use this in code.",
];

type ReactStream = ReturnType<typeof useStreamExperimental<typeof reactAgentType>>;
type StreamState = ReactStream["values"];

export function ReactAgentView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(THREAD_ID_STORAGE_KEY);
  });
  // Bumping this key fully unmounts + remounts `InnerView`, which is
  // what drives the controller through its dispose → construct →
  // hydrate lifecycle. This is the "did hydrate() re-attach to an
  // in-flight run?" test surface.
  const [remountKey, setRemountKey] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (threadId) {
      window.localStorage.setItem(THREAD_ID_STORAGE_KEY, threadId);
    } else {
      window.localStorage.removeItem(THREAD_ID_STORAGE_KEY);
    }
  }, [threadId]);

  const clearThread = useCallback(() => {
    setThreadId(null);
    setRemountKey((k) => k + 1);
  }, []);

  const remountHook = useCallback(() => {
    setRemountKey((k) => k + 1);
  }, []);

  const reloadPage = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  return (
    <InnerView
      key={remountKey}
      threadId={threadId}
      onThreadId={setThreadId}
      transport={transport}
      onRemountHook={remountHook}
      onReloadPage={reloadPage}
      onClearThread={clearThread}
    />
  );
}

function InnerView({
  threadId,
  onThreadId,
  transport,
  onRemountHook,
  onReloadPage,
  onClearThread,
}: {
  threadId: string | null;
  onThreadId: (threadId: string) => void;
  transport: Transport;
  onRemountHook: () => void;
  onReloadPage: () => void;
  onClearThread: () => void;
}) {
  const stream = useStreamExperimental<typeof reactAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId,
  });

  // Prefer `useMessages(stream)` over `stream.messages` so the
  // component's intent — "render the token-streamed message
  // projection" — is explicit. At the root this short-circuits to
  // `stream.messages` (no extra subscription), but reads the same
  // merged `messages`-channel + `values.messages` projection.
  const messages = useMessages(stream);

  const eventLog = useEventTrace(stream);

  const [submittedThisSession, setSubmittedThisSession] = useState(false);
  const reattachStatus = useReattachStatus(stream, {
    threadIdAtMount: threadId,
    submittedThisSession,
  });

  const handleSubmit = useCallback(
    (content: string) => {
      setSubmittedThisSession(true);
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
      title="ReAct Agent"
      description={
        <>
          A <code>createAgent</code> runtime wired through{" "}
          <code>useStreamExperimental</code>. Tool calls stream as
          <code> AIMessageChunk</code>s with partial JSON args, then promote to
          a finalized <code>AIMessage</code> once the block closes. This view
          also doubles as a re-attach harness: trigger the slow
          <code> deep_research</code> tool, then remount the hook (or reload
          the page) and watch the diagnostics panel to verify that{" "}
          <code>controller.hydrate()</code> picks the in-flight run back up.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-chip"
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
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <MessageFeed messages={messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Ask the agent something that benefits from search + calculator tools."
          />
        </section>

        <aside className="sidebar-stack">
          <ReattachPanel
            stream={stream}
            status={reattachStatus}
            onRemountHook={onRemountHook}
            onReloadPage={onReloadPage}
            onClearThread={onClearThread}
          />
          <JsonPanel
            title="Root Tool Calls"
            value={stream.toolCalls.map((call) => ({
              callId: call.callId,
              name: call.name,
              namespace: call.namespace,
              input: call.input,
            }))}
          />
          <JsonPanel title="Current State" value={stream.values} />
          <EventLog eventLog={eventLog} />
        </aside>
      </div>
    </ViewShell>
  );
}

type ReattachVerdict =
  | "no-thread"
  | "observing"
  | "attached-to-in-flight"
  | "hydrated-idle";

interface ReattachStatus {
  verdict: ReattachVerdict;
  mountedAt: number;
  threadIdAtMount: string | null;
  firstLoadingObservedAt: number | null;
  submittedThisSession: boolean;
}

/**
 * Observes the hook's lifecycle from mount and emits a verdict about
 * whether `controller.hydrate(threadId)` picked up a pre-existing
 * in-flight run.
 *
 * Heuristic:
 *   - If we mounted without a threadId → "no-thread".
 *   - If `isLoading` becomes true within the observation window BEFORE
 *     the user submitted in this session → "attached-to-in-flight".
 *   - If the window elapses without a local submit and without an
 *     observed loading transition → "hydrated-idle".
 *   - Otherwise → "observing" until the verdict settles.
 */
function useReattachStatus(
  stream: ReactStream,
  {
    threadIdAtMount,
    submittedThisSession,
  }: { threadIdAtMount: string | null; submittedThisSession: boolean }
): ReattachStatus {
  const [mountedAt] = useState(() => Date.now());
  const [firstLoadingObservedAt, setFirstLoadingObservedAt] = useState<
    number | null
  >(null);
  const [windowElapsed, setWindowElapsed] = useState(false);

  useEffect(() => {
    if (stream.isLoading && firstLoadingObservedAt == null) {
      setFirstLoadingObservedAt(Date.now());
    }
  }, [stream.isLoading, firstLoadingObservedAt]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setWindowElapsed(true);
    }, ATTACH_OBSERVATION_WINDOW_MS);
    return () => clearTimeout(timer);
  }, []);

  let verdict: ReattachVerdict;
  if (threadIdAtMount == null) {
    verdict = "no-thread";
  } else if (
    firstLoadingObservedAt != null &&
    firstLoadingObservedAt - mountedAt < ATTACH_OBSERVATION_WINDOW_MS &&
    !submittedThisSession
  ) {
    verdict = "attached-to-in-flight";
  } else if (windowElapsed && !submittedThisSession) {
    verdict = "hydrated-idle";
  } else {
    verdict = "observing";
  }

  return {
    verdict,
    mountedAt,
    threadIdAtMount,
    firstLoadingObservedAt,
    submittedThisSession,
  };
}

function ReattachPanel({
  stream,
  status,
  onRemountHook,
  onReloadPage,
  onClearThread,
}: {
  stream: ReactStream;
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
