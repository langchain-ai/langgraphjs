import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";

import { useStream } from "@langchain/react";
import type { HITLRequest, HITLResponse } from "langchain";

import type { agent as humanInTheLoopAgentType } from "../agents/human-in-the-loop";
import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import { ProtocolPlayground } from "../components/ProtocolPlayground";
import { getLastAssistantMetadata, isRecord, safeStringify } from "../utils";
import {
  API_URL,
  getStreamProtocol,
  getTransportLabel,
  isProtocolTransportMode,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "./shared";

const ASSISTANT_ID = "human-in-the-loop";
const DEFAULT_REJECT_REASON = "Rejected during human review in the playground.";
const SUGGESTIONS = [
  "Draft and send a rollout update to frontend-team@example.com about the new session protocol.",
  "Notify qa@example.com that the HITL demo is ready for protocol testing.",
  "Send an approval-needed note to ops@example.com about websocket reconnect validation.",
];

const getAllowedDecisions = (reviewConfig: unknown) => {
  if (!isRecord(reviewConfig) || !Array.isArray(reviewConfig.allowedDecisions)) {
    return [] as string[];
  }
  return reviewConfig.allowedDecisions.filter(
    (decision): decision is string => typeof decision === "string"
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

export function HumanInTheLoopView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<number, string>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<number, string>>({});
  const { eventLog, push } = useTraceLog();

  const stream = useStream<
    typeof humanInTheLoopAgentType,
    { InterruptType: HITLRequest }
  >({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    streamProtocol: isProtocolTransportMode(transportMode)
      ? getStreamProtocol(transportMode)
      : "legacy",
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  const hitlRequest = stream.interrupt?.value as HITLRequest | undefined;
  const hasPendingReview =
    hitlRequest != null && hitlRequest.actionRequests.length > 0;

  const description = isProtocolTransportMode(transportMode)
    ? "This view uses createAgent plus HITL middleware while the client opts into the new session-based protocol transport."
    : "This view uses createAgent plus HITL middleware over the same legacy streaming path the standard React examples use today.";

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input);
    },
    [stream]
  );

  const resumeWithDecisions = useCallback(
    async (decisions: HITLResponse["decisions"]) => {
      setIsProcessing(true);
      try {
        await stream.submit(null, {
          command: {
            resume: { decisions } as HITLResponse,
          },
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [stream]
  );

  const handleApprove = useCallback(
    async () => {
      if (!hitlRequest) return;
      const decisions: HITLResponse["decisions"] = hitlRequest.actionRequests.map(
        () => ({ type: "approve" as const })
      );
      await resumeWithDecisions(decisions);
    },
    [hitlRequest, resumeWithDecisions]
  );

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
        editDrafts[index] ?? safeStringify(hitlRequest.actionRequests[index]?.args);
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
          <section className="approval-card" key={`${actionRequest.name}-${index}`}>
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

  return (
    <ProtocolPlayground
      apiUrl={API_URL}
      assistantId={ASSISTANT_ID}
      composerDisabled={stream.isLoading || isProcessing || hasPendingReview}
      conversationSupplement={reviewPanel}
      description={description}
      error={stream.error}
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading || isProcessing}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder={
        hasPendingReview
          ? "Approve, edit, or reject the pending tool call to resume the run."
          : "Ask the agent to draft and send a short rollout update."
      }
      protocolLabel={getTransportLabel(transportMode)}
      statusLabel={
        hasPendingReview
          ? "Waiting for approval..."
          : isProcessing
            ? "Submitting review..."
            : stream.isLoading
              ? "Streaming response..."
              : "Idle"
      }
      suggestions={SUGGESTIONS}
      threadId={threadId}
      title="Human-in-the-Loop Workflow"
      values={stream.values}
    />
  );
}
