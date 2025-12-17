import { useRef, useEffect, useState, useCallback } from "react";
import {
  AlertCircle,
  Check,
  X,
  Pencil,
  Mail,
  Trash2,
  FileText,
  ShieldAlert,
  UserCheck,
} from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { UIMessage } from "@langchain/langgraph-sdk";
import type { HumanInterrupt } from "@langchain/langgraph/prebuilt";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";

import type { agent, sendEmail, deleteFile, readFile } from "./agent";
import type { ToolCallFromTool, ToolCallWithResult } from "@langchain/langgraph-sdk/react";

const HITL_SUGGESTIONS = [
  "Send an email to john@example.com",
  "Delete the file test.txt",
  "Read the contents of config.json",
];

// Type for tool calls from our agent
type AgentToolCalls =
  | ToolCallFromTool<typeof sendEmail>
  | ToolCallFromTool<typeof deleteFile>
  | ToolCallFromTool<typeof readFile>;

/**
 * Helper to check if a message has actual text content.
 */
function hasContent(message: UIMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message.content)) {
    return message.content.some(
      (c) => c.type === "text" && c.text.trim().length > 0
    );
  }
  return false;
}

/**
 * Component for displaying a pending tool call that requires approval
 */
function PendingApprovalCard({
  interrupt,
  onApprove,
  onReject,
  onEdit,
  isProcessing,
}: {
  interrupt: HumanInterrupt;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onEdit: (editedArgs: Record<string, unknown>) => void;
  isProcessing: boolean;
}) {
  const { action_request, config, description } = interrupt;
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>(action_request.args);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const getIcon = () => {
    switch (action_request.action) {
      case "send_email":
        return <Mail className="w-5 h-5" />;
      case "delete_file":
        return <Trash2 className="w-5 h-5" />;
      default:
        return <ShieldAlert className="w-5 h-5" />;
    }
  };

  const getTitle = () => {
    switch (action_request.action) {
      case "send_email":
        return "Send Email";
      case "delete_file":
        return "Delete File";
      default:
        return action_request.action;
    }
  };

  // Derive capabilities from config
  const canEdit = config.allow_edit;

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
            {description || "This action requires your approval"}
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
            {Object.entries(action_request.args).map(([key, value]) => (
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
                setEditedArgs(action_request.args);
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
                onReject(rejectReason);
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

/**
 * Tool call card component for completed/pending tools
 */
function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<AgentToolCalls>;
}) {
  const { call, result, state } = toolCall;
  const isLoading = state === "pending";

  const getIcon = () => {
    switch (call.name) {
      case "send_email":
        return <Mail className="w-4 h-4 text-brand-accent" />;
      case "delete_file":
        return <Trash2 className="w-4 h-4 text-red-400" />;
      case "read_file":
        return <FileText className="w-4 h-4 text-blue-400" />;
      default:
        return <ShieldAlert className="w-4 h-4 text-neutral-400" />;
    }
  };

  const getTitle = () => {
    switch (call.name) {
      case "send_email":
        return "Email Sent";
      case "delete_file":
        return "File Deleted";
      case "read_file":
        return "File Read";
      default:
        throw new Error(`Unknown tool call: ${JSON.stringify(call)}`);
    }
  };

  const parsedResult = result
    ? JSON.parse(result.content as string)
    : { status: "pending", content: "" };

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">{getTitle()}</div>
          <div className="text-xs text-neutral-500">
            {isLoading ? "Processing..." : "Completed"}
          </div>
        </div>
        {parsedResult.status === "success" && (
          <Check className="w-4 h-4 text-green-400" />
        )}
      </div>

      {result && (
        <div className="text-sm rounded-lg p-3 bg-black border border-neutral-800 text-neutral-300">
          {parsedResult.content}
        </div>
      )}
    </div>
  );
}

export function HumanInTheLoop() {
  const stream = useStream<typeof agent, { InterruptType: HumanInterrupt[] }>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stream.uiMessages, stream.isLoading, stream.interrupt]);

  const hasMessages = stream.uiMessages.length > 0;
  const interrupt = stream.interrupt;
  // Type assertion needed because the generic inference doesn't properly propagate
  const interruptValue = interrupt?.value as HumanInterrupt[] | undefined;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  // Handle approval
  const handleApprove = async () => {
    if (!interruptValue?.length) return;
    setIsProcessing(true);
    try {
      await stream.submit(null, {
        command: {
          resume: {
            decisions: interruptValue.map(() => ({
              type: "approve",
            })),
          },
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle rejection
  const handleReject = async (reason: string) => {
    if (!interruptValue?.length) return;
    setIsProcessing(true);
    try {
      await stream.submit(null, {
        command: {
          resume: {
            decisions: interruptValue.map(() => ({
              type: "reject",
              reason: reason || "User rejected the action",
            })),
          },
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle edit
  const handleEdit = async (editedArgs: Record<string, unknown>) => {
    if (!interruptValue?.length) return;
    setIsProcessing(true);
    try {
      const originalRequest = interruptValue[0];
      await stream.submit(null, {
        command: {
          resume: {
            decisions: [
              {
                type: "edit",
                edited_action: {
                  action: originalRequest.action_request.action,
                  args: editedArgs,
                },
              },
            ],
          },
        },
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages && !interrupt ? (
            <EmptyState
              icon={UserCheck}
              title="Human in the Loop"
              description="An agent that requires your approval for sensitive actions. Try sending an email, deleting a file, or reading file contents."
              suggestions={HITL_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.uiMessages.map((message, idx) => {
                // For AI messages, check if they have tool calls
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  // Render tool calls if present
                  if (toolCalls.length > 0) {
                    return (
                      <div key={message.id} className="flex flex-col gap-3">
                        {toolCalls.map((toolCall) => (
                          <ToolCallCard
                            key={toolCall.id}
                            toolCall={toolCall as ToolCallWithResult<AgentToolCalls>}
                          />
                        ))}
                      </div>
                    );
                  }

                  // Skip AI messages without content
                  if (!hasContent(message)) {
                    return null;
                  }
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Show interrupt UI when awaiting approval */}
              {interruptValue && interruptValue.length > 0 && (
                <div className="flex flex-col gap-4">
                  {interruptValue.map((humanInterrupt, idx) => (
                    <PendingApprovalCard
                      key={idx}
                      interrupt={humanInterrupt}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onEdit={handleEdit}
                      isProcessing={isProcessing}
                    />
                  ))}
                </div>
              )}

              {/* Show loading indicator when streaming and no content yet */}
              {stream.isLoading &&
                !interrupt &&
                !stream.uiMessages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                stream.toolCalls.length === 0 && <LoadingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading || isProcessing || !!interrupt}
        placeholder={
          interrupt
            ? "Please approve or reject the pending action..."
            : "Ask me to send an email or delete a file..."
        }
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "human-in-the-loop",
  title: "Human in the Loop",
  description:
    "ReAct agent with interrupts for approving, editing, or rejecting tool calls",
  category: "agents",
  icon: "chat",
  ready: true,
  component: HumanInTheLoop,
});

export default HumanInTheLoop;

