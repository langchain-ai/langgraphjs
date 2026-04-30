import { useCallback, useEffect, useState } from "react";

import { type InferStateType, useMessages, useStream } from "@langchain/react";

import type { agent as reactAgentType } from "../agents/react-agent";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { useEventTrace } from "./shared";
import { useReattachStatus } from "../hooks/useReattachStatus";
import { ReattachPanel } from "../components/ReattachPanel";

const ASSISTANT_ID = "react-agent";
const THREAD_ID_STORAGE_KEY = "ui-streaming:react-agent:threadId";

const SUGGESTIONS = [
  "Run the deep_research tool on 'ephemeral dev agents' and give me three bullets. (slow; use this to test mid-run refresh)",
  "Research what makes a good release announcement, then summarize in three bullets.",
  "Search for the current state of TypeScript 5.5 decorators and compute 42 * 17.",
  "Use the calculator to add 12345 and 67890, then explain when you'd use this in code.",
];

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
  const stream = useStream<typeof reactAgentType>({
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

  const eventTrace = useEventTrace(stream);

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
      } as Partial<InferStateType<typeof reactAgentType>>;
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
          <code>useStream</code>. Tool calls stream as
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
          <MessageFeed isStreaming={stream.isLoading} messages={messages} />
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
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}