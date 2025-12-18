import { useState } from "react";
import {
  Check,
  X,
  Pencil,
  Mail,
  Trash2,
  ShieldAlert,
} from "lucide-react";

import type { ActionRequest, ReviewConfig } from "langchain";

export const DEFAULT_REJECT_REASON = "User rejected the action";

/**
 * Component for displaying a pending tool call that requires approval
 */
export function PendingApprovalCard({
  actionRequest,
  reviewConfig,
  onApprove,
  onReject,
  onEdit,
  isProcessing,
}: {
  actionRequest: ActionRequest;
  reviewConfig: ReviewConfig;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onEdit: (editedArgs: Record<string, unknown>) => void;
  isProcessing: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>(
    actionRequest.args
  );
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const getIcon = () => {
    switch (actionRequest.name) {
      case "send_email":
        return <Mail className="w-5 h-5" />;
      case "delete_file":
        return <Trash2 className="w-5 h-5" />;
      default:
        return <ShieldAlert className="w-5 h-5" />;
    }
  };

  const getTitle = () => {
    switch (actionRequest.name) {
      case "send_email":
        return "Send Email";
      case "delete_file":
        return "Delete File";
      default:
        return actionRequest.name;
    }
  };

  // Derive capabilities from config
  const canEdit = reviewConfig.allowedDecisions.includes("edit");

  return (
    <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400">
          {getIcon()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-amber-200">
              {getTitle()}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-medium">
              Awaiting Approval
            </span>
          </div>
          <p className="text-xs text-amber-300/70 mt-0.5">
            {actionRequest.description || "This action requires your approval"}
          </p>
        </div>
      </div>

      {/* Arguments */}
      <div className="bg-black/40 rounded-lg p-4 mb-4 border border-amber-500/10">
        {isEditing ? (
          <div className="space-y-3">
            {Object.entries(editedArgs).map(([key, value]) => (
              <div key={key}>
                <label className="block text-xs font-medium text-amber-300/80 mb-1">
                  {key}
                </label>
                {key === "body" ? (
                  <textarea
                    value={String(value)}
                    onChange={(e) =>
                      setEditedArgs({ ...editedArgs, [key]: e.target.value })
                    }
                    className="w-full bg-neutral-900 border border-amber-500/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400 resize-none"
                    rows={3}
                  />
                ) : (
                  <input
                    type="text"
                    value={String(value)}
                    onChange={(e) =>
                      setEditedArgs({ ...editedArgs, [key]: e.target.value })
                    }
                    className="w-full bg-neutral-900 border border-amber-500/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {Object.entries(actionRequest.args).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="text-xs font-mono text-amber-300/60 min-w-[80px]">
                  {key}:
                </span>
                <span className="text-xs text-white break-all">
                  {String(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reject reason input */}
      {showRejectInput && (
        <div className="mb-4">
          <label className="block text-xs font-medium text-neutral-400 mb-1">
            Reason for rejection (optional)
          </label>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Enter reason..."
            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-400"
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {isEditing ? (
          <>
            <button
              onClick={() => {
                onEdit(editedArgs);
                setIsEditing(false);
              }}
              disabled={isProcessing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-medium text-sm transition-colors disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              Save & Approve
            </button>
            <button
              onClick={() => {
                setEditedArgs(actionRequest.args);
                setIsEditing(false);
              }}
              disabled={isProcessing}
              className="px-4 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : showRejectInput ? (
          <>
            <button
              onClick={() => {
                onReject(rejectReason ?? DEFAULT_REJECT_REASON);
                setShowRejectInput(false);
              }}
              disabled={isProcessing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500 hover:bg-red-400 text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              Confirm Reject
            </button>
            <button
              onClick={() => setShowRejectInput(false)}
              disabled={isProcessing}
              className="px-4 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onApprove}
              disabled={isProcessing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              Approve
            </button>
            {canEdit && (
              <button
                onClick={() => setIsEditing(true)}
                disabled={isProcessing}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium text-sm transition-colors disabled:opacity-50"
              >
                <Pencil className="w-4 h-4" />
                Edit
              </button>
            )}
            <button
              onClick={() => setShowRejectInput(true)}
              disabled={isProcessing}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white font-medium text-sm transition-colors disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
