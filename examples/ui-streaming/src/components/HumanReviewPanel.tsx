import { useCallback, useState, type ChangeEvent } from "react";

import type { HITLRequest, HITLResponse } from "langchain";

import { isRecord, safeStringify } from "../utils";

const DEFAULT_REJECT_REASON = "Rejected during human review.";

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

export function HumanReviewPanel({
  hitlRequest,
  isProcessing,
  onResume,
}: {
  hitlRequest: HITLRequest;
  isProcessing: boolean;
  onResume: (decisions: HITLResponse["decisions"]) => Promise<void>;
}) {
  const [editDrafts, setEditDrafts] = useState<Record<number, string>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<number, string>>({});

  const handleApprove = useCallback(async () => {
    const decisions: HITLResponse["decisions"] = hitlRequest.actionRequests.map(
      () => ({ type: "approve" as const })
    );
    await onResume(decisions);
  }, [hitlRequest, onResume]);

  const handleReject = useCallback(
    async (index: number) => {
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map((_, actionIndex) =>
          actionIndex === index
            ? {
                type: "reject" as const,
                message: DEFAULT_REJECT_REASON,
              }
            : { type: "approve" as const }
        );
      await onResume(decisions);
    },
    [hitlRequest, onResume]
  );

  const handleEdit = useCallback(
    async (index: number) => {
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
      await onResume(decisions);
    },
    [editDrafts, hitlRequest, onResume]
  );

  return (
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
  );
}
