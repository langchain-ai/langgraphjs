import { useCallback, useState } from "react";

import { useStream, type UseStreamReturn } from "@langchain/react";
import type { HITLRequest, HITLResponse } from "langchain";

import type { agent as hitlAgentType } from "../agents/human-in-the-loop";
import { API_URL, type Transport } from "../api";
import {
  Composer,
  HumanReviewPanel,
  JsonPanel,
  MessageFeed,
  RecentEvents,
  ViewShell,
} from "../components";
import { toCamelCaseKeys } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "human-in-the-loop";
const SUGGESTIONS = [
  "Draft and send a rollout update to frontend-team@example.com about the new streaming SDK.",
  "Notify qa@example.com that the HITL demo is ready for protocol testing.",
];

type HITLStream = UseStreamReturn<typeof hitlAgentType, HITLRequest>;
type StreamState = HITLStream["values"];

export function HumanInTheLoopView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const stream = useStream<typeof hitlAgentType, HITLRequest>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const eventTrace = useEventTrace(stream);

  const hitlRequest =
    stream.interrupt?.value != null
      ? toCamelCaseKeys<HITLRequest>(stream.interrupt.value)
      : undefined;
  const hasPendingReview =
    hitlRequest != null && hitlRequest.actionRequests.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as unknown as Partial<StreamState>;
      void stream.submit(input);
    },
    [stream]
  );

  const resumeWithDecisions = useCallback(
    async (decisions: HITLResponse["decisions"]) => {
      setIsProcessing(true);
      try {
        await stream.submit(null, {
          command: { resume: { decisions } as HITLResponse },
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [stream]
  );

  const statusLabel = hasPendingReview
    ? "Waiting for approval..."
    : isProcessing
      ? "Submitting review..."
      : stream.isLoading
        ? "Streaming..."
        : "Idle";

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Human in the Loop"
      description={
        <>
          A <code>createAgent</code> with <code>humanInTheLoopMiddleware</code>.
          The interrupt rides the always-on root projection; resuming posts
          through <code>stream.submit(null, {"{"}command: {"{"}resume{"}}"})</code>.
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
            <span className="conversation-status">{statusLabel}</span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={stream.messages} />
          {hasPendingReview ? (
            <HumanReviewPanel
              hitlRequest={hitlRequest}
              isProcessing={isProcessing}
              onResume={resumeWithDecisions}
            />
          ) : null}
          <Composer
            disabled={stream.isLoading || isProcessing || hasPendingReview}
            onSubmit={handleSubmit}
            placeholder={
              hasPendingReview
                ? "Approve, edit, or reject the pending tool call to resume the run."
                : "Ask the agent to draft and send a short rollout update."
            }
          />
        </section>

        <aside className="sidebar-stack">
          <JsonPanel title="Interrupt Payload" value={stream.interrupt} />
          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}
