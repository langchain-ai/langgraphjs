import { useCallback, useState, type ChangeEvent } from "react";

import { useStreamExperimental } from "@langchain/react";
import type { HITLRequest, HITLResponse } from "langchain";

import type { agent as hitlAgentType } from "../agents/human-in-the-loop";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { EventLog } from "../components/EventLog";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { ViewShell } from "../components/ViewShell";
import { isRecord, safeStringify } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "human-in-the-loop";
const DEFAULT_REJECT_REASON = "Rejected during human review.";
const SUGGESTIONS = [
  "Draft and send a rollout update to frontend-team@example.com about the new streaming SDK.",
  "Notify qa@example.com that the HITL demo is ready for protocol testing.",
];

type HITLStream = ReturnType<
  typeof useStreamExperimental<typeof hitlAgentType, HITLRequest>
>;
type StreamState = HITLStream["values"];

const getAllowedDecisions = (reviewConfig: unknown): string[] => {
  if (!isRecord(reviewConfig) || !Array.isArray(reviewConfig.allowedDecisions)) {
    return [];
  }
  return reviewConfig.allowedDecisions.filter(
    (d): d is string => typeof d === "string"
  );
};

const getReviewDescription = (reviewConfig: unknown) => {
  if (!isRecord(reviewConfig) || typeof reviewConfig.description !== "string") {
    return "Review the pending tool call before the run resumes.";
  }
  return reviewConfig.description;
};

const formatActionName = (name: string) =>
  name
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

export function HumanInTheLoopView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<number, string>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<number, string>>({});

  const stream = useStreamExperimental<typeof hitlAgentType, HITLRequest>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const eventLog = useEventTrace(stream);

  const hitlRequest = stream.interrupt?.value as HITLRequest | undefined;
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

  const handleApprove = useCallback(async () => {
    if (!hitlRequest) return;
    const decisions: HITLResponse["decisions"] = hitlRequest.actionRequests.map(
      () => ({ type: "approve" as const })
    );
    await resumeWithDecisions(decisions);
  }, [hitlRequest, resumeWithDecisions]);

  const handleReject = useCallback(
    async (index: number) => {
      if (!hitlRequest) return;
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, actionIndex) =>
          actionIndex === index
            ? {
                type: "reject" as const,
                message: DEFAULT_REJECT_REASON,
              }
            : { type: "approve" as const }
        );
      await resumeWithDecisions(decisions);
    },
    [hitlRequest, resumeWithDecisions]
  );

  const handleEdit = useCallback(
    async (index: number) => {
      if (!hitlRequest) return;

      const rawDraft =
        editDrafts[index] ??
        safeStringify(hitlRequest.actionRequests[index]?.args);
      let parsedDraft: unknown;
      try {
        parsedDraft = JSON.parse(rawDraft);
      } catch {
        setReviewErrors((current) => ({
          ...current,
          [index]: "Edited arguments must be valid JSON.",
        }));
        return;
      }

      if (!isRecord(parsedDraft)) {
        setReviewErrors((current) => ({
          ...current,
          [index]: "Edited arguments must decode to a JSON object.",
        }));
        return;
      }

      setReviewErrors((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });

      const originalAction = hitlRequest.actionRequests[index];
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, actionIndex) =>
          actionIndex === index
            ? {
                type: "edit" as const,
                editedAction: {
                  name: originalAction.name,
                  args: parsedDraft,
                },
              }
            : { type: "approve" as const }
        );
      await resumeWithDecisions(decisions);
    },
    [editDrafts, hitlRequest, resumeWithDecisions]
  );

  const reviewPanel = hasPendingReview ? (
    <div className="approval-panel">
      {hitlRequest.actionRequests.map((actionRequest, index) => {
        const reviewConfig = hitlRequest.reviewConfigs[index];
        const allowedDecisions = getAllowedDecisions(reviewConfig);
        const canEdit = allowedDecisions.includes("edit");
        const canReject = allowedDecisions.includes("reject");
        const canApprove =
          allowedDecisions.length === 0 || allowedDecisions.includes("approve");

        return (
          <section
            className="approval-card"
            key={`${actionRequest.name}-${index}`}
          >
            <div className="approval-header">
              <div>
                <div className="eyebrow">Human Review Required</div>
                <h4>{formatActionName(actionRequest.name)}</h4>
                <p className="approval-description">
                  {getReviewDescription(reviewConfig)}
                </p>
              </div>
              <span className="status-pill status-pending">paused</span>
            </div>

            <div className="approval-badges">
              {allowedDecisions.map((decision) => (
                <span className="approval-badge" key={decision}>
                  {decision}
                </span>
              ))}
            </div>

            <label className="approval-editor">
              <span className="tool-card-section-label">Tool Arguments</span>
              <textarea
                className="approval-textarea"
                disabled={isProcessing || !canEdit}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                  const value = event.currentTarget.value;
                  setEditDrafts((current) => ({
                    ...current,
                    [index]: value,
                  }));
                  setReviewErrors((current) => {
                    const next = { ...current };
                    delete next[index];
                    return next;
                  });
                }}
                value={editDrafts[index] ?? safeStringify(actionRequest.args)}
              />
            </label>

            {reviewErrors[index] ? (
              <div className="approval-error">{reviewErrors[index]}</div>
            ) : null}

            <div className="approval-actions">
              <span className="approval-hint">
                The run is paused until this tool call is reviewed.
              </span>
              {canReject ? (
                <button
                  className="secondary-button"
                  disabled={isProcessing}
                  onClick={() => void handleReject(index)}
                  type="button"
                >
                  Reject
                </button>
              ) : null}
              {canEdit ? (
                <button
                  className="secondary-button"
                  disabled={isProcessing}
                  onClick={() => void handleEdit(index)}
                  type="button"
                >
                  Approve with edits
                </button>
              ) : null}
              {canApprove ? (
                <button
                  className="primary-button"
                  disabled={isProcessing}
                  onClick={() => void handleApprove()}
                  type="button"
                >
                  Approve
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  ) : null;

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
          <MessageFeed messages={stream.messages} />
          {reviewPanel}
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
          <EventLog eventLog={eventLog} />
        </aside>
      </div>
    </ViewShell>
  );
}
